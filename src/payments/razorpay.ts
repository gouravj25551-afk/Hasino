/**
 * Razorpay, over `fetch`. No SDK.
 *
 * The official `razorpay` package is a thin wrapper over the same REST calls
 * plus a dependency tree; this repo has two runtime dependencies and no build
 * step, and the surface we need is five endpoints. The interface below is what
 * the rest of the app talks to, so swapping in the SDK later is one file.
 *
 * Money is paise everywhere — in this codebase, and in Razorpay's API for INR.
 * There is no conversion anywhere in this file, deliberately: a units bug in a
 * payment integration is a 100x charge.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.razorpay.com/v1';

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: 'created' | 'attempted' | 'paid';
  receipt: string | null;
  notes: Record<string, string>;
}

export interface RazorpayPayment {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  /** Razorpay's own vocabulary, not ours — mapped in payments/service.ts */
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  method: string | null;
  amount_refunded: number;
  error_code: string | null;
  error_description: string | null;
  notes: Record<string, string>;
}

export interface RazorpayRefund {
  id: string;
  payment_id: string;
  amount: number;
  status: 'pending' | 'processed' | 'failed';
  speed_processed: string | null;
  notes: Record<string, string>;
}

export interface CreateOrderInput {
  amountPaise: number;
  /** Our booking id. Razorpay enforces uniqueness on this per account. */
  receipt: string;
  notes?: Record<string, string>;
  currency?: string;
}

export interface CreateRefundInput {
  paymentId: string;
  amountPaise: number;
  /** Our refunds.id. Written into notes and used to detect a duplicate. */
  refundId: string;
  reason: string;
}

export interface RazorpayClient {
  readonly kind: string;
  createOrder(input: CreateOrderInput): Promise<RazorpayOrder>;
  fetchOrder(orderId: string): Promise<RazorpayOrder>;
  fetchPayment(paymentId: string): Promise<RazorpayPayment>;
  createRefund(input: CreateRefundInput): Promise<RazorpayRefund>;
}

export class RazorpayError extends Error {
  readonly status: number;
  readonly code: string;
  /** A 5xx or a network fault — the same call may succeed if repeated. */
  readonly retryable: boolean;
  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'RazorpayError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------- signatures

/**
 * Constant-time compare of two hex digests.
 *
 * `a === b` on a signature leaks, through timing, how many leading bytes were
 * correct — enough to forge one byte at a time given enough requests. This is
 * the standard mitigation and it costs nothing.
 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Checkout handler signature: HMAC-SHA256 of "<order_id>|<payment_id>" keyed
 * with the API *secret*.
 *
 * This is what proves the browser's success callback came from Razorpay and
 * not from a customer with devtools open. It is the only thing standing
 * between "I typed a payment id into the console" and a confirmed booking.
 */
export function verifyCheckoutSignature(
  params: { orderId: string; paymentId: string; signature: string },
  keySecret: string,
): boolean {
  if (!params.orderId || !params.paymentId || !params.signature) return false;
  const expected = createHmac('sha256', keySecret)
    .update(`${params.orderId}|${params.paymentId}`)
    .digest('hex');
  return safeEqualHex(expected, params.signature);
}

/**
 * Webhook signature: HMAC-SHA256 of the raw request body keyed with the
 * *webhook* secret — a different secret from the API key.
 *
 * The body must be the exact bytes received. Re-serialising the parsed JSON
 * changes key order and whitespace and the digest stops matching; that is why
 * the webhook route reads a Buffer and never touches JSON.parse before this.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signature: string | undefined,
  webhookSecret: string,
): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

// ------------------------------------------------------------------- client

interface HttpOptions {
  keyId: string;
  keySecret: string;
  baseUrl?: string;
  /** total attempts for a retryable failure, including the first */
  attempts?: number;
  timeoutMs?: number;
}

export class HttpRazorpayClient implements RazorpayClient {
  readonly kind = 'razorpay';
  readonly #auth: string;
  readonly #baseUrl: string;
  readonly #attempts: number;
  readonly #timeoutMs: number;

