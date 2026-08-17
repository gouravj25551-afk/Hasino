/**
 * The customer's 15 minutes of grace.
 *
 * A no-show is the one action in this app that takes a customer's money and
 * gives them nothing: §4 refunds them zero, and three of them inside 60 days
 * blocks them from booking for 30. So it may not be declared at the scheduled
 * minute, when the customer is still parking — only once they are genuinely
 * late.
 *
 * The gate is on the write, not on the button. These tests go through
 * transition() and through the HTTP route, because the button is the one part
 * an unhappy salon can trivially skip.
 *
 * Needs a real Postgres; skips (does not fail) without one.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';

import { createBooking } from '../src/booking/create.ts';
import {
  NO_SHOW_GRACE_MIN,
  NoShowTooEarlyError,
  InvalidTransitionError,
  noShowAvailableAt,
  transition,
} from '../src/booking/status.ts';
import { businessRoutes } from '../src/http/routes-business.ts';
import { respondToError } from '../src/http/server.ts';
import { MemorySnapshotCache } from '../src/availability/cache.ts';
import { listBookingsForDay } from '../src/business/repo.ts';
import { NOW, TZ, at } from './helpers.ts';
import { type Fixture, bookingStatus, connect, seed } from './db.ts';

let pool: pg.Pool | null = null;

before(async () => {
  pool = await connect();
});

after(async () => {
  await pool?.end();
});

/** A 'booked' booking at 11:00 on the fixture day, taken well in advance. */
async function bookedAt11(db: pg.Pool, fx: Fixture) {
  return createBooking(
    db,
    {
      salonId: fx.salonId,
      customerId: fx.customerIds[0]!,
      serviceIds: [fx.serviceIds['haircut']!],
      startAt: at('11:00'),
    },
    { now: NOW },
  );
}

describe('no-show — the 15-minute grace period', () => {
  it('the deadline is start + 15 minutes, and nothing else', () => {
    assert.equal(NO_SHOW_GRACE_MIN, 15);
    const start = at('10:00');
    assert.equal(noShowAvailableAt(start).getTime() - start.getTime(), 15 * 60_000);
  });

  it('refuses a no-show before the booking has even started', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const booking = await bookedAt11(db, fx);

    await assert.rejects(
      transition(db, fx.salonId, booking.id, 'no_show', { now: at('10:59') }),
      NoShowTooEarlyError,
    );
    assert.equal(await bookingStatus(db, booking.id), 'booked');
  });

  it('refuses a no-show at the scheduled minute', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const booking = await bookedAt11(db, fx);

    await assert.rejects(
      transition(db, fx.salonId, booking.id, 'no_show', { now: at('11:00') }),
      NoShowTooEarlyError,
    );
    assert.equal(await bookingStatus(db, booking.id), 'booked');
  });

  it('refuses a no-show one minute early', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const booking = await bookedAt11(db, fx);

    await assert.rejects(
      transition(db, fx.salonId, booking.id, 'no_show', { now: at('11:14') }),
      (err: unknown) => {
        assert.ok(err instanceof NoShowTooEarlyError);
        // The error carries the minute, so the panel never has to guess it.
        assert.equal(err.availableAt.getTime(), at('11:15').getTime());
        return true;
      },
    );
    assert.equal(await bookingStatus(db, booking.id), 'booked');
  });

  it('refuses at 14 minutes 59 seconds and allows at 15:00 exactly', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const booking = await bookedAt11(db, fx);

    // The boundary, to the second. A minute-granular check would pass both of
    // these and the rule would be "14 minutes" on a bad day.
    const oneSecondEarly = new Date(at('11:15').getTime() - 1000);
    await assert.rejects(
      transition(db, fx.salonId, booking.id, 'no_show', { now: oneSecondEarly }),
      NoShowTooEarlyError,
    );
    assert.equal(await bookingStatus(db, booking.id), 'booked');

    const exactly = await transition(db, fx.salonId, booking.id, 'no_show', { now: at('11:15') });
    assert.equal(exactly.status, 'no_show');
  });

  it("another salon cannot mark this salon's booking absent", async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const booking = await bookedAt11(db, fx);

    const stranger = await db.query<{ id: string }>(
      `INSERT INTO users (phone, name, email, role)
       VALUES ('+919000000077', 'Stranger', 'stranger@example.test', 'business') RETURNING id`,
    );
    const strangerSalon = await db.query<{ id: string }>(
      `INSERT INTO salons (owner_id, name, address, lat, lng, status)
       VALUES ($1, 'Not Your Salon', 'Elsewhere', 12.9, 77.6, 'active') RETURNING id`,
      [stranger.rows[0]!.id],
    );

    // Well past the grace period, and still refused: the booking is scoped to
    // the salon before the clock is even consulted.
    await assert.rejects(
      transition(db, strangerSalon.rows[0]!.id, booking.id, 'no_show', { now: at('12:00') }),
      (err: unknown) => err instanceof Error && err.name === 'BookingNotFoundError',
    );
    assert.equal(await bookingStatus(db, booking.id), 'booked');
  });

  it('allows the no-show exactly on the fifteenth minute', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const booking = await bookedAt11(db, fx);

    const result = await transition(db, fx.salonId, booking.id, 'no_show', { now: at('11:15') });
    assert.equal(result.status, 'no_show');
    assert.equal(await bookingStatus(db, booking.id), 'no_show');
  });

  it('never allows one for a booking still in the future', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const booking = await bookedAt11(db, fx);

    // Tomorrow's booking, marked from today: the grace period is measured from
    // the booking's own start, so this is not merely early, it is always early.
    await assert.rejects(
      transition(db, fx.salonId, booking.id, 'no_show', { now: NOW }),
      NoShowTooEarlyError,
    );
  });
});

