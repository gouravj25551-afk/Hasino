/**
 * Deleting your own account.
 *
 * The row is anonymised, not removed: bookings, payments and reviews reference
 * it as a NOT NULL customer_id and must add up. A salon owner is refused. And
 * with the identity link cleared, no future sign-in can resolve to or claim the
 * deleted row — signing in again mints a fresh account.
 *
 * Needs a real Postgres; skips (does not fail) without one.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import type pg from 'pg';

import { AccountDeletionBlockedError, deleteOwnAccount } from '../src/auth/account.ts';
import { resolveSession } from '../src/auth/session.ts';
import { addFavorite } from '../src/salons/repo.ts';
import { saveStagedImage } from '../src/salons/images.ts';
import { connect, reset, seed } from './db.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let pool: pg.Pool | null = null;
before(async () => { pool = await connect(); });
after(async () => { await pool?.end(); });

async function customer(db: pg.Pool, provider: string, email: string) {
  const res = await db.query<{ id: string }>(
    `INSERT INTO users (auth_provider_id, name, email, avatar_url, phone, role)
     VALUES ($1, 'Priya', $2, 'https://x/y.jpg', $3, 'customer') RETURNING id`,
    [provider, email, `+9199${Math.floor(Math.random() * 1e8)}`],
  );
  return res.rows[0]!.id;
}

const token = (provider: string, email: string) => ({
  uid: provider,
  email,
  emailVerified: true,
  name: 'Priya',
  picture: 'https://x/y.jpg',
});

describe('deleting a customer account', () => {
  it('anonymises the row and purges personal data, keeping bookings', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db); // gives us a salon to favourite and book against
    const me = await customer(db, 'clerk|me', 'me@example.test');

    await addFavorite(db, me, fx.salonId);
    await db.query(
      `INSERT INTO notifications (user_id, channel, template, to_address)
       VALUES ($1, 'email', 'welcome', 'me@example.test')`,
      [me],
    );
    await saveStagedImage(db, me, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 1)]));
    // A booking is a record that must survive the deletion.
    const booking = await db.query<{ id: string }>(
      `INSERT INTO bookings (salon_id, customer_id, start_at, end_at, status, amount, verify_code)
       VALUES ($1, $2, now(), now() + interval '30 min', 'completed', 20000, '123456') RETURNING id`,
      [fx.salonId, me],
    );

    await deleteOwnAccount(db, me);

    const row = await db.query<{
      name: string | null; email: string | null; avatar_url: string | null;
      phone: string | null; auth_provider_id: string | null; deleted_at: Date | null;
    }>(`SELECT name, email, avatar_url, phone, auth_provider_id, deleted_at FROM users WHERE id = $1`, [me]);
    const u = row.rows[0]!;
    assert.equal(u.name, null);
    assert.equal(u.email, null);
    assert.equal(u.avatar_url, null);
    assert.equal(u.phone, null);
    assert.equal(u.auth_provider_id, null, 'no token can ever resolve to this row again');
    assert.ok(u.deleted_at, 'marked deleted');

    // Personal data gone.
    assert.equal((await db.query(`SELECT 1 FROM favorites WHERE user_id = $1`, [me])).rowCount, 0);
    assert.equal((await db.query(`SELECT 1 FROM notifications WHERE user_id = $1`, [me])).rowCount, 0);
    assert.equal((await db.query(`SELECT 1 FROM salon_image_uploads WHERE user_id = $1`, [me])).rowCount, 0);

    // The record kept.
    const b = await db.query(`SELECT 1 FROM bookings WHERE id = $1`, [booking.rows[0]!.id]);
    assert.equal(b.rowCount, 1, 'the salon’s booking record survives');
  });

  it('signing in again mints a fresh account, not the deleted one', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'clerk|me', 'me@example.test');
    await deleteOwnAccount(db, me);

    // Same Clerk identity signs in again.
    const session = await resolveSession(db, token('clerk|me', 'me@example.test') as never);
    assert.notEqual(session.userId, me, 'a brand-new row, not the anonymised one');
    assert.equal(session.role, 'customer');

    const deleted = await db.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM users WHERE id = $1`, [me],
    );
    assert.ok(deleted.rows[0]!.deleted_at, 'the old row stays deleted and unreached');
  });

  it('is idempotent — deleting an already-deleted account changes nothing more', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'clerk|me', 'me@example.test');
    await deleteOwnAccount(db, me);
    await assert.doesNotReject(deleteOwnAccount(db, me));
  });
});

describe('deleting a salon owner account', () => {
  it('is refused — the salon must be closed or moved by support first', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db); // seed()'s owner owns fx.salonId

    await assert.rejects(deleteOwnAccount(db, fx.ownerId), (err: unknown) => {
      assert.ok(err instanceof AccountDeletionBlockedError);
      assert.equal((err as AccountDeletionBlockedError).code, 'OWNS_SALON');
      return true;
    });

    // Nothing was touched.
    const owner = await db.query<{ name: string | null; deleted_at: Date | null }>(
      `SELECT name, deleted_at FROM users WHERE id = $1`, [fx.ownerId],
    );
    assert.equal(owner.rows[0]!.name, 'Owner', 'the owner row is intact');
    assert.equal(owner.rows[0]!.deleted_at, null, 'and not marked deleted');
    assert.equal((await db.query(`SELECT 1 FROM salons WHERE id = $1`, [fx.salonId])).rowCount, 1);
  });
});

describe('account deletion — wiring', () => {
  it('DELETE /api/me is mounted and maps the block to a 409', () => {
    const server = read('src/http/server.ts');
    assert.match(server, /method === 'DELETE' && path === '\/api\/me'/);
    assert.match(server, /deleteOwnAccount\(db, s\.userId\)/);
    assert.match(server, /AccountDeletionBlockedError/);
  });

  it('the customer profile offers deletion behind a typed confirmation', () => {
    const profile = read('src/http/public/views/profile.js');
    assert.match(profile, /Delete account/);
    assert.match(profile, /Type DELETE to confirm/);
    assert.match(profile, /api\('\/api\/me', \{ method: 'DELETE' \}\)/);
    assert.match(profile, /app\.signOut\(\)/, 'logs out on success');
  });
});
