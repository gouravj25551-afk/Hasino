/**
 * Spec §8 case 9 — "two concurrent inserts, last seat -> exactly one succeeds",
 * and the rest of createBooking's inside-the-lock re-validation.
 *
 * Needs a real Postgres: the whole point is pg_advisory_xact_lock. Skips (does
 * not fail) when no database is reachable, so `npm test` still works on a
 * machine without one.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';

import { createBooking } from '../src/booking/create.ts';
import { InvalidStartError, SalonUnavailableError, SlotUnavailableError } from '../src/booking/errors.ts';
import { getAvailability } from '../src/availability/service.ts';
import { MemorySnapshotCache } from '../src/availability/cache.ts';
import { loadCart } from '../src/availability/repo.ts';
import { DATE, NOW, at, times } from './helpers.ts';
import { type Fixture, connect, seed, slotHolders } from './db.ts';

let pool: pg.Pool | null = null;

before(async () => {
  pool = await connect();
});

after(async () => {
  await pool?.end();
});

describe('booking create — concurrency (spec §8 case 9)', () => {
  it('9. two concurrent inserts for the last seat -> exactly one succeeds', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx: Fixture = await seed(db, { onlineCapacity: 1 });
    const startAt = at('11:00');

    const attempts = [0, 1].map(() =>
      createBooking(
        db,
        {
          salonId: fx.salonId,
          customerId: fx.customerIds[0]!,
          serviceIds: [fx.serviceIds['haircut']!],
          startAt,
        },
        { now: NOW },
      ),
    );

    const results = await Promise.allSettled(attempts);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    assert.equal(ok.length, 1, 'exactly one booking may take the last chair');
    assert.equal(failed.length, 1);
    assert.ok(
      (failed[0] as PromiseRejectedResult).reason instanceof SlotUnavailableError,
      'the loser gets SLOT_UNAVAILABLE, not a constraint violation',
    );

    assert.equal(await slotHolders(db, fx.salonId, startAt), 1);
  });

  it('9b. 16 concurrent inserts against 3 chairs -> exactly 3 succeed', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    // The two-way race can pass by luck if the lock is removed. Sixteen cannot.
    const fx = await seed(db, { onlineCapacity: 3, customers: 16 });
    const startAt = at('11:00');

    const results = await Promise.allSettled(
      fx.customerIds.map((customerId) =>
        createBooking(
          db,
          { salonId: fx.salonId, customerId, serviceIds: [fx.serviceIds['haircut']!], startAt },
          { now: NOW },
        ),
      ),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 3, `expected 3 winners, got ${ok.length}`);
    assert.ok(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => (r as PromiseRejectedResult).reason instanceof SlotUnavailableError),
    );
    assert.equal(await slotHolders(db, fx.salonId, startAt), 3);
  });

  it('9c. a multi-slot booking loses if any one of its slots is taken', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    // 50-min haircut + 10 buffer = 60 = two slots; 20-min trim + 10 = one slot
    const fx = await seed(db, {
      onlineCapacity: 1,
      customers: 2,
      services: [
        { name: 'haircut', durationMin: 50, price: 30_000, bufferMin: 10 },
        { name: 'trim', durationMin: 20, price: 20_000, bufferMin: 10 },
      ],
    });

    // The trim takes 11:30 — the *second* slot of a haircut starting at 11:00.
    await createBooking(
      db,
      {
        salonId: fx.salonId,
        customerId: fx.customerIds[0]!,
        serviceIds: [fx.serviceIds['trim']!],
        startAt: at('11:30'),
      },
      { now: NOW },
    );

    await assert.rejects(
      createBooking(
        db,
        {
          salonId: fx.salonId,
          customerId: fx.customerIds[1]!,
          serviceIds: [fx.serviceIds['haircut']!],
          startAt: at('11:00'),
        },
        { now: NOW },
      ),
      SlotUnavailableError,
      '11:00 itself is free, but the booking needs 11:30 too',
    );
  });
});

describe('booking create — re-validated inside the lock', () => {
  it('rejects a start time that is not on the grid', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    await assert.rejects(
      createBooking(
        db,
        {
          salonId: fx.salonId,
          customerId: fx.customerIds[0]!,
          serviceIds: [fx.serviceIds['haircut']!],
          startAt: at('11:07'),
        },
        { now: NOW },
      ),
      InvalidStartError,
    );
  });

  it('rejects a booking that would run past closing', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, {
      onlineCapacity: 1,
      services: [{ name: 'haircut', durationMin: 50, price: 30_000, bufferMin: 10 }],
    });
    // salon closes 13:00; 12:30 + 60 min = 13:30
    await assert.rejects(
      createBooking(
        db,
        {
          salonId: fx.salonId,
          customerId: fx.customerIds[0]!,
          serviceIds: [fx.serviceIds['haircut']!],
          startAt: at('12:30'),
        },
        { now: NOW },
      ),
      InvalidStartError,
    );
  });

  it('rejects a booking that would cross the lunch break', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, {
      onlineCapacity: 1,
      closeAt: '19:00',
      breakStart: '13:00',
      breakEnd: '14:00',
      services: [{ name: 'haircut', durationMin: 50, price: 30_000, bufferMin: 10 }],
    });
    await assert.rejects(
      createBooking(
        db,
        {
          salonId: fx.salonId,
          customerId: fx.customerIds[0]!,
          serviceIds: [fx.serviceIds['haircut']!],
          startAt: at('12:30'),
        },
        { now: NOW },
      ),
      InvalidStartError,
    );
    // ...but 12:00 ends exactly at the break and is fine
    const ok = await createBooking(
      db,
      {
        salonId: fx.salonId,
        customerId: fx.customerIds[0]!,
        serviceIds: [fx.serviceIds['haircut']!],
        startAt: at('12:00'),
      },
      { now: NOW },
    );
    assert.equal(ok.slots.length, 2);
  });

  it('rejects a booking on a holiday', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1, holidays: [DATE] });
    await assert.rejects(
      createBooking(
        db,
        {
          salonId: fx.salonId,
          customerId: fx.customerIds[0]!,
          serviceIds: [fx.serviceIds['haircut']!],
          startAt: at('11:00'),
        },
        { now: NOW },
      ),
      SalonUnavailableError,
    );
  });

  it('rejects a start less than 15 minutes away', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    await assert.rejects(
      createBooking(
        db,
        {
          salonId: fx.salonId,
          customerId: fx.customerIds[0]!,
          serviceIds: [fx.serviceIds['haircut']!],
          startAt: at('11:00'),
        },
        { now: at('10:50') },
      ),
      InvalidStartError,
    );
  });

  it('writes one booking_slots row per occupied slot and snapshots the price', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, {
      onlineCapacity: 1,
      services: [{ name: 'haircut', durationMin: 50, price: 30_000, bufferMin: 10 }],
    });
    const booking = await createBooking(
      db,
      {
        salonId: fx.salonId,
        customerId: fx.customerIds[0]!,
        serviceIds: [fx.serviceIds['haircut']!],
        startAt: at('11:00'),
      },
      { now: NOW },
    );

    assert.deepEqual(times(booking.slots), ['11:00', '11:30']);
    assert.equal(booking.amount, 30_000);
    // end_at is the service window the customer sees, not the buffered chair time
    assert.equal(booking.endAt.getTime() - booking.startAt.getTime(), 50 * 60_000);

    const rows = await db.query(`SELECT * FROM booking_slots WHERE booking_id = $1`, [booking.id]);
    assert.equal(rows.rowCount, 2);

    // a later price change must not rewrite history
    await db.query(`UPDATE salon_services SET price = 99_999 WHERE salon_id = $1`, [fx.salonId]);
    const item = await db.query<{ price: number }>(
      `SELECT price FROM booking_items WHERE booking_id = $1`,
      [booking.id],
    );
    assert.equal(item.rows[0]!.price, 30_000);
  });
});

describe('availability reads what booking create wrote', () => {
  it('round-trips a booking through the 7-day availability window', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const cart = await loadCart(db, fx.salonId, [fx.serviceIds['haircut']!]);

    const before = await getAvailability(db, fx.salonId, cart, { now: NOW });
    assert.deepEqual(times(before!.days[0]!.full), ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30']);

    await createBooking(
      db,
      {
        salonId: fx.salonId,
        customerId: fx.customerIds[0]!,
        serviceIds: [fx.serviceIds['haircut']!],
        startAt: at('11:00'),
      },
      { now: NOW },
    );

    const after = await getAvailability(db, fx.salonId, cart, { now: NOW });
    assert.deepEqual(times(after!.days[0]!.full), ['10:00', '10:30', '11:30', '12:00', '12:30']);
  });

  it('counts real bookings down against the salon chair by chair', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 3, customers: 4 });
    const cart = await loadCart(db, fx.salonId, [fx.serviceIds['haircut']!]);
    const startAt = at('11:00');
    const slotFor = (a: Awaited<ReturnType<typeof getAvailability>>) =>
      a!.days[0]!.slots.find((s) => s.at.getTime() === startAt.getTime())!;

    const empty = await getAvailability(db, fx.salonId, cart, { now: NOW });
    assert.equal(empty!.days[0]!.capacity, 3);
    assert.equal(slotFor(empty).remaining, 3);

    // Two customers take the same half hour. The salon has three chairs, so
    // the slot is still open — this is the case a "3 bookings a day" reading
    // would get wrong.
    for (const customerId of fx.customerIds.slice(0, 2)) {
      await createBooking(
        db,
        { salonId: fx.salonId, customerId, serviceIds: [fx.serviceIds['haircut']!], startAt },
        { now: NOW },
      );
    }

    const partly = await getAvailability(db, fx.salonId, cart, { now: NOW });
    assert.equal(slotFor(partly).remaining, 1);
    assert.equal(slotFor(partly).state, 'limited');
    assert.ok(times(partly!.days[0]!.full).includes('11:00'), 'one chair left is still bookable');
    // The rest of the day is untouched by those two bookings.
    assert.equal(
      partly!.days[0]!.slots.find((s) => s.at.getTime() === at('11:30').getTime())!.remaining,
      3,
    );

    const third = await createBooking(
      db,
      {
        salonId: fx.salonId,
        customerId: fx.customerIds[2]!,
        serviceIds: [fx.serviceIds['haircut']!],
        startAt,
      },
      { now: NOW },
    );

    const soldOut = await getAvailability(db, fx.salonId, cart, { now: NOW });
    assert.equal(slotFor(soldOut).remaining, 0);
    assert.equal(slotFor(soldOut).state, 'full');
    assert.ok(!times(soldOut!.days[0]!.full).includes('11:00'));
    await assert.rejects(
      createBooking(
        db,
        {
          salonId: fx.salonId,
          customerId: fx.customerIds[3]!,
          serviceIds: [fx.serviceIds['haircut']!],
          startAt,
        },
        { now: NOW },
      ),
      SlotUnavailableError,
      'the fourth customer cannot have a fourth chair',
    );

    // A cancellation gives the chair back. Nothing deletes booking_slots — the
    // status is what stops the row counting (see booking/occupancy.ts) — so
    // this is also the assertion that those two agree.
    await db.query(`UPDATE bookings SET status = 'cancelled_by_customer' WHERE id = $1`, [third.id]);
    const freed = await getAvailability(db, fx.salonId, cart, { now: NOW });
    assert.equal(slotFor(freed).remaining, 1);
    assert.equal(slotFor(freed).state, 'limited');
    assert.equal(await slotHolders(db, fx.salonId, startAt), 2);
  });

  it('createBooking invalidates the snapshot cache', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 1 });
    const cache = new MemorySnapshotCache();
    const cart = await loadCart(db, fx.salonId, [fx.serviceIds['haircut']!]);

    await getAvailability(db, fx.salonId, cart, { now: NOW, cache }); // warms it
    await createBooking(
      db,
      {
        salonId: fx.salonId,
        customerId: fx.customerIds[0]!,
        serviceIds: [fx.serviceIds['haircut']!],
        startAt: at('11:00'),
      },
      { now: NOW, cache },
    );

    const after = await getAvailability(db, fx.salonId, cart, { now: NOW, cache });
    assert.ok(!times(after!.days[0]!.full).includes('11:00'), 'stale cache would still show 11:00');
  });

  it('the cached snapshot is cart-independent', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    // Caching a computed slot list under avail:{salon_id} would serve the
    // short cart's start times to the long cart. Same warm cache, two carts.
    const fx = await seed(db, {
      onlineCapacity: 1,
      services: [
        { name: 'trim', durationMin: 20, price: 20_000, bufferMin: 10 },
        { name: 'haircut', durationMin: 50, price: 30_000, bufferMin: 10 },
      ],
    });
    const cache = new MemorySnapshotCache();
    const short = await loadCart(db, fx.salonId, [fx.serviceIds['trim']!]);
    const long = await loadCart(db, fx.salonId, [fx.serviceIds['haircut']!]);

    const shortResult = await getAvailability(db, fx.salonId, short, { now: NOW, cache });
    const longResult = await getAvailability(db, fx.salonId, long, { now: NOW, cache });

    assert.deepEqual(times(shortResult!.days[0]!.full), [
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '12:00',
      '12:30',
    ]);
    assert.deepEqual(
      times(longResult!.days[0]!.full),
      ['10:00', '10:30', '11:00', '11:30', '12:00'],
      '12:30 cannot hold a 60-min cart even though the cache was warmed by a 30-min one',
    );
  });
});