describe('no-show — bookings that are already resolved', () => {
  it('refuses one for a customer who checked in', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const booking = await bookedAt11(db, fx);

    const code = await db.query<{ verify_code: string }>(
      `SELECT verify_code FROM bookings WHERE id = $1`,
      [booking.id],
    );
    await transition(db, fx.salonId, booking.id, 'verified', {
      code: code.rows[0]!.verify_code,
      now: at('11:00'),
    });

    // Well past the grace period, and still refused: they are in the shop.
    await assert.rejects(
      transition(db, fx.salonId, booking.id, 'no_show', { now: at('12:00') }),
      InvalidTransitionError,
    );
    assert.equal(await bookingStatus(db, booking.id), 'verified');
  });

  it('refuses one for a cancelled booking', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const booking = await bookedAt11(db, fx);
    await db.query(`UPDATE bookings SET status = 'cancelled_by_customer' WHERE id = $1`, [booking.id]);

    await assert.rejects(
      transition(db, fx.salonId, booking.id, 'no_show', { now: at('11:15') }),
      InvalidTransitionError,
    );
  });

  it('refuses one for a completed booking', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const booking = await bookedAt11(db, fx);
    const code = await db.query<{ verify_code: string }>(
      `SELECT verify_code FROM bookings WHERE id = $1`,
      [booking.id],
    );
    await transition(db, fx.salonId, booking.id, 'verified', { code: code.rows[0]!.verify_code });
    await transition(db, fx.salonId, booking.id, 'in_progress');
    await transition(db, fx.salonId, booking.id, 'completed');

    await assert.rejects(
      transition(db, fx.salonId, booking.id, 'no_show', { now: at('12:00') }),
      InvalidTransitionError,
    );
  });

  it('counts a no-show once, however many times the button is pressed', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const booking = await bookedAt11(db, fx);

    await transition(db, fx.salonId, booking.id, 'no_show', { now: at('11:15') });
    await assert.rejects(
      transition(db, fx.salonId, booking.id, 'no_show', { now: at('11:20') }),
      InvalidTransitionError,
    );

    const strikes = await db.query<{ no_show_count: number }>(
      `SELECT no_show_count FROM users WHERE id = $1`,
      [fx.customerIds[0]!],
    );
    assert.equal(strikes.rows[0]!.no_show_count, 1, 'the second press must not double the strike');
  });
});

