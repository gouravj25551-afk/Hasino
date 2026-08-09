/**
 * The payment hold, end to end, against a real Postgres.
 *
 * The thing being tested is the race the README flagged and this migration
 * fixed: under `pay -> then create`, two customers on the last chair both pay
 * and one is refunded. Under `hold -> pay -> confirm`, the second one is
 * rejected before any money moves. The tests that matter here are the ones
 * where something goes wrong — an abandoned checkout, a payment that lands
 * after the hold lapsed, a webhook delivered twice.
 *
 * Skips (does not fail) without a database, so the pure suites still run
 * anywhere.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';

import { createBooking } from '../src/booking/create.ts';
import { SlotUnavailableError } from '../src/booking/errors.ts';
import { sweepExpiredHolds } from '../src/booking/sweep.ts';
import { closeForDay, transition } from '../src/booking/status.ts';
import { getAvailability } from '../src/availability/service.ts';
import { loadCart } from '../src/availability/repo.ts';
import {
  StubRazorpayClient,
  type PaymentsConfig,
  verifyWebhookSignature,
} from '../src/payments/razorpay.ts';
import { applyCapture, confirmCheckout, openCheckout, processDueRefunds } from '../src/payments/service.ts';
import { handleWebhook } from '../src/payments/webhook.ts';
import { salonBalance, createPayoutForPeriod } from '../src/payments/ledger.ts';
import { dispatchDue, ConsoleChannel } from '../src/notify/dispatch.ts';
import { NOW, at, times } from './helpers.ts';
import { type Fixture, bookingStatus, chairsHeld, connect, seed } from './db.ts';
import { createHmac } from 'node:crypto';

let pool: pg.Pool | null = null;

before(async () => {
  pool = await connect();
});

after(async () => {
  await pool?.end();
});

const WEBHOOK_SECRET = 'whsec_flow_test';
const HOLD_MS = 8 * 60_000;

function config(client = new StubRazorpayClient()): PaymentsConfig & { client: StubRazorpayClient } {
  return {
    client,
    keyId: 'rzp_test_flow',
    keySecret: client.keySecret,
    webhookSecret: WEBHOOK_SECRET,
    commissionBps: 1500,
    holdTtlMs: HOLD_MS,
    enabled: true,
  };
}

/** Take a chair and open an order, the way POST /api/bookings does. */
async function hold(db: pg.Pool, cfg: PaymentsConfig, fx: Fixture, startAt: Date, customerIndex = 0, now = NOW) {
  const booking = await createBooking(
    db,
    {
      salonId: fx.salonId,
      customerId: fx.customerIds[customerIndex]!,
      serviceIds: [fx.serviceIds['haircut']!],
      startAt,
    },
    { now, holdTtlMs: cfg.holdTtlMs },
  );
  const checkout = await openCheckout(db, cfg, booking.id, fx.customerIds[customerIndex]!);
  return { booking, checkout };
}

