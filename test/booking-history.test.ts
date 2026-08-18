/**
 * When a booking stops being "Upcoming".
 *
 * The reported bug: a 10:00-10:30 appointment was still sitting at the top of
 * the customer's Upcoming list the next day. Nothing was wrong with the data —
 * the list was keyed on *status*, and a booking only leaves 'booked' if a salon
 * presses something. A salon that never pressed anything left the booking
 * there forever.
 *
 * So classification is a function of the clock now, and these tests pin the
 * three things that makes load-bearing:
 *
 *   - the boundary is end_at + 30 min, to the minute, and inclusive
 *   - it does not need anybody to press anything, or the page to be reloaded
 *   - it decides which *list* a booking is in and nothing else — the business
 *     status is still whatever the salon and the payment system last wrote
 *
 * The pure-function tests need no database. The rest skip (do not fail)
 * without one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';

import { createBooking } from '../src/booking/create.ts';
import {
  HISTORY_GRACE_MIN,
  RESOLVED_STATUSES,
  classifyBooking,
  customerCancelBooking,
  historyAt,
  transition,
} from '../src/booking/status.ts';
import { listCustomerBookings } from '../src/business/repo.ts';
import { NOW, at, hhmm } from './helpers.ts';
import { type Fixture, connect, seed } from './db.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let pool: pg.Pool | null = null;

before(async () => {
  pool = await connect();
});

after(async () => {
  await pool?.end();
});

/** A salon open all day, with one service of `durationMin` so end_at is exact. */
async function dayWith(db: pg.Pool, durationMin: number): Promise<Fixture> {
  return seed(db, {
    openAt: '09:00',
    closeAt: '21:00',
    onlineCapacity: 3,
    customers: 2,
    services: [{ name: 'haircut', durationMin, price: 20_000, bufferMin: 10 }],
  });
}

async function book(db: pg.Pool, fx: Fixture, start: string, customer = 0) {
  return createBooking(
    db,
    {
      salonId: fx.salonId,
      customerId: fx.customerIds[customer]!,
      serviceIds: [fx.serviceIds['haircut']!],
      startAt: at(start),
    },
    { now: NOW },
  );
}

/** This booking's category in the customer's list, as the API would report it. */
async function categoryAt(db: pg.Pool, fx: Fixture, id: string, when: string, customer = 0) {
  const listed = await listCustomerBookings(db, fx.customerIds[customer]!, at(when));
  return listed.find((b) => b.id === id);
}

// ---------------------------------------------------------------------------

describe('the grace period, as arithmetic', () => {
  it('is half an hour past the scheduled end', () => {
    assert.equal(HISTORY_GRACE_MIN, 30);
  });

  // The three worked examples from the report, end to end through historyAt.
  for (const [end, past] of [
    ['10:30', '11:00'],
    ['14:45', '15:15'],
    ['19:00', '19:30'],
  ] as const) {
    it(`a booking ending ${end} becomes historical at ${past}`, () => {
      assert.equal(hhmm(historyAt(at(end))), past);
    });
  }

  it('reads the stored instant, so the salon’s zone is already resolved', () => {
    // end_at is a timestamptz — the wall clock was converted when the booking
    // was created. Adding 30 minutes to an instant cannot land on the wrong
    // hour, which is the whole reason this does not parse a date string.
    const end = at('10:30');
    assert.equal(historyAt(end).getTime() - end.getTime(), 30 * 60_000);
  });
});

