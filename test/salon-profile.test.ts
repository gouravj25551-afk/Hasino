/**
 * The salon owner's Profile screen, and the row it edits.
 *
 * There is no profile table: this is the `salons` row the customer app already
 * reads for the card and the detail page, which is the whole point — an owner
 * fixing their address is a customer seeing the right address, not a second
 * copy that drifts.
 *
 * Two properties are worth more than the CRUD: an owner can only ever reach
 * their own salon (the routes take no salon id at all), and chairs cannot be
 * lowered under bookings that are already holding them.
 *
 * Needs a real Postgres; skips (does not fail) without one.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type pg from 'pg';

import { businessRoutes } from '../src/http/routes-business.ts';
import { respondToError } from '../src/http/server.ts';
import {
  ChairsBelowBookedError,
  peakFutureChairUsage,
  salonProfile,
  setChairsEveryDay,
  updateSalonProfile,
} from '../src/business/repo.ts';
import { getSalon, listSalons } from '../src/salons/repo.ts';
import { createBooking } from '../src/booking/create.ts';
import { MemorySnapshotCache } from '../src/availability/cache.ts';
import { NOW, at } from './helpers.ts';
import { type Fixture, connect, seed } from './db.ts';

let pool: pg.Pool | null = null;

before(async () => {
  pool = await connect();
});

after(async () => {
  await pool?.end();
});

/** A second salon under a second owner, for the isolation tests. */
async function otherSalon(db: pg.Pool) {
  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (phone, name, email, role)
     VALUES ('+919000000055', 'Other owner', 'other-owner-profile@example.test', 'business') RETURNING id`,
  );
  const salon = await db.query<{ id: string }>(
    `INSERT INTO salons (owner_id, name, address, city, lat, lng, status)
     VALUES ($1, 'Other Salon', 'Elsewhere', 'Pune', 18.52, 73.85, 'active') RETURNING id`,
    [owner.rows[0]!.id],
  );
  return { ownerId: owner.rows[0]!.id, salonId: salon.rows[0]!.id };
}

function captureResponse() {
  const captured = { status: 0, body: null as unknown };
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(payload?: string) {
      captured.body = payload ? JSON.parse(payload) : null;
      (this as { headersSent: boolean }).headersSent = true;
    },
  };
  return { captured, res: res as unknown as ServerResponse };
}

/** Call a business route the way the server does, as a given owner. */
async function callAsOwner(
  db: pg.Pool,
  ownerId: string,
  method: string,
  tail: string[],
  body?: unknown,
) {
  const { captured, res } = captureResponse();
  const req = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    { headers: { 'content-type': 'application/json' } },
  );
  try {
    await businessRoutes(db, req as unknown as IncomingMessage, res, {
      seg: ['api', 'business', ...tail],
      method,
      url: new URL(`http://localhost/api/business/${tail.join('/')}`),
      ownerId,
      cache: new MemorySnapshotCache(),
    });
  } catch (err) {
    respondToError(res, err);
  }
  return captured;
}

describe('salon profile — reads the salon’s own row', () => {
  it('returns the fields the screen shows, and the account it cannot change', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 2 });
    await db.query(
      `UPDATE salons SET description = 'Two chairs since 2019', city = 'Bengaluru',
              area = 'Indiranagar', phone = '+918012345678', email = 'shop@example.test'
        WHERE id = $1`,
      [fx.salonId],
    );

    const profile = await salonProfile(db, fx.salonId);
    assert.equal(profile.name, 'Fixture Salon');
    assert.equal(profile.description, 'Two chairs since 2019');
    assert.equal(profile.city, 'Bengaluru');
    assert.equal(profile.area, 'Indiranagar');
    assert.equal(profile.phone, '+918012345678');
    assert.equal(profile.email, 'shop@example.test', "the salon's contact address");
    assert.equal(profile.chairs, 2, 'one number, because every day runs on two');
    assert.equal(profile.chairsVary, false);
    assert.equal(profile.workingDays, 7);
    // The sign-in identity is reported so the screen can name it, and there is
    // no route that writes it.
    assert.ok('account' in profile);
  });

  it('says when chairs differ by day rather than flattening them', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 3 });
    await db.query(`UPDATE salon_hours SET online_capacity = 1 WHERE salon_id = $1 AND weekday = 0`, [
      fx.salonId,
    ]);

    const profile = await salonProfile(db, fx.salonId);
    assert.equal(profile.chairs, null);
    assert.equal(profile.chairsVary, true, 'a deliberate Sunday difference is not overwritten');
  });
});