describe('the payment hold', () => {
  it('consumes a chair the moment it is taken, before any money moves', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1, customers: 2 });
    const startAt = at('11:00');

    const { booking } = await hold(db, cfg, fx, startAt);

    assert.equal(booking.status, 'pending_payment');
    assert.ok(booking.holdExpiresAt, 'a hold without a deadline never releases the chair');
    assert.equal(await chairsHeld(db, fx.salonId, startAt, NOW), 1);
  });

  it('rejects the second customer on the last chair BEFORE they pay', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1, customers: 2 });
    const startAt = at('11:00');

    await hold(db, cfg, fx, startAt, 0);

    // This is the whole point of the migration. Under the spec's ordering both
    // customers reach Razorpay and one is refunded after being charged.
    await assert.rejects(() => hold(db, cfg, fx, startAt, 1), SlotUnavailableError);
  });

  it('hides the held slot from availability', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1, customers: 2 });
    await hold(db, cfg, fx, at('11:00'));

    const cart = await loadCart(db, fx.salonId, [fx.serviceIds['haircut']!]);
    const avail = (await getAvailability(db, fx.salonId, cart, { now: NOW }))!;
    const today = avail.days[0]!;

    assert.ok(!times(today.full).includes('11:00'), 'a held chair must not be offered to anyone else');
    assert.ok(times(today.full).includes('10:00'), 'other slots are unaffected');
  });

  it('releases the chair when the hold expires, without the sweeper running', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1, customers: 2 });
    const startAt = at('11:00');
    await hold(db, cfg, fx, startAt);

    // Correctness lives in the occupancy predicate, not in a background job. A
    // sweeper that dies must never cost a salon a sellable chair.
    const later = new Date(NOW.getTime() + HOLD_MS + 1000);
    assert.equal(await chairsHeld(db, fx.salonId, startAt, later), 0);

    const second = await hold(db, cfg, fx, startAt, 1, later);
    assert.equal(second.booking.status, 'pending_payment');
  });

  it('the sweeper turns a lapsed hold terminal', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1 });
    const { booking } = await hold(db, cfg, fx, at('11:00'));

    const before = await sweepExpiredHolds(db, { now: NOW });
    assert.equal(before.expired, 0, 'a live hold must survive a sweep');

    const result = await sweepExpiredHolds(db, { now: new Date(NOW.getTime() + HOLD_MS + 1000) });
    assert.equal(result.expired, 1);
    assert.equal(await bookingStatus(db, booking.id), 'expired');
  });
});

describe('confirming a payment', () => {
  it('turns the hold into a booking and writes the ledger', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1, services: [{ name: 'haircut', durationMin: 20, price: 100_000 }] });
    const { booking, checkout } = await hold(db, cfg, fx, at('11:00'));

    const signed = cfg.client.pay(checkout.orderId);
    const result = await confirmCheckout(
      db,
      cfg,
      {
        bookingId: booking.id,
        customerId: fx.customerIds[0]!,
        orderId: signed.orderId,
        paymentId: signed.paymentId,
        signature: signed.signature,
      },
      { now: NOW },
    );

    assert.equal(result.outcome, 'confirmed');
    assert.equal(await bookingStatus(db, booking.id), 'booked');

    const balance = await salonBalance(db, fx.salonId);
    assert.equal(balance.gross, 100_000);
    assert.equal(balance.commission, 15_000, '15% of ₹1000');
    assert.equal(balance.available, 85_000, 'the salon is owed gross minus commission');
  });

  it('refuses a forged signature and leaves the booking unpaid', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1 });
    const { booking, checkout } = await hold(db, cfg, fx, at('11:00'));

    await assert.rejects(
      () =>
        confirmCheckout(
          db,
          cfg,
          {
            bookingId: booking.id,
            customerId: fx.customerIds[0]!,
            orderId: checkout.orderId,
            paymentId: 'pay_i_made_this_up',
            signature: 'de'.repeat(32),
          },
          { now: NOW },
        ),
      (err: Error) => err.name === 'BadSignatureError',
    );

    assert.equal(await bookingStatus(db, booking.id), 'pending_payment', 'still unpaid');
    assert.equal((await salonBalance(db, fx.salonId)).gross, 0, 'nobody was credited');
  });

  it('is idempotent when the callback and the webhook both land', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1, services: [{ name: 'haircut', durationMin: 20, price: 100_000 }] });
    const { booking, checkout } = await hold(db, cfg, fx, at('11:00'));
    const signed = cfg.client.pay(checkout.orderId);

    const first = await applyCapture(db, cfg, { orderId: signed.orderId, paymentId: signed.paymentId }, { now: NOW });
    const second = await applyCapture(db, cfg, { orderId: signed.orderId, paymentId: signed.paymentId }, { now: NOW });

    assert.equal(first.outcome, 'confirmed');
    assert.equal(second.outcome, 'already_confirmed');
    assert.equal(await bookingStatus(db, booking.id), 'booked');

    // The real damage a non-idempotent handler does is here, not in the status.
    const balance = await salonBalance(db, fx.salonId);
    assert.equal(balance.gross, 100_000, 'the salon is credited once, not twice');
  });

  it('rejects an amount that disagrees with the order', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1, services: [{ name: 'haircut', durationMin: 20, price: 100_000 }] });
    const { checkout } = await hold(db, cfg, fx, at('11:00'));
    const signed = cfg.client.pay(checkout.orderId);

    await assert.rejects(
      () =>
        applyCapture(
          db,
          cfg,
          { orderId: signed.orderId, paymentId: signed.paymentId, amount: 1 },
          { now: NOW },
        ),
      (err: Error) => err.name === 'AmountMismatchError',
    );
  });

  it('honours a late payment when nobody else took the chair', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1 });
    const { booking, checkout } = await hold(db, cfg, fx, at('11:00'));
    const signed = cfg.client.pay(checkout.orderId);

    // Slow UPI: the money lands after the hold lapsed. The customer paid and
    // the chair is free — expiring them anyway would be a refund nobody needed.
    const late = new Date(NOW.getTime() + HOLD_MS + 30_000);
    const result = await applyCapture(db, cfg, { orderId: signed.orderId, paymentId: signed.paymentId }, { now: late });

    assert.equal(result.outcome, 'confirmed');
    assert.equal(await bookingStatus(db, booking.id), 'booked');
  });

  it('refunds a late payment when the chair is gone', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1, customers: 2 });
    const startAt = at('11:00');

    const slow = await hold(db, cfg, fx, startAt, 0);
    const signed = cfg.client.pay(slow.checkout.orderId);

    // Their hold lapses, someone else takes and pays for the chair, and only
    // then does the first payment arrive.
    const late = new Date(NOW.getTime() + HOLD_MS + 30_000);
    const fast = await hold(db, cfg, fx, startAt, 1, late);
    const fastSigned = cfg.client.pay(fast.checkout.orderId);
    await applyCapture(db, cfg, { orderId: fastSigned.orderId, paymentId: fastSigned.paymentId }, { now: late });

    const result = await applyCapture(
      db,
      cfg,
      { orderId: signed.orderId, paymentId: signed.paymentId },
      { now: new Date(late.getTime() + 1000) },
    );

    assert.equal(result.outcome, 'refunding');
    assert.equal(await bookingStatus(db, slow.booking.id), 'expired');

    const refunds = await db.query(`SELECT status, amount FROM refunds WHERE booking_id = $1`, [
      slow.booking.id,
    ]);
    assert.equal(refunds.rowCount, 1, 'the customer is owed their money back');
    assert.equal(await bookingStatus(db, fast.booking.id), 'booked', 'the chair stays with whoever got it');
  });
});

