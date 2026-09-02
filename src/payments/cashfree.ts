/**
 * Cashfree Payment Gateway, over `fetch`. No SDK.
 *
 * Same shape as razorpay.ts and the same reason: the official package is a
 * wrapper over these REST calls, and this repo has no build step. This client
 * implements the RazorpayClient interface so the rest of the app is unchanged;
 * the two places Cashfree genuinely differs from Razorpay — server-side
 * verification (no browser-signed callback) and the webhook signature — are
 * exposed as extra methods/functions and branched on `cfg.provider`.
 *
 * Units: this codebase is paise everywhere. Cashfree's API is RUPEES (two
 * decimals). The ONLY conversions in the app live at this HTTP boundary —
 * paise/100 on the way out, round(rupees*100) on the way back — and nowhere
 * else, because a units bug in a payment integration is a 100x charge.
 *
 * API version is pinned via header and configurable, so a version bump is an
 * env change rather than a code change. Verified against Cashfree's current
 * docs (create order, order status, refunds, and the webhook signature).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CreateOrderInput,
  CreateRefundInput,
  RazorpayClient,
  RazorpayOrder,
  RazorpayPayment,
  RazorpayRefund,
} from './razorpay.ts';
import { RazorpayError } from './razorpay.ts';

/** The API version header. A stable, widely-supported version; override with CASHFREE_API_VERSION. */
export const DEFAULT_API_VERSION = '2023-08-01';

export type CashfreeEnv = 'sandbox' | 'production';

function baseUrl(env: CashfreeEnv): string {
  return env === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
}

const paiseToRupees = (paise: number): number => Math.round(paise) / 100;
const rupeesToPaise = (rupees: number): number => Math.round(Number(rupees) * 100);

/** Cashfree order_status -> the RazorpayOrder vocabulary the app already speaks. */
function mapOrderStatus(s: string): RazorpayOrder['status'] {
  if (s === 'PAID') return 'paid';
  if (s === 'ACTIVE') return 'created';
  return 'attempted'; // EXPIRED, TERMINATED, TERMINATION_REQUESTED
}

/** Cashfree payment_status -> the RazorpayPayment vocabulary. */
function mapPaymentStatus(s: string): RazorpayPayment['status'] {
  if (s === 'SUCCESS') return 'captured';
  if (s === 'PENDING') return 'authorized'; // in flight, not settled
  return 'failed'; // FAILED, USER_DROPPED, CANCELLED, VOID
}

/** What confirm needs to know about an order, verified server-side. */
export interface CashfreeVerification {
  /** paid = money captured; pending = in flight; failed = dropped/declined; unknown = still ACTIVE, nothing tried. */
  outcome: 'paid' | 'pending' | 'failed' | 'unknown';
  paymentId: string | null;
  amountPaise: number | undefined;
  method: string | null;
}

interface CashfreeOrderResponse {
  cf_order_id?: number | string;
  order_id?: string;
  order_amount?: number;
  order_currency?: string;
  order_status?: string;
  payment_session_id?: string;
}

interface CashfreePaymentEntity {
  cf_payment_id?: number | string;
  payment_status?: string;
  payment_amount?: number;
  payment_currency?: string;
  payment_method?: unknown;
  payment_group?: string;
}

interface CashfreeRefundResponse {
  cf_refund_id?: number | string;
  refund_id?: string;
  refund_amount?: number;
  refund_status?: string;
}

export interface CashfreeConfig {
  appId: string;
  secretKey: string;
  env: CashfreeEnv;
  apiVersion?: string;
  /** Absolute https URL Cashfree POSTs webhooks to, if the public origin is known. */
  notifyUrl?: string;
}

export class HttpCashfreeClient implements RazorpayClient {
  readonly kind = 'cashfree';
  private readonly base: string;
  private readonly appId: string;
  private readonly secretKey: string;
  private readonly apiVersion: string;
  private readonly notifyUrl: string | undefined;