describe('no-show — the money is untouched', () => {
  it('refunds nothing, exactly as before', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const booking = await bookedAt11(db, fx);

    await transition(db, fx.salonId, booking.id, 'no_show', { now: at('11:15') });

    const row = await db.query<{ refund_status: string; cancelled_at: Date | null }>(
      `SELECT refund_status, cancelled_at FROM bookings WHERE id = $1`,
      [booking.id],
    );
    assert.equal(row.rows[0]!.refund_status, 'none', '§4: a no-show is not refunded');
    assert.equal(row.rows[0]!.cancelled_at, null);

    const refunds = await db.query(`SELECT 1 FROM refunds WHERE booking_id = $1`, [booking.id]);
    assert.equal(refunds.rowCount, 0, 'a no-show queues no refund');
  });

  it('an early attempt moves no money and leaves no trace', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const booking = await bookedAt11(db, fx);

    await assert.rejects(transition(db, fx.salonId, booking.id, 'no_show', { now: at('11:01') }));

    const row = await db.query<{ status: string; refund_status: string; reschedule_deadline: Date | null }>(
      `SELECT status, refund_status, reschedule_deadline FROM bookings WHERE id = $1`,
      [booking.id],
    );
    assert.equal(row.rows[0]!.status, 'booked');
    assert.equal(row.rows[0]!.refund_status, 'none');
    assert.equal(row.rows[0]!.reschedule_deadline, null, 'the rejected transition wrote nothing');

    const strikes = await db.query<{ no_show_count: number }>(
      `SELECT no_show_count FROM users WHERE id = $1`,
      [fx.customerIds[0]!],
    );
    assert.equal(strikes.rows[0]!.no_show_count, 0, 'no strike for a customer who is 1 minute late');
  });
});

describe('no-show — what the panel is told', () => {
  it("carries the deadline on the salon's booking list", async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const booking = await bookedAt11(db, fx);

    const day = await listBookingsForDay(db, fx.salonId, TZ, '2026-08-03');
    const row = day.find((b) => b.id === booking.id);
    assert.ok(row, 'the booking is on the day list');
    assert.equal(
      row.noShowAvailableAt,
      at('11:15').toISOString(),
      'the panel gets the deadline from the server, not from the shop phone',
    );
  });
});

/** A ServerResponse stub: enough of one for a JSON route, and nothing more. */
function captureResponse() {
  const captured = { status: 0, body: null as unknown };
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(payload: string) {
      captured.body = payload ? JSON.parse(payload) : null;
      (this as { headersSent: boolean }).headersSent = true;
    },
  };
  return { captured, res: res as unknown as ServerResponse };
}

/** POST /api/business/bookings/:id/no-show, the way curl would reach it. */
async function callNoShowRoute(db: pg.Pool, ownerId: string, bookingId: string) {
  const { captured, res } = captureResponse();
  try {
    await businessRoutes(db, {} as IncomingMessage, res, {
      seg: ['api', 'business', 'bookings', bookingId, 'no-show'],
      method: 'POST',
      url: new URL(`http://localhost/api/business/bookings/${bookingId}/no-show`),
      ownerId,
      cache: new MemorySnapshotCache(),
    });
  } catch (err) {
    respondToError(res, err);
  }
  return captured;
}

describe('no-show — the API refuses what the button hides', () => {
  it('rejects a direct call before the grace period with 409 and the minute', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });

    // Started five minutes ago on the real clock — the route does not take a
    // clock, which is the point: it uses the server's.
    const startAt = new Date(Date.now() - 5 * 60_000);
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO bookings (salon_id, customer_id, start_at, end_at, status, amount)
       VALUES ($1, $2, $3, $4, 'booked', 30000) RETURNING id`,
      [fx.salonId, fx.customerIds[0]!, startAt, new Date(startAt.getTime() + 30 * 60_000)],
    );
    const bookingId = inserted.rows[0]!.id;

    const out = await callNoShowRoute(db, fx.ownerId, bookingId);
    assert.equal(out.status, 409);
    const body = out.body as { code: string; availableAt: string };
    assert.equal(body.code, 'NO_SHOW_TOO_EARLY');
    assert.equal(body.availableAt, new Date(startAt.getTime() + 15 * 60_000).toISOString());
    assert.equal(await bookingStatus(db, bookingId), 'booked');
  });

  it('allows a direct call once the grace period has passed', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });

    const startAt = new Date(Date.now() - 20 * 60_000);
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO bookings (salon_id, customer_id, start_at, end_at, status, amount)
       VALUES ($1, $2, $3, $4, 'booked', 30000) RETURNING id`,
      [fx.salonId, fx.customerIds[0]!, startAt, new Date(startAt.getTime() + 30 * 60_000)],
    );
    const bookingId = inserted.rows[0]!.id;

    const out = await callNoShowRoute(db, fx.ownerId, bookingId);
    assert.equal(out.status, 200);
    assert.equal(await bookingStatus(db, bookingId), 'no_show');
  });
});