  constructor(opts: HttpOptions) {
    this.#auth = 'Basic ' + Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString('base64');
    this.#baseUrl = opts.baseUrl ?? API;
    this.#attempts = opts.attempts ?? 3;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: RazorpayError | null = null;

    for (let attempt = 1; attempt <= this.#attempts; attempt++) {
      try {
        const res = await fetch(this.#baseUrl + path, {
          method,
          headers: {
            authorization: this.#auth,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });

        const text = await res.text();
        const parsed: unknown = text ? safeJson(text) : {};

        if (res.ok) return parsed as T;

        const err = (parsed as { error?: { code?: string; description?: string } }).error;
        // 429 is rate limiting, 5xx is theirs. 4xx otherwise is ours and
        // repeating it just burns the customer's patience.
        const retryable = res.status === 429 || res.status >= 500;
        lastError = new RazorpayError(
          res.status,
          err?.code ?? `HTTP_${res.status}`,
          err?.description ?? `Razorpay ${method} ${path} failed with ${res.status}`,
          retryable,
        );
        if (!retryable) throw lastError;
      } catch (e) {
        if (e instanceof RazorpayError) {
          if (!e.retryable) throw e;
          lastError = e;
        } else {
          // DNS, TLS, socket reset, AbortSignal.timeout — all repeatable.
          lastError = new RazorpayError(0, 'NETWORK', (e as Error).message, true);
        }
      }

      if (attempt < this.#attempts) {
        // 250ms, 500ms, 1s ... with jitter, so a Razorpay blip does not turn
        // into every one of our instances retrying in lockstep.
        const backoff = 250 * 2 ** (attempt - 1);
        await sleep(backoff + Math.random() * backoff);
      }
    }

    throw lastError ?? new RazorpayError(0, 'UNKNOWN', 'Razorpay request failed', true);
  }

  async createOrder(input: CreateOrderInput): Promise<RazorpayOrder> {
    return this.#request<RazorpayOrder>('POST', '/orders', {
      amount: input.amountPaise,
      currency: input.currency ?? 'INR',
      receipt: input.receipt,
      // Auto-capture. Without it a payment sits 'authorized' and is voided by
      // the bank after ~5 days — the customer sees a debit, the salon sees no
      // money, and nobody has an error to look at.
      payment_capture: 1,
      notes: input.notes ?? {},
    });
  }

  async fetchOrder(orderId: string): Promise<RazorpayOrder> {
    return this.#request<RazorpayOrder>('GET', `/orders/${encodeURIComponent(orderId)}`);
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    return this.#request<RazorpayPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`);
  }

  /**
   * Idempotent refund.
   *
   * Razorpay has no idempotency key on this endpoint, and the refund worker
   * retries — so a timed-out request that actually succeeded would refund the
   * customer twice on the next attempt. The existing refunds for the payment
   * are listed first and matched on our own id in `notes`. Costs one GET on the
   * retry path only.
   */
  async createRefund(input: CreateRefundInput): Promise<RazorpayRefund> {
    const existing = await this.#request<{ items: RazorpayRefund[] }>(
      'GET',
      `/payments/${encodeURIComponent(input.paymentId)}/refunds`,
    );
    const already = existing.items?.find((r) => r.notes?.['hasino_refund_id'] === input.refundId);
    if (already) return already;

    return this.#request<RazorpayRefund>(
      'POST',
      `/payments/${encodeURIComponent(input.paymentId)}/refund`,
      {
        amount: input.amountPaise,
        speed: 'normal',
        notes: { hasino_refund_id: input.refundId, reason: input.reason },
      },
    );
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'BAD_JSON', description: text.slice(0, 200) } };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --------------------------------------------------------------------- stub

/**
 * In-memory Razorpay for tests and for `DEV_AUTH=true` without Razorpay keys.
 *
 * It generates ids in Razorpay's shape and signs with the same HMAC, so the
 * whole confirm path — including signature verification — is exercised locally.
 * The one thing it cannot test is Razorpay's own behaviour.
 */
export class StubRazorpayClient implements RazorpayClient {
  readonly kind = 'stub';
  readonly keySecret: string;
  readonly orders = new Map<string, RazorpayOrder>();
  readonly payments = new Map<string, RazorpayPayment>();
  readonly refunds = new Map<string, RazorpayRefund>();
  #n = 0;

  constructor(keySecret = 'stub_secret') {
    this.keySecret = keySecret;
  }