describe('which list a booking belongs in', () => {
  const end = at('10:30'); // threshold 11:00

  it('is upcoming a minute before the threshold', () => {
    assert.equal(classifyBooking('booked', end, at('10:59')), 'upcoming');
  });

  it('is past at exactly the threshold', () => {
    assert.equal(classifyBooking('booked', end, at('11:00')), 'past');
  });

  it('is past after it', () => {
    assert.equal(classifyBooking('booked', end, at('11:01')), 'past');
  });

  it('does not wait for the salon to press anything', () => {
    // The point of the fix: 'booked' is the status of a booking nobody
    // touched, and it still moves.
    assert.equal(classifyBooking('booked', end, at('18:00')), 'past');
    assert.equal(classifyBooking('verified', end, at('18:00')), 'past');
    assert.equal(classifyBooking('in_progress', end, at('18:00')), 'past');
  });

  it('files a recorded outcome as past at once, without waiting for the grace', () => {
    // The salon has said how the visit went, so there is nothing for the grace
    // period to protect — even while the slot itself is still running.
    for (const status of RESOLVED_STATUSES) {
      assert.equal(classifyBooking(status, end, at('10:20')), 'past', `${status} at 10:20`);
      assert.equal(classifyBooking(status, end, at('10:59')), 'past', `${status} at 10:59`);
      assert.equal(classifyBooking(status, end, at('11:00')), 'past', `${status} at 11:00`);
    }
  });

  it('covers exactly completed and no_show', () => {
    assert.deepEqual([...RESOLVED_STATUSES].sort(), ['completed', 'no_show']);
  });

  it('still makes a visit that is merely under way wait out its grace', () => {
    // A recorded outcome is an exception to the clock, not a replacement for
    // it: 'verified' and 'in_progress' say the visit is happening, not that it
    // is over.
    assert.equal(classifyBooking('booked', end, at('10:59')), 'upcoming');
    assert.equal(classifyBooking('verified', end, at('10:59')), 'upcoming');
    assert.equal(classifyBooking('in_progress', end, at('10:59')), 'upcoming');
  });

  it('files a cancellation by status, not by the clock', () => {
    // A cancellation is not a visit running late; it was called off. It must
    // never sit in Upcoming waiting for its slot to lapse, and it must still
    // be identifiable as a cancellation long afterwards.
    for (const when of ['08:00', '10:59', '11:00', '23:00']) {
      assert.equal(classifyBooking('cancelled_by_customer', end, at(when)), 'cancelled');
      assert.equal(classifyBooking('cancelled_by_salon', end, at(when)), 'cancelled');
      assert.equal(classifyBooking('rescheduled', end, at(when)), 'cancelled');
    }
  });

  it('moves an unpaid hold out of Upcoming once its slot has gone', () => {
    assert.equal(classifyBooking('pending_payment', end, at('10:15')), 'upcoming');
    assert.equal(classifyBooking('pending_payment', end, at('11:00')), 'past');
  });
});

// ---------------------------------------------------------------------------

describe('what the customer’s list reports', () => {
  it('crosses the boundary at end + 30 with nothing else changing', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await dayWith(db, 30);
    const b = await book(db, fx, '10:00'); // 10:00-10:30, historical at 11:00
    assert.equal(hhmm(b.endAt), '10:30');

    const before = await categoryAt(db, fx, b.id, '10:59');
    assert.equal(before?.category, 'upcoming');
    assert.equal(before?.status, 'booked', 'the status is not rewritten by looking at it');

    const on = await categoryAt(db, fx, b.id, '11:00');
    assert.equal(on?.category, 'past', 'inclusive at the boundary');
    assert.equal(on?.status, 'booked', 'still exactly what the salon last wrote');

    const later = await categoryAt(db, fx, b.id, '11:01');
    assert.equal(later?.category, 'past');
  });

  it('shows a long-finished booking as past on the first load', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await dayWith(db, 30);
    const b = await book(db, fx, '10:00');

    // Opening the page the next morning. No refresh, no sweep, no button.
    const listed = await listCustomerBookings(db, fx.customerIds[0]!, at('09:00', '2026-08-04'));
    assert.equal(listed.find((x) => x.id === b.id)?.category, 'past');
  });

  it('does not move the booking’s own times', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await dayWith(db, 45);
    const b = await book(db, fx, '14:00'); // 14:00-14:45, historical at 15:15

    const early = await categoryAt(db, fx, b.id, '15:14');
    const late = await categoryAt(db, fx, b.id, '15:15');
    assert.equal(early?.category, 'upcoming');
    assert.equal(late?.category, 'past');
    // The stored slot is untouched by classification.
    assert.equal(early?.startAt, late?.startAt);
    assert.equal(early?.endAt, late?.endAt);
    assert.equal(hhmm(new Date(late!.endAt)), '14:45');
  });

  it('keeps COMPLETED identifiable after it turns historical', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await dayWith(db, 30);
    const b = await book(db, fx, '10:00');

    const code = (
      await db.query<{ verify_code: string }>(`SELECT verify_code FROM bookings WHERE id = $1`, [b.id])
    ).rows[0]!.verify_code;
    await transition(db, fx.salonId, b.id, 'verified', { code, now: at('10:00') });
    await transition(db, fx.salonId, b.id, 'in_progress', { now: at('10:02') });
    await transition(db, fx.salonId, b.id, 'completed', { now: at('10:25') });

    // Marked done at 10:25, five minutes before the slot even ends: past
    // straight away, and still recognisably COMPLETED.
    const during = await categoryAt(db, fx, b.id, '10:26');
    assert.equal(during?.status, 'completed', 'the business status survives the move');
    assert.equal(during?.category, 'past', 'no grace period once the salon has finished');

    const after = await categoryAt(db, fx, b.id, '11:00');
    assert.equal(after?.status, 'completed');
    assert.equal(after?.category, 'past');
  });

  it('keeps NO_SHOW identifiable, and files it as past at once', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await dayWith(db, 30);
    const b = await book(db, fx, '10:00'); // 10:00-10:30, grace would end 11:00

    // The earliest a salon may declare it: start + the 15-minute no-show grace.
    await transition(db, fx.salonId, b.id, 'no_show', { now: at('10:15') });

    const during = await categoryAt(db, fx, b.id, '10:16');
    assert.equal(during?.status, 'no_show', 'the strike is still on the record');
    assert.equal(during?.category, 'past', 'not held in Upcoming until 11:00');
  });

  it('keeps CANCELLED identifiable, and out of Upcoming, either side of the line', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await dayWith(db, 30);
    const b = await book(db, fx, '10:00');
    await customerCancelBooking(db, fx.customerIds[0]!, b.id, at('09:00'));

    for (const when of ['09:30', '11:00', '20:00']) {
      const listed = await categoryAt(db, fx, b.id, when);
      assert.equal(listed?.status, 'cancelled_by_customer', `status preserved at ${when}`);
      assert.equal(listed?.category, 'cancelled', `filed as cancelled at ${when}`);
    }
  });

  it('judges every booking on its own end time', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await dayWith(db, 30);
    const morning = await book(db, fx, '10:00'); // historical at 11:00
    const noon = await book(db, fx, '12:00'); // historical at 13:00
    const evening = await book(db, fx, '18:00'); // historical at 19:00

    const listed = await listCustomerBookings(db, fx.customerIds[0]!, at('13:00'));
    const by = (id: string) => listed.find((x) => x.id === id)?.category;
    assert.equal(by(morning.id), 'past');
    assert.equal(by(noon.id), 'past', 'inclusive on its own boundary');
    assert.equal(by(evening.id), 'upcoming');
  });
});