  constructor(cfg: CashfreeConfig) {
    this.base = baseUrl(cfg.env);
    this.appId = cfg.appId;
    this.secretKey = cfg.secretKey;
    this.apiVersion = cfg.apiVersion || DEFAULT_API_VERSION;
    this.notifyUrl = cfg.notifyUrl;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'x-client-id': this.appId,
      'x-client-secret': this.secretKey,
      'x-api-version': this.apiVersion,
      'content-type': 'application/json',
      ...extra,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: this.headers(extraHeaders),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      // Network fault — the same call may succeed if repeated.
      throw new RazorpayError(0, 'NETWORK', (err as Error).message || 'network error', true);
    }
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      const e = (json ?? {}) as { code?: string; message?: string; type?: string };
      const code = e.code ?? e.type ?? `HTTP_${res.status}`;
      // 5xx and 429 are worth a retry; a 4xx is a rejection that will not change.
      const retryable = res.status >= 500 || res.status === 429;
      throw new RazorpayError(res.status, String(code), e.message ?? `Cashfree ${res.status}`, retryable);
    }
    return json as T;
  }

  async createOrder(input: CreateOrderInput): Promise<RazorpayOrder> {
    const customer = input.customer;
    const body: Record<string, unknown> = {
      order_id: input.receipt,
      order_amount: paiseToRupees(input.amountPaise),
      order_currency: input.currency ?? 'INR',
      customer_details: {
        // Cashfree requires a customer id and a 10-digit phone. A Google
        // sign-in supplies no phone, so a placeholder keeps order creation
        // working; the real number is used whenever we have it.
        customer_id: customer?.id ?? input.notes?.['customer_id'] ?? input.receipt,
        customer_phone: normalisePhone(customer?.phone),
        ...(customer?.name ? { customer_name: customer.name } : {}),
        ...(customer?.email ? { customer_email: customer.email } : {}),
      },
      ...(input.notes ? { order_tags: input.notes } : {}),
      ...(input.expiryIso || this.notifyUrl
        ? {
            order_meta: {
              ...(this.notifyUrl ? { notify_url: this.notifyUrl } : {}),
            },
          }
        : {}),
      ...(input.expiryIso ? { order_expiry_time: input.expiryIso } : {}),
    };

    // The booking id is the order id and is unique, so it doubles as the
    // idempotency key: a retried create returns the same order rather than a
    // second one.
    const order = await this.request<CashfreeOrderResponse>('POST', '/orders', body, {
      'x-idempotency-key': input.receipt,
    });

    return this.toOrder(order, input.amountPaise, input.currency ?? 'INR', input.receipt);
  }

  async fetchOrder(orderId: string): Promise<RazorpayOrder> {
    const order = await this.request<CashfreeOrderResponse>('GET', `/orders/${encodeURIComponent(orderId)}`);
    return this.toOrder(order, undefined, order.order_currency ?? 'INR', orderId);
  }

  /**
   * Not reachable on the Cashfree path — confirm uses verifyOrder() instead,
   * because Cashfree's get-payment is keyed by order id, not by a bare payment
   * id. Implemented to satisfy the shared interface, and it fails loudly rather
   * than silently guessing if something ever routes here.
   */
  async fetchPayment(_paymentId: string): Promise<RazorpayPayment> {
    throw new RazorpayError(0, 'UNSUPPORTED', 'Cashfree verifies by order, not by payment id', false);
  }

  /**
   * Verify an order server-side and pick out the paying transaction. This is
   * the Cashfree replacement for Razorpay's browser-signed callback: the client
   * is never trusted — we ask Cashfree what the order and its payments actually
   * are.
   */
  async verifyOrder(orderId: string): Promise<CashfreeVerification> {
    const order = await this.request<CashfreeOrderResponse>('GET', `/orders/${encodeURIComponent(orderId)}`);
    const payments = await this.request<CashfreePaymentEntity[]>(
      'GET',
      `/orders/${encodeURIComponent(orderId)}/payments`,
    ).catch((err: unknown) => {
      // No payments yet is a 404 on some setups; treat as "nothing tried".
      if (err instanceof RazorpayError && err.status === 404) return [] as CashfreePaymentEntity[];
      throw err;
    });

    const list = Array.isArray(payments) ? payments : [];
    const success = list.find((p) => p.payment_status === 'SUCCESS');
    const pending = list.find((p) => p.payment_status === 'PENDING');
    const failed = list.find((p) => p.payment_status === 'FAILED' || p.payment_status === 'USER_DROPPED');

    if (order.order_status === 'PAID' || success) {
      const p = success ?? list[0];
      return {
        outcome: 'paid',
        paymentId: p?.cf_payment_id != null ? String(p.cf_payment_id) : null,
        amountPaise: p?.payment_amount != null ? rupeesToPaise(p.payment_amount)
          : order.order_amount != null ? rupeesToPaise(order.order_amount) : undefined,
        method: methodLabel(p?.payment_group),
      };
    }
    if (pending) {
      return { outcome: 'pending', paymentId: pending.cf_payment_id != null ? String(pending.cf_payment_id) : null, amountPaise: undefined, method: null };
    }
    if (failed) {
      return { outcome: 'failed', paymentId: failed.cf_payment_id != null ? String(failed.cf_payment_id) : null, amountPaise: undefined, method: null };
    }
    // ACTIVE order, nothing attempted (or nothing settled yet).
    return { outcome: order.order_status === 'ACTIVE' ? 'unknown' : 'failed', paymentId: null, amountPaise: undefined, method: null };
  }

  async createRefund(input: CreateRefundInput): Promise<RazorpayRefund> {
    // Cashfree refunds are issued against the ORDER, so the caller threads the
    // order id through (paymentId stays for the Razorpay path).
    const orderId = input.orderId;
    if (!orderId) throw new RazorpayError(0, 'NO_ORDER', 'Cashfree refund needs an order id', false);
    const r = await this.request<CashfreeRefundResponse>('POST', `/orders/${encodeURIComponent(orderId)}/refunds`, {
      refund_id: input.refundId,
      refund_amount: paiseToRupees(input.amountPaise),
      refund_note: input.reason.slice(0, 200),
    });
    return {
      id: r.cf_refund_id != null ? String(r.cf_refund_id) : (r.refund_id ?? input.refundId),
      payment_id: input.paymentId,
      amount: r.refund_amount != null ? rupeesToPaise(r.refund_amount) : input.amountPaise,
      status: mapRefundStatus(r.refund_status),
      speed_processed: null,
      notes: {},
    };
  }

  private toOrder(order: CashfreeOrderResponse, fallbackPaise: number | undefined, currency: string, orderId: string): RazorpayOrder {
    return {
      id: order.order_id ?? orderId,
      amount: order.order_amount != null ? rupeesToPaise(order.order_amount) : (fallbackPaise ?? 0),
      currency: order.order_currency ?? currency,
      status: mapOrderStatus(order.order_status ?? 'ACTIVE'),
      receipt: order.order_id ?? orderId,
      notes: {},
      ...(order.payment_session_id ? { paymentSessionId: order.payment_session_id } : {}),
    };
  }
}