describe('salon profile — what the owner saves is what customers see', () => {
  it('writes the same row the customer app reads', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    // Give the fixture the location it will keep, so this test is about the
    // write rather than about a geocoder — changing an address calls one, and
    // a unit test has no business depending on a third party being up.
    await db.query(`UPDATE salons SET address = '12 MG Road', city = 'Bengaluru', area = 'Indiranagar' WHERE id = $1`, [
      fx.salonId,
    ]);

    await updateSalonProfile(db, fx.salonId, {
      name: 'Sharma Hair Studio',
      description: 'Fades, beard work and colour.',
      address: '12 MG Road',
      city: 'Bengaluru',
      area: 'Indiranagar',
      phone: '+918012345678',
      email: 'shop@example.test',
    });

    const customerView = await getSalon(db, fx.salonId);
    assert.equal(customerView!.name, 'Sharma Hair Studio');
    assert.equal(customerView!.address, '12 MG Road');

    const listing = await listSalons(db);
    const card = listing.find((s) => s.id === fx.salonId)!;
    assert.equal(card.name, 'Sharma Hair Studio', 'the salon card updates too');
  });

  it('refuses the empties that would break a listing', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    const base = {
      name: 'Fixture Salon',
      description: null,
      address: 'Somewhere',
      city: 'Bengaluru',
      area: null,
      phone: null,
      email: null,
    };

    await assert.rejects(updateSalonProfile(db, fx.salonId, { ...base, name: '  ' }), /name is required/);
    await assert.rejects(updateSalonProfile(db, fx.salonId, { ...base, address: '' }), /address is required/);
    // City is what the operator's list and the customer's filter run on.
    await assert.rejects(updateSalonProfile(db, fx.salonId, { ...base, city: '' }), /city is required/);
    await assert.rejects(
      updateSalonProfile(db, fx.salonId, { ...base, name: 'x'.repeat(121) }),
      /120 characters/,
    );
  });

  it('leaves the map pin alone when the address did not change', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    await db.query(`UPDATE salons SET city = 'Bengaluru' WHERE id = $1`, [fx.salonId]);
    const before = await db.query<{ lat: number; lng: number }>(
      `SELECT lat, lng FROM salons WHERE id = $1`,
      [fx.salonId],
    );

    // Only the name changes, so nothing is geocoded — a rename must not move a
    // salon on the map, and must not depend on a geocoder being reachable.
    const result = await updateSalonProfile(db, fx.salonId, {
      name: 'Renamed',
      description: null,
      address: 'Somewhere',
      city: 'Bengaluru',
      area: null,
      phone: null,
      email: null,
    });
    assert.equal(result.geocoded, false);

    const after = await db.query<{ lat: number; lng: number }>(
      `SELECT lat, lng FROM salons WHERE id = $1`,
      [fx.salonId],
    );
    assert.deepEqual(after.rows[0], before.rows[0]);
  });

  it('keeps the old pin when the geocoder cannot place the new address', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    await db.query(`UPDATE salons SET city = 'Bengaluru' WHERE id = $1`, [fx.salonId]);
    const before = await db.query<{ lat: number; lng: number }>(
      `SELECT lat, lng FROM salons WHERE id = $1`,
      [fx.salonId],
    );

    // A geocoder that refuses the connection, which is the realistic outage.
    // The edit must still land: refusing an owner's correction because a third
    // party is down would be the worse failure.
    const saved = process.env['GEOCODER_URL'];
    process.env['GEOCODER_URL'] = 'http://127.0.0.1:1';
    try {
      const result = await updateSalonProfile(db, fx.salonId, {
        name: 'Fixture Salon',
        description: null,
        address: 'A brand new street',
        city: 'Bengaluru',
        area: null,
        phone: null,
        email: null,
      });
      assert.equal(result.geocoded, false, 'the caller is told the pin did not move');
    } finally {
      if (saved === undefined) delete process.env['GEOCODER_URL'];
      else process.env['GEOCODER_URL'] = saved;
    }

    const row = await db.query<{ address: string; lat: number; lng: number }>(
      `SELECT address, lat, lng FROM salons WHERE id = $1`,
      [fx.salonId],
    );
    assert.equal(row.rows[0]!.address, 'A brand new street', 'the address was still saved');
    assert.equal(row.rows[0]!.lat, before.rows[0]!.lat, 'and the old pin was kept rather than zeroed');
    assert.equal(row.rows[0]!.lng, before.rows[0]!.lng);
  });
});

