/**
 * The Cashfree integration.
 *
 * Two layers, matching where the risk lives. The client tests stub `fetch` and
 * assert the exact request we send Cashfree (endpoint, headers, rupee amount,
 * idempotency key) and how we read its answers back — a units bug here is a
 * 100x charge. The webhook tests run against a real Postgres and prove the two
 * properties the money depends on: a valid signature is required, and a
 * duplicate delivery cannot confirm a booking twice.
 *
 * The DB half skips (does not fail) without a database, like the other DB
 * suites, so the pure client and signature checks still run anywhere.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHmac } from 'node:crypto';
import type pg from 'pg';

import {
  HttpCashfreeClient,
  verifyCashfreeWebhookSignature,
  classifyWebhookType,
} from '../src/payments/cashfree.ts';
import type { PaymentsConfig } from '../src/payments/razorpay.ts';
import { createBooking } from '../src/booking/create.ts';
import { applyFailure } from '../src/payments/service.ts';
import { handleCashfreeWebhook, WebhookSignatureError } from '../src/payments/webhook.ts';
import { NOW, at } from './helpers.ts';
import { type Fixture, bookingStatus, connect, seed } from './db.ts';

// --------------------------------------------------------------- fetch stub

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Replace global fetch with a router keyed on "METHOD path-suffix". Returns the captured calls. */
function stubFetch(routes: Record<string, { status?: number; json: unknown }>): {
  calls: Captured[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, opts: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const method = opts?.method ?? 'GET';
    const key = Object.keys(routes).find((k) => {
      const [m, suffix] = k.split(' ');
      return m === method && String(url).includes(suffix!);
    });
    calls.push({
      url: String(url),
      method,
      headers: opts?.headers ?? {},
      body: opts?.body ? JSON.parse(opts.body) : undefined,
    });
    const route = key ? routes[key]! : { status: 404, json: { message: 'no route' } };
    const status = route.status ?? 200;
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(route.json),
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const client = () => new HttpCashfreeClient({ appId: 'APP_ID', secretKey: 'SECRET_KEY', env: 'sandbox' });

describe('Cashfree client — order creation', () => {
  it('sends the order to sandbox in rupees, with auth and idempotency, and reads back the session', async () => {
    const { calls, restore } = stubFetch({
      'POST /orders': { json: { order_id: 'bk_1', order_amount: 200, order_currency: 'INR', order_status: 'ACTIVE', payment_session_id: 'session_abc' } },
    });
    try {
      const order = await client().createOrder({
        amountPaise: 20000, // ₹200
        receipt: 'bk_1',
        notes: { booking_id: 'bk_1' },
        customer: { id: 'cust_1', name: 'A', email: 'a@x.test', phone: '+91 98765 43210' },
      });

      const call = calls[0]!;
      assert.equal(call.url, 'https://sandbox.cashfree.com/pg/orders');
      assert.equal(call.method, 'POST');
      assert.equal(call.headers['x-client-id'], 'APP_ID');
      assert.equal(call.headers['x-client-secret'], 'SECRET_KEY');
      assert.ok(call.headers['x-api-version'], 'pins an API version');
      assert.equal(call.headers['x-idempotency-key'], 'bk_1', 'the booking id is the idempotency key');

      const body = call.body as { order_amount: number; order_id: string; customer_details: { customer_phone: string; customer_id: string } };
      assert.equal(body.order_amount, 200, 'paise converted to rupees');
      assert.equal(body.order_id, 'bk_1');
      assert.equal(body.customer_details.customer_phone, '9876543210', 'phone normalised to 10 digits');

      // Read back: amount is paise again, and the browser gets the session token.
      assert.equal(order.amount, 20000);
      assert.equal(order.paymentSessionId, 'session_abc');
      assert.equal(order.id, 'bk_1');
    } finally {
      restore();
    }
  });

  it('falls back to a valid placeholder phone when the customer has none', async () => {
    const { calls, restore } = stubFetch({ 'POST /orders': { json: { order_id: 'bk_2', order_amount: 100, payment_session_id: 's' } } });
    try {
      await client().createOrder({ amountPaise: 10000, receipt: 'bk_2', customer: { id: 'c', phone: null } });
      const body = calls[0]!.body as { customer_details: { customer_phone: string } };
      assert.match(body.customer_details.customer_phone, /^[0-9]{10}$/);
    } finally {
      restore();
    }
  });
});

describe('Cashfree client — server-side verification', () => {
  it('reports a paid order with its settling payment', async () => {
    const { restore } = stubFetch({
      'GET /orders/bk_1/payments': { json: [{ cf_payment_id: 55501, payment_status: 'SUCCESS', payment_amount: 200, payment_group: 'upi' }] },
      'GET /orders/bk_1': { json: { order_id: 'bk_1', order_status: 'PAID', order_amount: 200 } },
    });
    try {
      const v = await client().verifyOrder('bk_1');
      assert.equal(v.outcome, 'paid');
      assert.equal(v.paymentId, '55501');
      assert.equal(v.amountPaise, 20000, 'rupees read back as paise');
    } finally {
      restore();
    }
  });

  it('reports a failed payment as failed', async () => {
    const { restore } = stubFetch({
      'GET /orders/bk_x/payments': { json: [{ cf_payment_id: 1, payment_status: 'FAILED' }] },
      'GET /orders/bk_x': { json: { order_id: 'bk_x', order_status: 'ACTIVE' } },
    });
    try {
      assert.equal((await client().verifyOrder('bk_x')).outcome, 'failed');
    } finally {
      restore();
    }
  });

  it('reports an in-flight payment as pending, never as paid', async () => {
    const { restore } = stubFetch({
      'GET /orders/bk_p/payments': { json: [{ cf_payment_id: 2, payment_status: 'PENDING' }] },
      'GET /orders/bk_p': { json: { order_id: 'bk_p', order_status: 'ACTIVE' } },
    });
    try {
      assert.equal((await client().verifyOrder('bk_p')).outcome, 'pending');
    } finally {
      restore();
    }
  });
});

describe('Cashfree webhook signature', () => {
  const secret = 'cf_webhook_secret';
  const raw = Buffer.from('{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{}}');
  const ts = '1725200000';
  const sign = (body: Buffer, timestamp: string, key: string) =>
    createHmac('sha256', key).update(timestamp).update(body).digest('base64');

  it('accepts a signature over timestamp + raw body', () => {
    assert.equal(verifyCashfreeWebhookSignature(raw, ts, sign(raw, ts, secret), secret), true);
  });

  it('rejects a tampered body, a wrong timestamp, a wrong secret, and missing headers', () => {
    const good = sign(raw, ts, secret);
    assert.equal(verifyCashfreeWebhookSignature(Buffer.from('{"x":1}'), ts, good, secret), false, 'tampered body');
    assert.equal(verifyCashfreeWebhookSignature(raw, '9999', good, secret), false, 'wrong timestamp');
    assert.equal(verifyCashfreeWebhookSignature(raw, ts, good, 'other_secret'), false, 'wrong secret');
    assert.equal(verifyCashfreeWebhookSignature(raw, undefined, good, secret), false, 'no timestamp');
    assert.equal(verifyCashfreeWebhookSignature(raw, ts, undefined, secret), false, 'no signature');
  });

  it('maps the event types this app acts on', () => {
    assert.equal(classifyWebhookType('PAYMENT_SUCCESS_WEBHOOK'), 'success');
    assert.equal(classifyWebhookType('PAYMENT_FAILED_WEBHOOK'), 'failed');
    assert.equal(classifyWebhookType('PAYMENT_USER_DROPPED_WEBHOOK'), 'dropped');
    assert.equal(classifyWebhookType('SOMETHING_ELSE'), 'other');
  });
});

// ----------------------------------------------------------- webhook, on a DB

const WEBHOOK_SECRET = 'cf_test_secret';

function cashfreeConfig(): PaymentsConfig {
  return {
    provider: 'cashfree',
    client: new HttpCashfreeClient({ appId: 'APP', secretKey: WEBHOOK_SECRET, env: 'sandbox' }),
    keyId: 'APP',
    keySecret: WEBHOOK_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    commissionBps: 1500,
    holdTtlMs: 8 * 60_000,
    enabled: true,
    cashfreeMode: 'sandbox',
  };
}

function signBody(raw: Buffer, ts: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(ts).update(raw).digest('base64');
}

/** A pending_payment booking with a Cashfree order row against it — what openCheckout leaves behind. */
async function heldBooking(db: pg.Pool, fx: Fixture, startAt: Date) {
  const booking = await createBooking(
    db,
    { salonId: fx.salonId, customerId: fx.customerIds[0]!, serviceIds: [fx.serviceIds['haircut']!], startAt },
    { now: NOW, holdTtlMs: 8 * 60_000 },
  );
  const orderId = booking.id; // openCheckout uses the booking id as the order id
  await db.query(
    `INSERT INTO payments (booking_id, salon_id, customer_id, rzp_order_id, amount, currency)
     VALUES ($1, $2, $3, $4, $5, 'INR')`,
    [booking.id, fx.salonId, fx.customerIds[0]!, orderId, booking.amount],
  );
  await db.query(`UPDATE bookings SET rzp_order_id = $2 WHERE id = $1`, [booking.id, orderId]);
  return { booking, orderId };
}

function successBody(orderId: string, amountPaise: number): Buffer {
  return Buffer.from(JSON.stringify({
    type: 'PAYMENT_SUCCESS_WEBHOOK',
    event_time: '2026-09-02T00:00:00Z',
    data: {
      order: { order_id: orderId, order_amount: amountPaise / 100 },
      payment: { cf_payment_id: 900001, payment_status: 'SUCCESS', payment_amount: amountPaise / 100, payment_group: 'upi' },
    },
  }));
}

describe('Cashfree webhook, against Postgres', () => {
  let pool: pg.Pool | null = null;
  before(async () => { pool = await connect(); });
  after(async () => { await pool?.end(); });

  it('rejects an invalid signature before touching the booking', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1, customers: 1 });
    const { booking, orderId } = await heldBooking(db, fx, at('11:00'));
    const raw = successBody(orderId, booking.amount);

    await assert.rejects(
      () => handleCashfreeWebhook(db, cashfreeConfig(), raw, { signature: 'not-a-real-signature', timestamp: '1725200000' }),
      WebhookSignatureError,
    );
    assert.equal(await bookingStatus(db, booking.id), 'pending_payment', 'unsigned request changed nothing');
  });

  it('confirms the booking on a signed success, and a duplicate delivery does nothing twice', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1, customers: 1 });
    const { booking, orderId } = await heldBooking(db, fx, at('11:00'));
    const raw = successBody(orderId, booking.amount);
    const ts = '1725200100';
    const sig = signBody(raw, ts);

    const first = await handleCashfreeWebhook(db, cashfreeConfig(), raw, { signature: sig, timestamp: ts }, { now: NOW });
    assert.equal(first.outcome, 'processed');
    assert.equal(await bookingStatus(db, booking.id), 'booked');

    const second = await handleCashfreeWebhook(db, cashfreeConfig(), raw, { signature: sig, timestamp: ts }, { now: NOW });
    assert.equal(second.outcome, 'duplicate', 'the same delivery is recognised, not re-applied');
    assert.equal(await bookingStatus(db, booking.id), 'booked');

    const paymentCount = await db.query<{ n: string }>(
      `SELECT count(*)::int8 AS n FROM payments WHERE rzp_order_id = $1 AND status = 'captured'`,
      [orderId],
    );
    assert.equal(Number(paymentCount.rows[0]!.n), 1, 'exactly one captured payment, never two');
  });

  it('marks the payment failed on a failed/dropped webhook and leaves the hold to expire', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1, customers: 1 });
    const { booking, orderId } = await heldBooking(db, fx, at('11:00'));
    const raw = Buffer.from(JSON.stringify({
      type: 'PAYMENT_FAILED_WEBHOOK',
      data: { order: { order_id: orderId }, payment: { cf_payment_id: 5, payment_status: 'FAILED' } },
    }));
    const ts = '1725200200';

    const result = await handleCashfreeWebhook(db, cashfreeConfig(), raw, { signature: signBody(raw, ts), timestamp: ts }, { now: NOW });
    assert.equal(result.outcome, 'processed');

    const payment = await db.query<{ status: string }>(`SELECT status FROM payments WHERE rzp_order_id = $1`, [orderId]);
    assert.equal(payment.rows[0]!.status, 'failed');
    // The booking is deliberately not cancelled — the hold expires on its own,
    // and a retry inside the hold should not have to start over.
    assert.equal(await bookingStatus(db, booking.id), 'pending_payment');
    // applyFailure is imported to keep this file's intent explicit even though
    // the webhook calls it internally.
    void applyFailure;
  });
});
