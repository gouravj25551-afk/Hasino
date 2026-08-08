/**
 * Session resolution: turning a verified token into the users row that owns
 * bookings. Signature checking is Firebase's job; this is the part we can get
 * wrong, so it is the part that is tested.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';

import { AuthError, type TokenVerifier, type VerifiedToken } from '../src/auth/verifier.ts';
import { authenticate, bearer, requireRole, resolveSession } from '../src/auth/session.ts';
import { connect, reset } from './db.ts';

let pool: pg.Pool | null = null;
before(async () => { pool = await connect(); });
after(async () => { await pool?.end(); });

const token = (t: Partial<VerifiedToken> & { uid: string }): VerifiedToken => ({ ...t });

const stubVerifier = (result: VerifiedToken): TokenVerifier => ({
  kind: 'stub',
  async verify() { return result; },
});

describe('bearer parsing', () => {
  it('accepts a well-formed header', () => {
    assert.equal(bearer('Bearer abc.def.ghi'), 'abc.def.ghi');
    assert.equal(bearer('bearer abc'), 'abc');
  });
  it('rejects anything else', () => {
    for (const bad of [undefined, '', 'abc', 'Basic abc', 'Bearer']) {
      assert.throws(() => bearer(bad as string | undefined), AuthError, `should reject: ${bad}`);
    }
  });
});

describe('requireRole', () => {
  const s = (role: 'customer' | 'business' | 'admin') =>
    ({ userId: 'u', role, phone: '+910000000000', name: null, email: null, avatarUrl: null, blockedUntil: null });

  it('lets a business user into the panel', () => {
    assert.doesNotThrow(() => requireRole(s('business'), 'business'));
  });
  it('keeps customers out of the panel', () => {
    assert.throws(() => requireRole(s('customer'), 'business'), /business role/);
  });
  it('treats admin as a superset of business', () => {
    assert.doesNotThrow(() => requireRole(s('admin'), 'business'));
  });
  it('does not let business act as admin', () => {
    assert.throws(() => requireRole(s('business'), 'admin'), AuthError);
  });
});

describe('resolveSession', () => {
  it('provisions a new account on first sign-in', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    const s = await resolveSession(pool, token({ uid: 'fb-1', phone: '+919812345678', name: 'Aarav' }));
    assert.equal(s.phone, '+919812345678');
    assert.equal(s.name, 'Aarav');
    assert.equal(s.role, 'customer');
  });

  it('a new account is ALWAYS a customer, whatever the token says', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    // A token can carry arbitrary custom claims. None of them may grant a role.
    const s = await resolveSession(
      pool,
      { uid: 'fb-evil', phone: '+919800000001', name: 'x', ...({ role: 'admin' } as object) } as VerifiedToken,
    );
    assert.equal(s.role, 'customer');
  });

  it('returns the same user on the second sign-in', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    const a = await resolveSession(pool, token({ uid: 'fb-2', phone: '+919812345679' }));
    const b = await resolveSession(pool, token({ uid: 'fb-2', phone: '+919812345679' }));
    assert.equal(a.userId, b.userId);
    const count = await pool.query(`SELECT count(*)::int8 AS n FROM users`);
    assert.equal(Number(count.rows[0].n), 1, 'must not create a duplicate');
  });

  it('demands a phone when the provider gives none (Google sign-in)', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    await assert.rejects(
      resolveSession(pool, token({ uid: 'fb-google', email: 'a@b.com' })),
      (err: AuthError) => err.code === 'PHONE_REQUIRED' && err.status === 428,
    );
  });

  it('refreshes name/email/avatar from Google on the first sign-in once a phone is linked', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    const s = await resolveSession(
      pool,
      token({
        uid: 'fb-google',
        phone: '+919812340000',
        email: 'a@b.com',
        name: 'Google User',
        picture: 'https://avatar.com/pic.jpg',
      }),
    );
    assert.equal(s.email, 'a@b.com');
    assert.equal(s.name, 'Google User');
    assert.equal(s.avatarUrl, 'https://avatar.com/pic.jpg');
    assert.equal(s.role, 'customer');
  });

  it('refreshes name/email/avatar on a returning sign-in', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    await resolveSession(pool, token({ uid: 'fb-refresh', phone: '+919812340001', name: 'Old Name' }));
    const s = await resolveSession(
      pool,
      token({ uid: 'fb-refresh', phone: '+919812340001', name: 'New Name', picture: 'https://avatar.com/new.jpg' }),
    );
    assert.equal(s.name, 'New Name');
    assert.equal(s.avatarUrl, 'https://avatar.com/new.jpg');
  });

  it('links a pre-existing row by verified phone', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    // e.g. a salon onboarded by an admin before the owner ever signed in
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO users (phone, name, role) VALUES ('+919888888888', 'Owner', 'business') RETURNING id`,
    );
    const s = await resolveSession(pool, token({ uid: 'fb-owner', phone: '+919888888888' }));
    assert.equal(s.userId, seeded.rows[0]!.id, 'must adopt the existing row, not make a second one');
    assert.equal(s.role, 'business', 'and must keep the role that was assigned to it');
  });

  it('refuses to steal a phone already bound to a different account', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    await resolveSession(pool, token({ uid: 'fb-first', phone: '+919777777777' }));
    // A second Firebase account claiming the same number must not inherit
    // the first one's bookings.
    await assert.rejects(
      resolveSession(pool, token({ uid: 'fb-second', phone: '+919777777777' })),
      (err: AuthError) => err.code === 'PHONE_TAKEN' && err.status === 409,
    );
  });

  it('does not overwrite a name the user already has', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    await pool.query(`INSERT INTO users (phone, name) VALUES ('+919666666666', 'Chosen Name')`);
    const s = await resolveSession(pool, token({ uid: 'fb-n', phone: '+919666666666', name: 'From Google' }));
    assert.equal(s.name, 'Chosen Name');
  });

  it('surfaces a block so callers can act on it', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    await pool.query(
      `INSERT INTO users (phone, firebase_uid, blocked_until)
       VALUES ('+919555555555', 'fb-blocked', now() + interval '10 days')`,
    );
    const s = await resolveSession(pool, token({ uid: 'fb-blocked', phone: '+919555555555' }));
    assert.ok(s.blockedUntil && s.blockedUntil.getTime() > Date.now());
  });

  it('authenticate() runs the verifier then resolves', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    const s = await authenticate(
      pool,
      stubVerifier({ uid: 'fb-3', phone: '+919444444444' }),
      'Bearer whatever',
    );
    assert.equal(s.phone, '+919444444444');
  });

  it('a rejected token never reaches the database', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    const failing: TokenVerifier = {
      kind: 'failing',
      async verify() { throw new AuthError(401, 'INVALID_TOKEN', 'nope'); },
    };
    await assert.rejects(authenticate(pool, failing, 'Bearer bad'), AuthError);
    const count = await pool.query(`SELECT count(*)::int8 AS n FROM users`);
    assert.equal(Number(count.rows[0].n), 0);
  });
});
