/**
 * One customer, several live bookings, and the code that belongs to each.
 *
 * The report behind these tests was that booking something new completed the
 * previous booking, took its code away, and handed every booking the same
 * digits. Reading the write path says none of that can happen — every status
 * write is scoped to one booking id, and the code is generated per row — but
 * "reading it says so" is what a test is for. So the whole reported sequence
 * is executed here: five bookings, verify one, check the other four are
 * untouched, and try an old code against a different booking.
 *
 * The one thing that *could* have gone wrong is two live bookings drawing the
 * same six digits by chance. That is now impossible twice over — the code is
 * chosen against the salon's live codes under the booking lock, and a partial
 * unique index refuses it underneath — and both halves are tested.
 *
 * Needs a real Postgres; skips (does not fail) without one.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';

import { createBooking } from '../src/booking/create.ts';
import { BadCodeError, InvalidTransitionError, transition } from '../src/booking/status.ts';
import { listCustomerBookings } from '../src/business/repo.ts';
import { DATE, NOW, at } from './helpers.ts';
import { type Fixture, bookingStatus, connect, seed } from './db.ts';

let pool: pg.Pool | null = null;

before(async () => {
  pool = await connect();
});

after(async () => {
  await pool?.end();
});

/** A salon that can take a booking every half hour all day, for one customer. */
async function busyDay(db: pg.Pool): Promise<Fixture> {
  return seed(db, { onlineCapacity: 3, openAt: '09:00', closeAt: '20:00', customers: 2 });
}

async function book(db: pg.Pool, fx: Fixture, hhmm: string, customer = 0) {
  return createBooking(
    db,
    {
      salonId: fx.salonId,
      customerId: fx.customerIds[customer]!,
      serviceIds: [fx.serviceIds['haircut']!],
      startAt: at(hhmm),
    },
    { now: NOW },
  );
}

async function codeOf(db: pg.Pool, bookingId: string): Promise<string> {
  const res = await db.query<{ verify_code: string }>(
    `SELECT verify_code FROM bookings WHERE id = $1`,
    [bookingId],
  );
  return res.rows[0]!.verify_code;
}

describe('bookings are independent of each other', () => {
  it('1-3. a second booking leaves the first booked, with its own code', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await busyDay(db);

    const a = await book(db, fx, '11:00');
    const codeA = await codeOf(db, a.id);

    const b = await book(db, fx, '12:00');
    const codeB = await codeOf(db, b.id);

    assert.notEqual(codeB, codeA, 'a new booking gets its own code');
    assert.equal(await bookingStatus(db, a.id), 'booked', 'booking A is untouched by booking B');
    assert.equal(await codeOf(db, a.id), codeA, "and A's code is not overwritten");
  });

  it('4-5. verifying one booking completes only that one', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await busyDay(db);

    const a = await book(db, fx, '11:00');
    const b = await book(db, fx, '12:00');
    const codeA = await codeOf(db, a.id);
    const codeB = await codeOf(db, b.id);

    // B all the way through to completed, which is the only route there.
    await transition(db, fx.salonId, b.id, 'verified', { code: codeB, now: at('12:00') });
    await transition(db, fx.salonId, b.id, 'in_progress', { now: at('12:01') });
    await transition(db, fx.salonId, b.id, 'completed', { now: at('12:20') });

    assert.equal(await bookingStatus(db, b.id), 'completed');
    assert.equal(await bookingStatus(db, a.id), 'booked', 'A is still live');
    assert.equal(await codeOf(db, a.id), codeA, "and still holds its own code");

    // Now A, on its own.
    await transition(db, fx.salonId, a.id, 'verified', { code: codeA, now: at('13:00') });
    assert.equal(await bookingStatus(db, a.id), 'verified');
    assert.equal(await bookingStatus(db, b.id), 'completed', 'B did not change again');
  });

  it('6. five bookings, five different codes', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await busyDay(db);

    const ids = [];
    for (const hhmm of ['11:00', '12:00', '13:00', '14:00', '15:00']) {
      ids.push((await book(db, fx, hhmm)).id);
    }

    const codes = [];
    for (const id of ids) codes.push(await codeOf(db, id));

    assert.equal(new Set(codes).size, 5, `expected 5 distinct codes, got ${codes.join(',')}`);
    for (const id of ids) assert.equal(await bookingStatus(db, id), 'booked');
  });

  it('7. a code from one booking cannot verify another', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await busyDay(db);

    const a = await book(db, fx, '11:00');
    const b = await book(db, fx, '12:00');
    const codeA = await codeOf(db, a.id);

    await assert.rejects(
      transition(db, fx.salonId, b.id, 'verified', { code: codeA, now: at('12:00') }),
      BadCodeError,
      "A's code must not check B in",
    );
    assert.equal(await bookingStatus(db, b.id), 'booked');

    // A wrong code is a wrong code, not a way in.
    await assert.rejects(
      transition(db, fx.salonId, b.id, 'verified', { code: '000000', now: at('12:00') }),
      BadCodeError,
    );
  });

  it('a used code cannot be replayed against the booking it belonged to', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await busyDay(db);

    const a = await book(db, fx, '11:00');
    const codeA = await codeOf(db, a.id);
    await transition(db, fx.salonId, a.id, 'verified', { code: codeA, now: at('11:00') });

    await assert.rejects(
      transition(db, fx.salonId, a.id, 'verified', { code: codeA, now: at('11:05') }),
      InvalidTransitionError,
      'verified is not a state you can enter twice',
    );
  });

  it("another salon cannot verify this salon's booking", async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await busyDay(db);
    const a = await book(db, fx, '11:00');
    const codeA = await codeOf(db, a.id);

    const other = await db.query<{ id: string }>(
      `INSERT INTO users (phone, name, email, role)
       VALUES ('+919000000009', 'Other owner', 'other-owner@example.test', 'business') RETURNING id`,
    );
    const otherSalon = await db.query<{ id: string }>(
      `INSERT INTO salons (owner_id, name, address, lat, lng, status)
       VALUES ($1, 'Other Salon', 'Elsewhere', 12.9, 77.6, 'active') RETURNING id`,
      [other.rows[0]!.id],
    );

    await assert.rejects(
      transition(db, otherSalon.rows[0]!.id, a.id, 'verified', { code: codeA, now: at('11:00') }),
      // Not found, because the booking is scoped to the salon before anything
      // else is considered — the code never even gets compared.
      (err: unknown) => err instanceof Error && err.name === 'BookingNotFoundError',
    );
    assert.equal(await bookingStatus(db, a.id), 'booked');
  });
});

