/**
 * Saved salons, at the source of truth.
 *
 * The heart in the UI is optimistic paint over these functions; what actually
 * makes a favorite survive a refresh, a logout and a different device is the
 * favorites table and the queries below. So this tests them directly against a
 * real database rather than asserting on source text: persistence, per-user
 * isolation, the unique (user_id, salon_id) key, and the newest-first order the
 * saved screen relies on.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';

import {
  addFavorite,
  listFavorites,
  listFavoriteSalons,
  removeFavorite,
} from '../src/salons/repo.ts';
import { connect, seed } from './db.ts';

const pool = await connect();
const run = pool ? describe : describe.skip;

run('saved salons', () => {
  let salonA = '';
  let salonB = '';
  let custA = '';
  let custB = '';

  before(async () => {
    // One salon from the fixture, a second inserted alongside it so ordering
    // and cross-salon isolation have something to be about.
    const fx = await seed(pool!, { customers: 2 });
    salonA = fx.salonId;
    custA = fx.customerIds[0]!;
    custB = fx.customerIds[1]!;
    // A second salon needs a second owner: salons_one_per_owner allows one each.
    const owner2 = await pool!.query<{ id: string }>(
      `INSERT INTO users (phone, name, role) VALUES ('+910000000001', 'Owner Two', 'business') RETURNING id`,
    );
    const row = await pool!.query<{ id: string }>(
      `INSERT INTO salons (owner_id, name, address, lat, lng, timezone, status)
       VALUES ($1, 'Second Salon', 'Elsewhere', 12.98, 77.60, 'Asia/Kolkata', 'active')
       RETURNING id`,
      [owner2.rows[0]!.id],
    );
    salonB = row.rows[0]!.id;
  });

  after(async () => { await pool!.end(); });

  it('records a favorite for exactly the customer who saved it', async () => {
    await addFavorite(pool!, custA, salonA);
    assert.deepEqual(await listFavorites(pool!, custA), [salonA]);
    // Customer B saved nothing, so B sees nothing — favorites are not shared.
    assert.deepEqual(await listFavorites(pool!, custB), []);
  });

  it('survives being read again — it lives in the table, not in memory', async () => {
    // A second independent query is the persistence guarantee the UI leans on:
    // a refresh or a new login is just another SELECT against this row.
    assert.deepEqual(await listFavorites(pool!, custA), [salonA]);
  });

  it('never stores a duplicate, even when saved twice', async () => {
    await addFavorite(pool!, custA, salonA);
    await addFavorite(pool!, custA, salonA);
    assert.deepEqual(await listFavorites(pool!, custA), [salonA], 'still one entry');
    const { rows } = await pool!.query<{ n: string }>(
      `SELECT count(*)::int8 AS n FROM favorites WHERE user_id = $1 AND salon_id = $2`,
      [custA, salonA],
    );
    assert.equal(Number(rows[0]!.n), 1, 'exactly one row in the table');
  });

  it('returns the most recently saved salon first', async () => {
    await addFavorite(pool!, custA, salonB);
    // Pin the timestamps so the DESC order is deterministic rather than racing
    // on microseconds: A saved earlier, B saved later.
    await pool!.query(`UPDATE favorites SET created_at = now() - interval '1 hour' WHERE user_id=$1 AND salon_id=$2`, [custA, salonA]);
    await pool!.query(`UPDATE favorites SET created_at = now()               WHERE user_id=$1 AND salon_id=$2`, [custA, salonB]);

    assert.deepEqual(await listFavorites(pool!, custA), [salonB, salonA], 'ids newest first');

    const cards = await listFavoriteSalons(pool!, custA);
    assert.deepEqual(cards.map((s) => s.id), [salonB, salonA], 'cards newest first');
    // The cards are full summaries, not bare ids — the saved screen renders them.
    assert.equal(cards[0]!.name, 'Second Salon');
    assert.ok('openNow' in cards[0]! && 'rating' in cards[0]!, 'summary shape');
  });

  it('unfavoriting removes it and the removal persists', async () => {
    await removeFavorite(pool!, custA, salonA);
    const ids = await listFavorites(pool!, custA);
    assert.ok(!ids.includes(salonA), 'gone from the list');
    assert.deepEqual(ids, [salonB], 'only the still-saved one remains');
    // Re-read: a refresh keeps it removed.
    assert.deepEqual((await listFavoriteSalons(pool!, custA)).map((s) => s.id), [salonB]);
  });

  it('keeps each customer’s list to themselves throughout', async () => {
    await addFavorite(pool!, custB, salonA);
    assert.deepEqual(await listFavorites(pool!, custB), [salonA], 'B has only what B saved');
    assert.deepEqual(await listFavorites(pool!, custA), [salonB], 'A is unchanged by B');
  });
});
