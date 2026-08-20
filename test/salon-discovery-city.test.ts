/**
 * Salon discovery is scoped to the customer's current city.
 *
 * The rule this file exists to hold: a customer in Jind sees the salons in
 * Jind, and when there are none they see nothing — not the nearest town's
 * salons, not every salon on the platform. A card a customer cannot travel to
 * is worse than an empty screen, because they only find out after picking a
 * time.
 *
 * The filter lives in SQL, so that is where it is asserted, and again over a
 * real HTTP request: "the API returns only this city" is the property that
 * makes the browser's copy of the rule a presentation detail rather than the
 * enforcement. A client that drops the parameter must get a *smaller* list,
 * never a wider one.
 *
 * Needs a real Postgres; skips (does not fail) without one.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';

import { listSalons, normalizeCity } from '../src/salons/repo.ts';
import { buildServer } from '../src/http/server.ts';
import { connect, seed } from './db.ts';

let pool: pg.Pool | null = null;

before(async () => {
  pool = await connect();
});

after(async () => {
  await pool?.end();
});

/**
 * An active salon in a given city, under its own owner.
 *
 * A fresh owner per salon because salons_one_per_owner is a unique index —
 * reusing the fixture owner would fail the insert rather than the assertion.
 */
let counter = 0;
async function salonIn(db: pg.Pool, city: string, name: string): Promise<string> {
  counter += 1;
  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (phone, name, email, role)
     VALUES ($1, $2, $3, 'business') RETURNING id`,
    [`+9190000000${String(counter).padStart(2, '0')}`, `${name} owner`, `owner-${counter}-city@example.test`],
  );
  const salon = await db.query<{ id: string }>(
    `INSERT INTO salons (owner_id, name, address, city, lat, lng, status)
     VALUES ($1, $2, $3, $4, 29.31, 76.31, 'active') RETURNING id`,
    [owner.rows[0]!.id, name, `Main road, ${city}`, city],
  );
  return salon.rows[0]!.id;
}

/**
 * Three towns, spelled three different ways on purpose.
 *
 * The casing is not decoration: salons already onboarded carry whatever the
 * owner typed into the form, and the city on a request comes from a geocoder.
 * If matching were case-sensitive the live rows — which are lowercase — would
 * vanish the moment a customer's geocoder said "Jind".
 */
async function threeTowns(db: pg.Pool) {
  await seed(db);
  return {
    jind: await salonIn(db, 'jind', 'Jind Salon'),
    sonipatA: await salonIn(db, 'Sonipat', 'Sonipat Salon A'),
    sonipatB: await salonIn(db, 'SONIPAT', 'Sonipat Salon B'),
  };
}

describe('normalizeCity', () => {
  it('folds case and stray whitespace into one key', () => {
    for (const spelling of ['Jind', 'jind', 'JIND', '  Jind  ', 'Jind\t']) {
      assert.equal(normalizeCity(spelling), 'jind', `${JSON.stringify(spelling)} is Jind`);
    }
    assert.equal(normalizeCity('new  delhi'), 'new delhi');
  });

  it('does not fold two different towns together', () => {
    // The whole failure mode in one assertion: any rule loose enough to make
    // these equal is loose enough to show a Sonipat salon to a customer in
    // Jind. There is no partial matching here and there must never be.
    assert.notEqual(normalizeCity('Jind'), normalizeCity('Sonipat'));
    assert.notEqual(normalizeCity('Jind'), normalizeCity('Jindal'));
  });

  it('treats an empty or missing name as no city', () => {
    for (const empty of ['', '   ', null, undefined]) {
      assert.equal(normalizeCity(empty), null);
    }
  });
});

describe('listSalons — city is a filter, not a ranking', () => {
  it('returns only the salons in the requested city', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const ids = await threeTowns(db);

    const inSonipat = await listSalons(db, undefined, { city: 'Sonipat' });
    assert.deepEqual(
      inSonipat.map((s) => s.id).sort(),
      [ids.sonipatA, ids.sonipatB].sort(),
      'both Sonipat salons, and nothing from Jind',
    );
    for (const s of inSonipat) assert.equal(normalizeCity(s.city), 'sonipat');
  });

  it('matches a city whatever case either side was typed in', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const ids = await threeTowns(db);

    // The stored row is 'jind'; the customer's geocoder says 'Jind'.
    for (const spelling of ['Jind', 'jind', 'JIND', '  Jind ']) {
      const found = await listSalons(db, undefined, { city: spelling });
      assert.deepEqual(found.map((s) => s.id), [ids.jind], `${spelling} finds the Jind salon`);
    }
  });

  it('returns nothing — not a nearby city — when the city is empty', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await threeTowns(db);

    // Rohtak has no salons. Sonipat and Jind both do. The correct answer is
    // the empty list; anything else is the fallback this rule forbids.
    assert.deepEqual(await listSalons(db, undefined, { city: 'Rohtak' }), []);
    assert.deepEqual(await listSalons(db, undefined, { city: 'Delhi' }), []);
  });

  it('does not let a prefix of one city reach another', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await threeTowns(db);

    // 'Son' is a prefix of Sonipat and 'Jin' of Jind. Under any LIKE-based
    // match these would return salons; under equality they return none.
    assert.deepEqual(await listSalons(db, undefined, { city: 'Son' }), []);
    assert.deepEqual(await listSalons(db, undefined, { city: 'Jin' }), []);
    assert.deepEqual(await listSalons(db, undefined, { city: 'Sonipat district' }), []);
  });

  it('excludes a salon that has no city of its own', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const ids = await threeTowns(db);
    // seed()'s fixture salon is onboarded without a city. It cannot be
    // claimed for Jind — an unknown location is not this location.
    const found = await listSalons(db, undefined, { city: 'Jind' });
    assert.deepEqual(found.map((s) => s.id), [ids.jind]);
  });

  it('still lists everywhere when no city is given', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const ids = await threeTowns(db);
    // The visitor who has not chosen a location yet. This is the one path
    // that is not scoped, and it is not a fallback: nothing routes here
    // because a city came back empty.
    const all = (await listSalons(db)).map((s) => s.id);
    for (const id of [ids.jind, ids.sonipatA, ids.sonipatB]) assert.ok(all.includes(id));
  });

  it('composes with search and category rather than replacing them', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const ids = await threeTowns(db);

    // A name that exists in Sonipat, searched from Jind: the city wins.
    assert.deepEqual(await listSalons(db, 'Sonipat Salon', { city: 'Jind' }), []);
    assert.deepEqual(
      (await listSalons(db, 'Sonipat Salon A', { city: 'Sonipat' })).map((s) => s.id),
      [ids.sonipatA],
    );
  });

  it('keeps a suspended salon out of its own city', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const ids = await threeTowns(db);
    await db.query(`UPDATE salons SET status = 'suspended' WHERE id = $1`, [ids.sonipatA]);

    const found = await listSalons(db, undefined, { city: 'Sonipat' });
    assert.deepEqual(found.map((s) => s.id), [ids.sonipatB], 'city does not override status');
  });
});

describe('GET /api/salons — the filter is enforced over the wire', () => {
  it('serves one city per request, and an empty array for a city with none', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const ids = await threeTowns(db);

    const server = buildServer(db);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const get = async (query: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/salons${query}`);
      assert.equal(res.status, 200, query);
      const body = (await res.json()) as { salons: Array<{ id: string; city: string | null }> };
      return body.salons;
    };

    try {
      // Jind: one salon, and no sign of the two in Sonipat.
      const jind = await get('?city=Jind');
      assert.deepEqual(jind.map((s) => s.id), [ids.jind]);

      // Switching city switches the list — the whole of it, both ways.
      const sonipat = await get('?city=Sonipat');
      assert.deepEqual(sonipat.map((s) => s.id).sort(), [ids.sonipatA, ids.sonipatB].sort());
      assert.deepEqual(await get('?city=Jind'), jind, 'and back again');

      // A city Hasino has not reached. The response is empty, not the
      // neighbouring town's salons — the client is never handed a card it
      // would then have to hide.
      assert.deepEqual(await get('?city=Rohtak'), []);

      // Coordinates order the results; they never widen them. A customer in
      // Jind sitting closer to a Sonipat salon still gets Jind.
      const withCoords = await get('?city=Jind&lat=29.31&lng=76.31');
      assert.deepEqual(withCoords.map((s) => s.id), [ids.jind]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