describe('verification codes are unique among live bookings', () => {
  it('the database refuses a duplicate live code outright', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await busyDay(db);

    const a = await book(db, fx, '11:00');
    const b = await book(db, fx, '12:00');
    const codeA = await codeOf(db, a.id);

    // The backstop under createBooking: even a hand-written UPDATE cannot put
    // the same live code on two bookings at one salon.
    await assert.rejects(
      db.query(`UPDATE bookings SET verify_code = $2 WHERE id = $1`, [b.id, codeA]),
      (err: unknown) => (err as { code?: string }).code === '23505',
      'the partial unique index must reject it',
    );
  });

  it('a finished booking keeps its code and stops reserving it', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await busyDay(db);

    const a = await book(db, fx, '11:00');
    const codeA = await codeOf(db, a.id);
    await db.query(`UPDATE bookings SET status = 'completed' WHERE id = $1`, [a.id]);

    // History keeps its code — the record of what was typed at the counter.
    assert.equal(await codeOf(db, a.id), codeA);
    // ...and the number is available again, so a salon open for years does not
    // slowly exhaust six digits.
    const b = await book(db, fx, '12:00');
    await db.query(`UPDATE bookings SET verify_code = $2 WHERE id = $1`, [b.id, codeA]);
    assert.equal(await codeOf(db, b.id), codeA);
  });
});

describe('what the customer app is handed', () => {
  it('gives every booking its own code, revealed on its own slot’s clock', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await busyDay(db);

    const soon = await book(db, fx, '11:00');
    const later = await book(db, fx, '15:00');

    // Ten minutes before the first booking: its code is out, the later one's
    // is not, and the app is told when that one arrives rather than being left
    // with a blank space that reads as a lost code.
    const listed = await listCustomerBookings(db, fx.customerIds[0]!, at('10:50'));
    const forSoon = listed.find((b) => b.id === soon.id)!;
    const forLater = listed.find((b) => b.id === later.id)!;

    assert.equal(forSoon.verifyCode, await codeOf(db, soon.id));
    assert.equal(forLater.verifyCode, null, '§4: not until 15 minutes before');
    assert.equal(forLater.verifyCodeAt, at('14:45').toISOString());
    assert.notEqual(forSoon.verifyCode, await codeOf(db, later.id));

    // Both are still listed and still their own booking.
    assert.equal(forSoon.status, 'booked');
    assert.equal(forLater.status, 'booked');
  });

  it('verifying one booking does not disturb the other’s code', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await busyDay(db);

    const first = await book(db, fx, '11:00');
    const second = await book(db, fx, '15:00');
    const codeSecond = await codeOf(db, second.id);

    await transition(db, fx.salonId, first.id, 'verified', {
      code: await codeOf(db, first.id),
      now: at('11:00'),
    });

    const listed = await listCustomerBookings(db, fx.customerIds[0]!, at('14:50'));
    const stillWaiting = listed.find((b) => b.id === second.id)!;
    assert.equal(stillWaiting.status, 'booked');
    assert.equal(stillWaiting.verifyCode, codeSecond, 'unchanged, and shown when its own time comes');
  });

  it('one customer’s bookings are never mixed with another’s', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await busyDay(db);

    const mine = await book(db, fx, '11:00', 0);
    const theirs = await book(db, fx, '11:30', 1);

    const listed = await listCustomerBookings(db, fx.customerIds[0]!, at('10:50'));
    assert.deepEqual(listed.map((b) => b.id), [mine.id]);
    assert.ok(!listed.some((b) => b.id === theirs.id));
  });
});

describe('nothing completes a booking except that booking being served', () => {
  it('booking again does not advance any existing booking', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await busyDay(db);

    const ids = [];
    for (const hhmm of ['11:00', '12:00', '13:00']) ids.push((await book(db, fx, hhmm)).id);

    // The reported symptom, executed: keep booking, and watch the earlier ones.
    for (const hhmm of ['14:00', '15:00', '16:00']) {
      await book(db, fx, hhmm);
      for (const id of ids) {
        assert.equal(await bookingStatus(db, id), 'booked', `${id} changed when a later booking was made`);
      }
    }

    const all = await db.query<{ n: number }>(
      `SELECT count(*)::int8 AS n FROM bookings WHERE customer_id = $1 AND status = 'completed'`,
      [fx.customerIds[0]!],
    );
    assert.equal(Number(all.rows[0]!.n), 0, 'nothing was completed by anything other than being served');
  });

  it('a booking reaches completed only through verify and start', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await busyDay(db);
    const a = await book(db, fx, '11:00');

    await assert.rejects(
      transition(db, fx.salonId, a.id, 'completed', { now: at('11:30') }),
      InvalidTransitionError,
      'booked -> completed is not a move',
    );
    assert.equal(await bookingStatus(db, a.id), 'booked');
    assert.equal(DATE, '2026-08-03');
  });
});
