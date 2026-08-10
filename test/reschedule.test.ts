/**
 * §4's reschedule: a no-show or a cancellation may be moved to a new slot
 * within 36 hours, at no extra charge.
 *
 * The invariant worth protecting is atomicity. Retiring the old booking and
 * taking the new one are one transaction, so there is no observable moment
 * where the customer holds two chairs or none — and no failure that leaves
 * them holding the wrong one. Most of these tests are about the boundaries
 * §10 left open: the cap of one, the 36-hour window, and the frozen price.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';

import { createBooking } from '../src/booking/create.ts';
import { SlotUnavailableError } from '../src/booking/errors.ts';
import { customerCancelBooking, transition } from '../src/booking/status.ts';
import { rescheduleBooking } from '../src/booking/reschedule.ts';
import { DATE, NOW, at, hhmm } from './helpers.ts';
import { addDays } from '../src/time/tz.ts';
import { type Fixture, bookingStatus, chairsHeld, connect, seed } from './db.ts';

let pool: pg.Pool | null = null;

before(async () => {
  pool = await connect();
});

after(async () => {
  await pool?.end();
});

/** A settled, paid booking — holdTtlMs omitted, as the reschedule flow itself does. */
async function booked(db: pg.Pool, fx: Fixture, startAt: Date, customerIndex = 0) {
  return createBooking(
    db,
    {
      salonId: fx.salonId,
      customerId: fx.customerIds[customerIndex]!,
      serviceIds: [fx.serviceIds['haircut']!],
      startAt,
    },
    { now: NOW },
  );
}