  #id(prefix: string): string {
    this.#n += 1;
    return `${prefix}_${String(this.#n).padStart(14, '0')}`;
  }

  async createOrder(input: CreateOrderInput): Promise<RazorpayOrder> {
    // Razorpay rejects a duplicate receipt; mirroring that here means the
    // "retry created a second order" bug shows up in tests, not production.
    for (const o of this.orders.values()) {
      if (o.receipt === input.receipt) return o;
    }
    const order: RazorpayOrder = {
      id: this.#id('order'),
      amount: input.amountPaise,
      currency: input.currency ?? 'INR',
      status: 'created',
      receipt: input.receipt,
      notes: input.notes ?? {},
    };
    this.orders.set(order.id, order);
    return order;
  }

  async fetchOrder(orderId: string): Promise<RazorpayOrder> {
    const o = this.orders.get(orderId);
    if (!o) throw new RazorpayError(400, 'BAD_REQUEST_ERROR', 'no such order', false);
    return o;
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    const p = this.payments.get(paymentId);
    if (!p) throw new RazorpayError(400, 'BAD_REQUEST_ERROR', 'no such payment', false);
    return p;
  }

  async createRefund(input: CreateRefundInput): Promise<RazorpayRefund> {
    for (const r of this.refunds.values()) {
      if (r.notes['hasino_refund_id'] === input.refundId) return r;
    }
    const payment = await this.fetchPayment(input.paymentId);
    const refund: RazorpayRefund = {
      id: this.#id('rfnd'),
      payment_id: input.paymentId,
      amount: input.amountPaise,
      status: 'processed',
      speed_processed: 'normal',
      notes: { hasino_refund_id: input.refundId, reason: input.reason },
    };
    payment.amount_refunded += input.amountPaise;
    payment.status = payment.amount_refunded >= payment.amount ? 'refunded' : 'captured';
    this.refunds.set(refund.id, refund);
    return refund;
  }

  // ---- test helpers: what the customer's browser would do ----

  /** Simulate a successful checkout, returning what the handler posts back. */
  pay(orderId: string, method = 'upi'): { orderId: string; paymentId: string; signature: string } {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`no such order: ${orderId}`);
    const payment: RazorpayPayment = {
      id: this.#id('pay'),
      order_id: orderId,
      amount: order.amount,
      currency: order.currency,
      status: 'captured',
      method,
      amount_refunded: 0,
      error_code: null,
      error_description: null,
      notes: order.notes,
    };
    this.payments.set(payment.id, payment);
    order.status = 'paid';
    return {
      orderId,
      paymentId: payment.id,
      signature: createHmac('sha256', this.keySecret)
        .update(`${orderId}|${payment.id}`)
        .digest('hex'),
    };
  }

  fail(orderId: string, code = 'BAD_REQUEST_ERROR'): RazorpayPayment {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`no such order: ${orderId}`);
    const payment: RazorpayPayment = {
      id: this.#id('pay'),
      order_id: orderId,
      amount: order.amount,
      currency: order.currency,
      status: 'failed',
      method: 'card',
      amount_refunded: 0,
      error_code: code,
      error_description: 'Payment failed in the stub',
      notes: order.notes,
    };
    this.payments.set(payment.id, payment);
    return payment;
  }
}

// ------------------------------------------------------------------- config

export interface PaymentsConfig {
  client: RazorpayClient;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  /** platform cut when a salon has no override, in basis points */
  commissionBps: number;
  /** how long a pending_payment booking holds its chair */
  holdTtlMs: number;
  enabled: boolean;
}

export const DEFAULT_HOLD_TTL_MS = 8 * 60_000;

/**
 * Razorpay checkout gives the customer ~5 minutes of bank/UPI redirect before
 * it times out on its own. 8 minutes covers that plus the webhook, and is short
 * enough that a chair abandoned mid-payment is back on sale before the next
 * customer gives up. Tunable, because the right number is whatever the drop-off
 * data says once there is any.
 */
export function paymentsConfigFromEnv(devAuth: boolean): PaymentsConfig {
  const keyId = process.env['RAZORPAY_KEY_ID'] ?? '';
  const keySecret = process.env['RAZORPAY_KEY_SECRET'] ?? '';
  const webhookSecret = process.env['RAZORPAY_WEBHOOK_SECRET'] ?? '';
  const commissionBps = Number(process.env['PLATFORM_COMMISSION_BPS'] ?? 1500);
  const holdTtlMs = Number(process.env['PAYMENT_HOLD_TTL_MS'] ?? DEFAULT_HOLD_TTL_MS);

  if (keyId && keySecret) {
    return {
      client: new HttpRazorpayClient({ keyId, keySecret }),
      keyId,
      keySecret,
      webhookSecret,
      commissionBps,
      holdTtlMs,
      enabled: true,
    };
  }

  // No keys. In dev this is the stub so the whole flow still runs; in
  // production start() refuses to boot rather than quietly taking free
  // bookings — see src/http/server.ts.
  const stub = new StubRazorpayClient('stub_secret');
  return {
    client: stub,
    keyId: 'rzp_test_stub',
    keySecret: stub.keySecret,
    webhookSecret: 'stub_webhook_secret',
    commissionBps,
    holdTtlMs,
    enabled: devAuth,
  };
}