describe('salon profile — chairs cannot be pulled out from under bookings', () => {
  it('reports the busiest future slot', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 3, customers: 3 });

    assert.equal((await peakFutureChairUsage(db, fx.salonId, { now: NOW })).peak, 0);

    for (const customerId of fx.customerIds.slice(0, 2)) {
      await createBooking(
        db,
        { salonId: fx.salonId, customerId, serviceIds: [fx.serviceIds['haircut']!], startAt: at('11:00') },
        { now: NOW },
      );
    }
    const busiest = await peakFutureChairUsage(db, fx.salonId, { now: NOW });
    assert.equal(busiest.peak, 2);
    assert.equal(busiest.at?.getTime(), at('11:00').getTime());
  });

  it('refuses to drop below what is already booked, and changes nothing', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 3, customers: 3 });
    for (const customerId of fx.customerIds.slice(0, 3)) {
      await createBooking(
        db,
        { salonId: fx.salonId, customerId, serviceIds: [fx.serviceIds['haircut']!], startAt: at('11:00') },
        { now: NOW },
      );
    }

    await assert.rejects(
      setChairsEveryDay(db, fx.salonId, 2, NOW),
      (err: unknown) => {
        assert.ok(err instanceof ChairsBelowBookedError);
        assert.equal(err.peak, 3);
        return true;
      },
    );

    const unchanged = await salonProfile(db, fx.salonId);
    assert.equal(unchanged.chairs, 3, 'the refusal left the capacity as it was');
  });

  it('allows lowering to exactly what is booked, and raising freely', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 3, customers: 3 });
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

    await setChairsEveryDay(db, fx.salonId, 1, NOW);
    assert.equal((await salonProfile(db, fx.salonId)).chairs, 1);

    await setChairsEveryDay(db, fx.salonId, 5, NOW);
    assert.equal((await salonProfile(db, fx.salonId)).chairs, 5);
  });

  it('ignores bookings that are over, and rejects nonsense values', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 2 });
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

    // A day later, that booking is history and holds no chair.
    const tomorrow = new Date(at('11:00').getTime() + 24 * 3600_000);
    await setChairsEveryDay(db, fx.salonId, 0, tomorrow);
    assert.equal((await salonProfile(db, fx.salonId)).chairs, 0);

    await assert.rejects(setChairsEveryDay(db, fx.salonId, -1, NOW), /whole number/);
    await assert.rejects(setChairsEveryDay(db, fx.salonId, 2.5, NOW), /whole number/);
    await assert.rejects(setChairsEveryDay(db, fx.salonId, 500, NOW), /whole number/);
  });
});