describe('webhooks', () => {
  function deliver(db: pg.Pool, cfg: PaymentsConfig, event: unknown, eventId: string) {
    const raw = Buffer.from(JSON.stringify(event));
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
    assert.equal(verifyWebhookSignature(raw, signature, WEBHOOK_SECRET), true);
    return handleWebhook(db, cfg, raw, { signature, eventId }, { now: NOW });
  }

  it('confirms a booking whose customer closed the tab', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1 });
    const { booking, checkout } = await hold(db, cfg, fx, at('11:00'));
    const signed = cfg.client.pay(checkout.orderId);

    // No confirmCheckout call at all — this is the customer who paid and then
    // lost signal on the redirect back.
    const result = await deliver(
      db,
      cfg,
      {
        event: 'payment.captured',
        payload: { payment: { entity: { id: signed.paymentId, order_id: signed.orderId, method: 'upi', amount: 20_000 } } },
      },
      'evt_1',
    );

    assert.equal(result.outcome, 'processed');
    assert.equal(await bookingStatus(db, booking.id), 'booked');
  });

  it('treats a re-delivered event as a duplicate, not an error', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1, services: [{ name: 'haircut', durationMin: 20, price: 100_000 }] });
    const { checkout } = await hold(db, cfg, fx, at('11:00'));
    const signed = cfg.client.pay(checkout.orderId);
    const event = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: signed.paymentId, order_id: signed.orderId, method: 'upi', amount: 100_000 } } },
    };

    const first = await deliver(db, cfg, event, 'evt_same');
    const again = await deliver(db, cfg, event, 'evt_same');

    assert.equal(first.outcome, 'processed');
    assert.equal(again.outcome, 'duplicate');
    // 200, or Razorpay retries for 24 hours and one payment becomes a storm.
    assert.equal(again.status, 200);
    assert.equal((await salonBalance(db, fx.salonId)).gross, 100_000);
  });

  it('rejects an unsigned body without recording it', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const raw = Buffer.from(JSON.stringify({ event: 'payment.captured' }));

    await assert.rejects(
      () => handleWebhook(db, cfg, raw, { signature: 'bad', eventId: 'evt_forged' }, {}),
      (err: Error) => err.name === 'WebhookSignatureError',
    );

    const seen = await db.query(`SELECT 1 FROM webhook_events WHERE id = 'evt_forged'`);
    assert.equal(seen.rowCount, 0, 'an unverified body must not reach the inbox');
  });

  it('ignores events it does not handle rather than failing them', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    // Someone ticks a new event in the Razorpay dashboard. That must not start
    // returning 500s at them.
    const result = await deliver(db, cfg, { event: 'subscription.charged', payload: {} }, 'evt_unknown');
    assert.equal(result.outcome, 'ignored');
    assert.equal(result.status, 200);
  });
});