describe('the query can narrow to one category', () => {
  it('returns the same split the classifier does', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await dayWith(db, 30);
    const past = await book(db, fx, '10:00'); // historical at 11:00
    const future = await book(db, fx, '18:00');
    const cancelled = await book(db, fx, '15:00');
    await customerCancelBooking(db, fx.customerIds[0]!, cancelled.id, at('09:00'));

    const when = at('13:00');
    const ids = async (category: 'upcoming' | 'past' | 'cancelled') =>
      (await listCustomerBookings(db, fx.customerIds[0]!, when, category)).map((b) => b.id).sort();

    assert.deepEqual(await ids('past'), [past.id]);
    assert.deepEqual(await ids('upcoming'), [future.id]);
    assert.deepEqual(await ids('cancelled'), [cancelled.id]);

    // The narrowed queries and the tagged full list must never disagree — they
    // are two encodings of one rule (SQL and TypeScript) and this is the seam.
    const all = await listCustomerBookings(db, fx.customerIds[0]!, when);
    for (const category of ['upcoming', 'past', 'cancelled'] as const) {
      assert.deepEqual(
        all.filter((b) => b.category === category).map((b) => b.id).sort(),
        await ids(category),
        `${category}: SQL filter and classifyBooking agree`,
      );
    }
  });

  it('is unfiltered when no category is asked for', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await dayWith(db, 30);
    await book(db, fx, '10:00');
    await book(db, fx, '18:00');

    // Also the regression guard for the parameter binding: the unfiltered
    // statement must reference exactly the parameters it is handed.
    const all = await listCustomerBookings(db, fx.customerIds[0]!, at('13:00'));
    assert.equal(all.length, 2);
  });
});

describe('the customer view reclassifies without a reload', () => {
  const src = read('src/http/public/views/bookings.js');

  it('no longer keys its tabs on status', () => {
    assert.ok(
      !/statuses:\s*\[/.test(src),
      'the status->tab lookup is what pinned a finished booking to Upcoming',
    );
    assert.match(src, /categoryOf\(b\) === tab\.id/);
  });

  it('classifies against the server’s clock, not the device’s', () => {
    assert.match(src, /clockSkewMs/);
    assert.match(src, /Date\.parse\(payload\.serverNow\) - Date\.now\(\)/);
  });

  it('takes the grace period from the API rather than hardcoding the rule', () => {
    assert.match(src, /payload\.historyGraceMin/);
  });

  it('arms one timer for the next threshold instead of polling', () => {
    assert.match(src, /setTimeout/);
    assert.ok(!/setInterval/.test(src), 'a ticking interval is not needed for a known instant');
    assert.match(src, /0x7fffffff/, 'clamped so a far-future booking does not overflow the timer');
  });

  it('sends a recorded outcome straight to past', () => {
    assert.match(src, /const RESOLVED = new Set\(\['completed', 'no_show'\]\)/);
    assert.match(src, /RESOLVED\.has\(booking\.status\)\) return 'past'/);
  });

  it('only arms the timer for bookings that are still current', () => {
    assert.match(src, /categoryOf\(b\) === 'upcoming'/);
  });

  it('does not act on a view the router has already replaced', () => {
    assert.match(src, /list\.isConnected/);
  });

  it('re-checks when a backgrounded tab comes back', () => {
    assert.match(src, /visibilitychange/);
  });
});
