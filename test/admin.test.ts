/**
 * Admin elevation.
 *
 * ADMIN_EMAILS is the single source of truth for who is an admin, re-derived
 * on every sign-in in both directions. The tests that matter are the ones
 * where the answer is "no": an unverified email claim, an address that has
 * been removed from the list, and a role arriving from anywhere other than
 * that list.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type pg from 'pg';

import { requireRole, resolveSession } from '../src/auth/session.ts';
import { AuthError, type VerifiedToken } from '../src/auth/verifier.ts';
import { connect, reset } from './db.ts';

let pool: pg.Pool | null = null;
before(async () => { pool = await connect(); });
after(async () => { await pool?.end(); });

const ORIGINAL_ADMIN_EMAILS = process.env['ADMIN_EMAILS'];
afterEach(() => {
  if (ORIGINAL_ADMIN_EMAILS === undefined) delete process.env['ADMIN_EMAILS'];
  else process.env['ADMIN_EMAILS'] = ORIGINAL_ADMIN_EMAILS;
});

const token = (t: Partial<VerifiedToken> & { uid: string }): VerifiedToken => ({ ...t });

async function roleOf(db: pg.Pool, userId: string): Promise<string> {
  const r = await db.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [userId]);
  return r.rows[0]!.role;
}

describe('ADMIN_EMAILS elevation', () => {
  it('elevates a verified email that is in the list', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    process.env['ADMIN_EMAILS'] = 'boss@hasino.in';

    const s = await resolveSession(
      db,
      token({ uid: 'fb-boss', phone: '+919800000001', email: 'boss@hasino.in', emailVerified: true }),
    );
    assert.equal(s.role, 'admin');
    assert.equal(await roleOf(db, s.userId), 'admin', 'the column is a cache of the env var');
  });

  it('does NOT elevate an unverified email, even if it is in the list', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    process.env['ADMIN_EMAILS'] = 'boss@hasino.in';

    // An unverified claim is a string the signer-up chose. If this elevated,
    // ADMIN_EMAILS would be a list of addresses anyone may assert.
    const s = await resolveSession(
      db,
      token({ uid: 'fb-liar', phone: '+919800000002', email: 'boss@hasino.in', emailVerified: false }),
    );
    assert.equal(s.role, 'customer');
  });

  it('does NOT elevate when the token carries no emailVerified at all', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    process.env['ADMIN_EMAILS'] = 'boss@hasino.in';

    const s = await resolveSession(db, token({ uid: 'fb-x', phone: '+919800000003', email: 'boss@hasino.in' }));
    assert.equal(s.role, 'customer');
  });

  it('demotes a stored admin once the address leaves the list', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);

    process.env['ADMIN_EMAILS'] = 'boss@hasino.in';
    const first = await resolveSession(
      db,
      token({ uid: 'fb-boss', phone: '+919800000004', email: 'boss@hasino.in', emailVerified: true }),
    );
    assert.equal(first.role, 'admin');

    // Removed from the env var. A sticky admin row that outlives its entry is
    // exactly the thing that gets forgotten and then exploited.
    process.env['ADMIN_EMAILS'] = 'someone-else@hasino.in';
    const second = await resolveSession(
      db,
      token({ uid: 'fb-boss', phone: '+919800000004', email: 'boss@hasino.in', emailVerified: true }),
    );
    assert.equal(second.role, 'customer');
    assert.equal(await roleOf(db, second.userId), 'customer');
  });

  it('compares case-insensitively and ignores surrounding whitespace', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    process.env['ADMIN_EMAILS'] = '  Boss@Hasino.IN , other@x.com ';

    const s = await resolveSession(
      db,
      token({ uid: 'fb-case', phone: '+919800000005', email: 'BOSS@hasino.in', emailVerified: true }),
    );
    assert.equal(s.role, 'admin');
  });

  it('never elevates from a role claim on the token', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    process.env['ADMIN_EMAILS'] = '';

    const s = await resolveSession(
      db,
      { uid: 'fb-evil', phone: '+919800000006', email: 'evil@x.com', emailVerified: true,
        ...({ role: 'admin', admin: true } as object) } as VerifiedToken,
    );
    assert.equal(s.role, 'customer');
  });

  it('leaves a salon owner alone — demotion is admin-only', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    process.env['ADMIN_EMAILS'] = 'boss@hasino.in';

    // An admin onboarded this owner: role set, no firebase_uid yet.
    await db.query(
      `INSERT INTO users (phone, name, email, role) VALUES ($1, $2, $3, 'business')`,
      ['+919888888888', 'Rahul', 'rahul@example.com'],
    );

    // Their first Google sign-in must adopt the row and keep 'business'. If the
    // demotion rule reached past 'admin', this is where owner onboarding would
    // silently break.
    const s = await resolveSession(
      db,
      token({ uid: 'fb-owner', phone: '+919888888888', email: 'rahul@example.com', emailVerified: true }),
    );
    assert.equal(s.role, 'business', 'the owner must keep the role the admin assigned');
    assert.equal(await roleOf(db, s.userId), 'business');
  });

  it('an owner whose address is later added to ADMIN_EMAILS becomes admin', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    process.env['ADMIN_EMAILS'] = '';

    await db.query(
      `INSERT INTO users (phone, name, email, role) VALUES ($1, $2, $3, 'business')`,
      ['+919888888889', 'Rahul', 'rahul@example.com'],
    );
    const asOwner = await resolveSession(
      db,
      token({ uid: 'fb-owner2', phone: '+919888888889', email: 'rahul@example.com', emailVerified: true }),
    );
    assert.equal(asOwner.role, 'business');

    process.env['ADMIN_EMAILS'] = 'rahul@example.com';
    const asAdmin = await resolveSession(
      db,
      token({ uid: 'fb-owner2', phone: '+919888888889', email: 'rahul@example.com', emailVerified: true }),
    );
    assert.equal(asAdmin.role, 'admin');
  });
});

describe('admin and business do not overlap', () => {
  const session = (role: 'customer' | 'business' | 'admin') => ({
    userId: 'u', role, phone: '+910000000000', name: null, email: null,
    avatarUrl: null, blockedUntil: null,
  });

  it('a customer cannot reach an admin route', () => {
    assert.throws(() => requireRole(session('customer'), 'admin'), AuthError);
  });
  it('a business owner cannot reach an admin route', () => {
    assert.throws(() => requireRole(session('business'), 'admin'), AuthError);
  });
  it('an admin cannot reach a business route', () => {
    assert.throws(() => requireRole(session('admin'), 'business'), AuthError);
  });
});