function mapRefundStatus(s: string | undefined): RazorpayRefund['status'] {
  if (s === 'SUCCESS') return 'processed';
  if (s === 'FAILED' || s === 'CANCELLED') return 'failed';
  return 'pending'; // PENDING, ONHOLD
}

function methodLabel(group: string | undefined): string | null {
  return group ?? null;
}

/** Cashfree needs a 10-digit phone; use the real one when it looks valid, else a benign placeholder. */
function normalisePhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  const last10 = digits.slice(-10);
  return /^[0-9]{10}$/.test(last10) ? last10 : '9999999999';
}

/**
 * Verify a Cashfree webhook.
 *
 * base64(HMAC-SHA256(timestamp + rawBody, secretKey)) must equal the
 * x-webhook-signature header. The timestamp is x-webhook-timestamp. Both the
 * timestamp and the RAW, unparsed body go into the HMAC — parsing and
 * re-serialising the JSON changes bytes and the signature stops matching.
 *
 * Constant-time comparison, and it returns false (never throws) on anything
 * malformed, so an attacker learns nothing from the timing or the error.
 */
export function verifyCashfreeWebhookSignature(
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  secretKey: string,
): boolean {
  if (!timestamp || !signature || !secretKey) return false;
  const expected = createHmac('sha256', secretKey)
    .update(timestamp)
    .update(rawBody)
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** The webhook event vocabulary this app acts on. */
export type CashfreeWebhookKind = 'success' | 'failed' | 'dropped' | 'other';

export function classifyWebhookType(type: string | undefined): CashfreeWebhookKind {
  switch (type) {
    case 'PAYMENT_SUCCESS_WEBHOOK':
      return 'success';
    case 'PAYMENT_FAILED_WEBHOOK':
      return 'failed';
    case 'PAYMENT_USER_DROPPED_WEBHOOK':
      return 'dropped';
    default:
      return 'other';
  }
}