describe('reschedule', () => {
  it('moves a live booking and frees the old chair', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const original = await booked(db, fx, at('11:00'));

    const result = await rescheduleBooking(
      db,
      { bookingId: original.id, customerId: fx.customerIds[0]!, startAt: at('12:00') },
      { now: NOW },
    );

    assert.equal(hhmm(result.booking.startAt), '12:00');
    assert.equal(await bookingStatus(db, original.id), 'rescheduled');
    assert.equal(await bookingStatus(db, result.booking.id), 'booked');
    assert.equal(await chairsHeld(db, fx.salonId, at('11:00'), NOW), 0, 'the old slot is sellable again');
    assert.equal(await chairsHeld(db, fx.salonId, at('12:00'), NOW), 1);
  });

  it('can move a booking onto its own old slot at a single-chair salon', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    // The obvious implementation fails this: the new booking asks whether the
    // chair is free while the old booking is still holding it, and the customer
    // is told their own slot is taken. Retiring the old row first, inside the
    // same transaction, is what makes a 30-minute nudge possible.
    const fx = await seed(db, { onlineCapacity: 1, slotIntervalMin: 30 });
    const original = await booked(db, fx, at('11:00'));

    const result = await rescheduleBooking(
      db,
      { bookingId: original.id, customerId: fx.customerIds[0]!, startAt: at('11:00') },
      { now: NOW },
    );
    assert.equal(hhmm(result.booking.startAt), '11:00');
  });

  it('carries the original price even after the salon reprices', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, {
      onlineCapacity: 1,
      services: [{ name: 'haircut', durationMin: 20, price: 40_000 }],
    });
    const original = await booked(db, fx, at('11:00'));
    assert.equal(original.amount, 40_000);

    // §10 Q4, "who absorbs a price change": nobody. The customer paid ₹400 and
    // the salon was owed ₹400; a move is not a re-sale.
    await db.query(`UPDATE salon_services SET price = 90000 WHERE salon_id = $1`, [fx.salonId]);

    const result = await rescheduleBooking(
      db,
      { bookingId: original.id, customerId: fx.customerIds[0]!, startAt: at('12:00') },
      { now: NOW },
    );
    assert.equal(result.booking.amount, 40_000, 'the frozen cart, not the current menu');
  });

  it('still works after the salon retires the service', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const original = await booked(db, fx, at('11:00'));

    // A salon that took money still owes the haircut. loadCart's `active` check
    // is skipped for a frozen cart precisely so this does not strand a customer.
    await db.query(`UPDATE salon_services SET active = false WHERE salon_id = $1`, [fx.salonId]);

    const result = await rescheduleBooking(
      db,
      { bookingId: original.id, customerId: fx.customerIds[0]!, startAt: at('12:00') },
      { now: NOW },
    );
    assert.equal(await bookingStatus(db, result.booking.id), 'booked');
  });

  it('allows exactly one move — §10 Q2', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const original = await booked(db, fx, at('10:00'));

    const first = await rescheduleBooking(
      db,
      { bookingId: original.id, customerId: fx.customerIds[0]!, startAt: at('11:00') },
      { now: NOW },
    );

    // The counter is carried forward down the chain, so rescheduling the
    // reschedule is not a way around the cap.
    await assert.rejects(
      () =>
        rescheduleBooking(
          db,
          { bookingId: first.booking.id, customerId: fx.customerIds[0]!, startAt: at('12:00') },
          { now: NOW },
        ),
      (err: Error) => err.name === 'RescheduleLimitError',
    );
  });

  it('honours the 36-hour window after a cancellation, and closes it', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });

    // The fixture salon opens 10:00-13:00, so once `now` has advanced past
    // closing the only bookable slots are on a later day. Both halves below
    // move `now` forward, so both must target the next day — aiming at a slot
    // that has already passed would fail on the 15-minute lead rule and never
    // reach the window check this test exists to exercise.
    const tomorrow = addDays(DATE, 1);

    const original = await booked(db, fx, at('11:00'));
    await customerCancelBooking(db, fx.customerIds[0]!, original.id, NOW);

    // 10 hours after the cancellation: inside the 36-hour window.
    const inside = await rescheduleBooking(
      db,
      { bookingId: original.id, customerId: fx.customerIds[0]!, startAt: at('12:00', tomorrow) },
      { now: new Date(NOW.getTime() + 10 * 3600_000) },
    );
    assert.equal(await bookingStatus(db, inside.booking.id), 'booked');

    const other = await booked(db, fx, at('10:00'), 0);
    await customerCancelBooking(db, fx.customerIds[0]!, other.id, NOW);

    // 37 hours after: the window has closed, even though the target slot is
    // itself perfectly bookable.
    await assert.rejects(
      () =>
        rescheduleBooking(
          db,
          { bookingId: other.id, customerId: fx.customerIds[0]!, startAt: at('12:30', addDays(DATE, 2)) },
          { now: new Date(NOW.getTime() + 37 * 3600_000) },
        ),
      (err: Error) => err.name === 'RescheduleWindowError',
    );
  });

  it('refuses when the target slot is taken, leaving the original intact', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1, customers: 2 });
    const mine = await booked(db, fx, at('11:00'), 0);
    await booked(db, fx, at('12:00'), 1);

    await assert.rejects(
      () =>
        rescheduleBooking(
          db,
          { bookingId: mine.id, customerId: fx.customerIds[0]!, startAt: at('12:00') },
          { now: NOW },
        ),
      SlotUnavailableError,
    );

    // The rollback is the point. A failed move must not cost the customer the
    // booking they already had.
    assert.equal(await bookingStatus(db, mine.id), 'booked');
    assert.equal(await chairsHeld(db, fx.salonId, at('11:00'), NOW), 1);
  });

  it('will not move someone else’s booking', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 2, customers: 2 });
    const theirs = await booked(db, fx, at('11:00'), 0);

    await assert.rejects(
      () =>
        rescheduleBooking(
          db,
          { bookingId: theirs.id, customerId: fx.customerIds[1]!, startAt: at('12:00') },
          { now: NOW },
        ),
      (err: Error) => err.name === 'BookingNotFoundError',
    );
  });

  it('will not move a completed booking', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const original = await booked(db, fx, at('11:00'));
    await transition(db, fx.salonId, original.id, 'verified', { code: await verifyCode(db, original.id), now: NOW });
    await transition(db, fx.salonId, original.id, 'in_progress', { now: NOW });
    await transition(db, fx.salonId, original.id, 'completed', { now: NOW });

    await assert.rejects(
      () =>
        rescheduleBooking(
          db,
          { bookingId: original.id, customerId: fx.customerIds[0]!, startAt: at('12:00') },
          { now: NOW },
        ),
      (err: Error) => err.name === 'NotReschedulableError',
    );
  });
});

async function verifyCode(db: pg.Pool, bookingId: string): Promise<string> {
  const res = await db.query<{ verify_code: string }>(
    `SELECT verify_code FROM bookings WHERE id = $1`,
    [bookingId],
  );
  return res.rows[0]!.verify_code;
}