describe('salon profile — one owner, one salon', () => {
  it('serves the profile of whoever is asking, with no salon id in the request', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const mine = await seed(db, { onlineCapacity: 2 });
    const theirs = await otherSalon(db);

    const asMe = await callAsOwner(db, mine.ownerId, 'GET', ['profile']);
    assert.equal(asMe.status, 200);
    assert.equal((asMe.body as { id: string }).id, mine.salonId);

    const asThem = await callAsOwner(db, theirs.ownerId, 'GET', ['profile']);
    assert.equal((asThem.body as { id: string }).id, theirs.salonId, 'each owner sees their own');
  });

  it('an owner’s edit lands on their salon and never on another', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const mine = await seed(db);
    const theirs = await otherSalon(db);

    const out = await callAsOwner(db, theirs.ownerId, 'PUT', ['profile'], {
      name: 'Renamed By Owner B',
      address: 'Elsewhere',
      city: 'Pune',
      // Even naming another salon explicitly changes nothing: the route reads
      // the owner's salon and ignores anything id-shaped in the body.
      salonId: mine.salonId,
      id: mine.salonId,
    });
    assert.equal(out.status, 200);

    const victim = await salonProfile(db, mine.salonId);
    assert.equal(victim.name, 'Fixture Salon', "salon A is untouched by salon B's owner");
    const attacker = await salonProfile(db, theirs.salonId);
    assert.equal(attacker.name, 'Renamed By Owner B');
  });

  it('the chairs route is scoped the same way', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const mine = await seed(db, { onlineCapacity: 3 });
    const theirs = await otherSalon(db);

    const out = await callAsOwner(db, theirs.ownerId, 'PUT', ['chairs'], {
      chairs: 9,
      salonId: mine.salonId,
    });
    assert.equal(out.status, 200);
    assert.equal((await salonProfile(db, mine.salonId)).chairs, 3, "salon A's chairs are unchanged");
  });

  it('refuses an over-lowering through the API with 409, not a silent write', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 2, customers: 2 });

    // Two bookings sharing a slot in the future, on the real clock — the route
    // takes no clock, which is the point.
    const startAt = new Date(Date.now() + 3 * 3600_000);
    for (const customerId of fx.customerIds.slice(0, 2)) {
      await db.query(
        `WITH b AS (
           INSERT INTO bookings (salon_id, customer_id, start_at, end_at, status, amount)
           VALUES ($1, $2, $3, $4, 'booked', 30000) RETURNING id
         )
         INSERT INTO booking_slots (salon_id, slot_start_at, booking_id)
         SELECT $1, $3, b.id FROM b`,
        [fx.salonId, customerId, startAt, new Date(startAt.getTime() + 30 * 60_000)],
      );
    }

    const out = await callAsOwner(db, fx.ownerId, 'PUT', ['chairs'], { chairs: 1 });
    assert.equal(out.status, 409);
    assert.equal((out.body as { code: string }).code, 'CHAIRS_BELOW_BOOKED');
    assert.equal((await salonProfile(db, fx.salonId)).chairs, 2);
  });

  it('the same guard covers the per-day Timings save', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db, { onlineCapacity: 2, customers: 2 });

    const startAt = new Date(Date.now() + 3 * 3600_000);
    const weekday = Number(
      (
        await db.query<{ dow: number }>(
          `SELECT EXTRACT(DOW FROM $1::timestamptz AT TIME ZONE 'Asia/Kolkata')::int AS dow`,
          [startAt],
        )
      ).rows[0]!.dow,
    );
    for (const customerId of fx.customerIds.slice(0, 2)) {
      await db.query(
        `WITH b AS (
           INSERT INTO bookings (salon_id, customer_id, start_at, end_at, status, amount)
           VALUES ($1, $2, $3, $4, 'booked', 30000) RETURNING id
         )
         INSERT INTO booking_slots (salon_id, slot_start_at, booking_id)
         SELECT $1, $3, b.id FROM b`,
        [fx.salonId, customerId, startAt, new Date(startAt.getTime() + 30 * 60_000)],
      );
    }

    // Lowering that weekday to one chair would strand one of them.
    const refused = await callAsOwner(db, fx.ownerId, 'PUT', ['hours', String(weekday)], {
      working: true,
      openAt: '10:00',
      closeAt: '20:00',
      breakStart: null,
      breakEnd: null,
      onlineCapacity: 1,
      slotIntervalMin: 30,
    });
    assert.equal(refused.status, 409);

    // ...and the same save at the capacity they have is fine.
    const ok = await callAsOwner(db, fx.ownerId, 'PUT', ['hours', String(weekday)], {
      working: true,
      openAt: '10:00',
      closeAt: '20:00',
      breakStart: null,
      breakEnd: null,
      onlineCapacity: 2,
      slotIntervalMin: 30,
    });
    assert.equal(ok.status, 200);
  });
});