describe('refunds and the ledger', () => {
  it('close-for-day refunds every paid booking and reverses the commission', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, {
      onlineCapacity: 1,
      services: [{ name: 'haircut', durationMin: 20, price: 100_000 }],
    });
    const { booking, checkout } = await hold(db, cfg, fx, at('11:00'));
    const signed = cfg.client.pay(checkout.orderId);
    await applyCapture(db, cfg, { orderId: signed.orderId, paymentId: signed.paymentId }, { now: NOW });

    const dayStart = at('00:00');
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
    const closed = await closeForDay(db, fx.salonId, dayStart, dayEnd, NOW);
    assert.equal(closed.cancelled, 1);
    assert.equal(closed.refundsQueued, 1);

    const run = await processDueRefunds(db, cfg.client, { now: NOW });
    assert.equal(run.processed, 1);
    assert.equal(run.failed, 0);

    const balance = await salonBalance(db, fx.salonId);
    assert.equal(balance.refunded, 100_000);
    assert.equal(balance.commissionReturned, 15_000, 'the platform does not keep its cut on a refund');
    assert.equal(balance.available, 0, 'a fully refunded booking nets to zero');
  });

  it('does not refund twice when the worker runs again', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1, services: [{ name: 'haircut', durationMin: 20, price: 100_000 }] });
    const { checkout } = await hold(db, cfg, fx, at('11:00'));
    const signed = cfg.client.pay(checkout.orderId);
    await applyCapture(db, cfg, { orderId: signed.orderId, paymentId: signed.paymentId }, { now: NOW });

    const dayStart = at('00:00');
    await closeForDay(db, fx.salonId, dayStart, new Date(dayStart.getTime() + 24 * 3600_000), NOW);
    await processDueRefunds(db, cfg.client, { now: NOW });
    const second = await processDueRefunds(db, cfg.client, { now: new Date(NOW.getTime() + 3600_000) });

    assert.equal(second.processed, 0, 'nothing is left to refund');
    assert.equal((await salonBalance(db, fx.salonId)).refunded, 100_000);
  });

  it('a customer cancellation is not refunded — §4', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1, services: [{ name: 'haircut', durationMin: 20, price: 100_000 }] });
    const { booking, checkout } = await hold(db, cfg, fx, at('11:00'));
    const signed = cfg.client.pay(checkout.orderId);
    await applyCapture(db, cfg, { orderId: signed.orderId, paymentId: signed.paymentId }, { now: NOW });

    const { customerCancelBooking } = await import('../src/booking/status.ts');
    await customerCancelBooking(db, fx.customerIds[0]!, booking.id, NOW);

    const refunds = await db.query(`SELECT 1 FROM refunds WHERE booking_id = $1`, [booking.id]);
    assert.equal(refunds.rowCount, 0, '§4: customer cancels -> no refund, reschedule instead');
    assert.equal((await salonBalance(db, fx.salonId)).available, 85_000);
  });

  it('a payout drains the balance exactly once', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1, services: [{ name: 'haircut', durationMin: 20, price: 100_000 }] });
    const { checkout } = await hold(db, cfg, fx, at('11:00'));
    const signed = cfg.client.pay(checkout.orderId);
    await applyCapture(db, cfg, { orderId: signed.orderId, paymentId: signed.paymentId }, { now: NOW });

    const first = await createPayoutForPeriod(db, fx.salonId, '2026-08-01', '2026-08-08', { now: NOW });
    assert.equal(first.created, true);
    assert.equal(first.amount, 85_000);
    assert.equal((await salonBalance(db, fx.salonId)).available, 0);

    // Re-running the weekly job must not cut a second cheque.
    const again = await createPayoutForPeriod(db, fx.salonId, '2026-08-01', '2026-08-08', { now: NOW });
    assert.equal(again.created, false);
    assert.equal((await salonBalance(db, fx.salonId)).available, 0);
  });

  it('a salon cancellation refunds and tells the customer', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1, services: [{ name: 'haircut', durationMin: 20, price: 100_000 }] });
    const { booking, checkout } = await hold(db, cfg, fx, at('11:00'));
    const signed = cfg.client.pay(checkout.orderId);
    await applyCapture(db, cfg, { orderId: signed.orderId, paymentId: signed.paymentId }, { now: NOW });

    await transition(db, fx.salonId, booking.id, 'cancelled_by_salon', { now: NOW });
    await processDueRefunds(db, cfg.client, { now: NOW });

    const channel = new ConsoleChannel();
    await dispatchDue(db, channel, { now: NOW });

    const subjects = channel.sent.map((s) => s.subject);
    assert.ok(
      subjects.some((s) => s.startsWith('Cancelled:')),
      'the customer must be told, not left to discover it at the salon',
    );
    assert.ok(subjects.some((s) => s.startsWith('Refunded:')), 'and told the money is coming back');
  });
});

describe('notifications', () => {
  it('queues a confirmation in the same transaction as the booking', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1 });
    const { booking, checkout } = await hold(db, cfg, fx, at('11:00'));
    const signed = cfg.client.pay(checkout.orderId);
    await applyCapture(db, cfg, { orderId: signed.orderId, paymentId: signed.paymentId }, { now: NOW });

    const queued = await db.query<{ template: string }>(
      `SELECT template FROM notifications WHERE booking_id = $1 ORDER BY template`,
      [booking.id],
    );
    const templates = queued.rows.map((r) => r.template);
    assert.ok(templates.includes('booking_confirmed'));
    assert.ok(templates.includes('salon_new_booking'));
  });

  it('does not send the same confirmation twice', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1 });
    const { booking, checkout } = await hold(db, cfg, fx, at('11:00'));
    const signed = cfg.client.pay(checkout.orderId);

    // Callback and webhook both land — the outbox dedupe key is what stops the
    // customer getting two identical emails.
    await applyCapture(db, cfg, { orderId: signed.orderId, paymentId: signed.paymentId }, { now: NOW });
    await applyCapture(db, cfg, { orderId: signed.orderId, paymentId: signed.paymentId }, { now: NOW });

    const count = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int8 AS n FROM notifications
        WHERE booking_id = $1 AND template = 'booking_confirmed'`,
      [booking.id],
    );
    assert.equal(Number(count.rows[0]!.n), 1);
  });

  it('marks a row sent and never re-sends it', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const cfg = config();
    const fx = await seed(db, { onlineCapacity: 1 });
    const { checkout } = await hold(db, cfg, fx, at('11:00'));
    const signed = cfg.client.pay(checkout.orderId);
    await applyCapture(db, cfg, { orderId: signed.orderId, paymentId: signed.paymentId }, { now: NOW });

    const channel = new ConsoleChannel();
    const first = await dispatchDue(db, channel, { now: NOW });
    const second = await dispatchDue(db, channel, { now: NOW });

    assert.ok(first.sent >= 1);
    assert.equal(second.sent, 0);
  });
});
