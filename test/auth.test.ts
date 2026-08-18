/**
 * Session resolution: turning a verified token into the users row that owns
 * bookings. Signature checking is the provider's job; this is the part we can
 * get wrong, so it is the part that is tested.
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
    ({ userId: 'u', role, phone: '+910000000000', name: null, email: null, emailVerified: true, avatarUrl: null, blockedUntil: null });

  it('lets a business user into the panel', () => {
    assert.doesNotThrow(() => requireRole(s('business'), 'business'));
  });
  it('keeps customers out of the panel', () => {
    assert.throws(() => requireRole(s('customer'), 'business'), /business role/);
  });
  // Roles do not nest. Admin used to pass as business, which only moved the
  // failure one layer down: /api/business/* resolves the caller's salon via
  // salonForOwner(), an admin owns none, and the request died with a
  // misleading ForbiddenError instead of an honest 403.
  it('does not treat admin as a superset of business', () => {
    assert.throws(() => requireRole(s('admin'), 'business'), AuthError);
  });
  it('does not let business act as admin', () => {
    assert.throws(() => requireRole(s('business'), 'admin'), AuthError);
  });
  it('does not let a customer act as admin', () => {
    assert.throws(() => requireRole(s('customer'), 'admin'), AuthError);
  });
  it('lets an admin into an admin route', () => {
    assert.doesNotThrow(() => requireRole(s('admin'), 'admin'));
  });
});

describe('resolveSession', () => {
  it('provisions a new account on first sign-in', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    const s = await resolveSession(pool, token({ uid: 'fb-1', name: 'Aarav' }));
    assert.equal(s.phone, null, 'nothing asks for a number any more');
    assert.equal(s.name, 'Aarav');
    assert.equal(s.role, 'customer');
  });

  it('a new account is ALWAYS a customer, whatever the token says', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    // A token can carry arbitrary custom claims. None of them may grant a role.
    const s = await resolveSession(
      pool,
      { uid: 'fb-evil', name: 'x', ...({ role: 'admin' } as object) } as VerifiedToken,
    );
    assert.equal(s.role, 'customer');
  });

  it('returns the same user on the second sign-in', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    const a = await resolveSession(pool, token({ uid: 'fb-2', email: 'two@x.com', emailVerified: true }));
    const b = await resolveSession(pool, token({ uid: 'fb-2', email: 'two@x.com', emailVerified: true }));
    assert.equal(a.userId, b.userId);
    const count = await pool.query(`SELECT count(*)::int8 AS n FROM users`);
    assert.equal(Number(count.rows[0].n), 1, 'must not create a duplicate');
  });

  it('creates the account from Google alone, with no phone number', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    // Google carries no phone. This used to throw 428 PHONE_REQUIRED and make
    // the client collect one before the account could exist.
    const s = await resolveSession(pool, token({ uid: 'fb-google', email: 'a@b.com' }));
    assert.equal(s.phone, null);
    assert.equal(s.email, 'a@b.com');
    assert.equal(s.role, 'customer');
  });

  it('refreshes name/email/avatar from Google on the first sign-in', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    const s = await resolveSession(
      pool,
      token({
        uid: 'fb-google',
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
    await resolveSession(pool, token({ uid: 'fb-refresh', name: 'Old Name' }));
    const s = await resolveSession(
      pool,
      token({ uid: 'fb-refresh', name: 'New Name', picture: 'https://avatar.com/new.jpg' }),
    );
    assert.equal(s.name, 'New Name');
    assert.equal(s.avatarUrl, 'https://avatar.com/new.jpg');
  });

  it('links a pre-existing row by verified email', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    // e.g. a salon onboarded by an admin before the owner ever signed in
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO users (phone, name, email, role)
       VALUES ('+919888888888', 'Owner', 'Owner@Salon.com', 'business') RETURNING id`,
    );
    const s = await resolveSession(
      pool,
      token({ uid: 'fb-owner', email: 'owner@salon.com', emailVerified: true }),
    );
    assert.equal(s.userId, seeded.rows[0]!.id, 'must adopt the existing row, not make a second one');
    assert.equal(s.role, 'business', 'and must keep the role that was assigned to it');
    assert.equal(s.phone, '+919888888888', 'and must keep the number the admin recorded');
  });

  it('will not claim a row on an UNVERIFIED email', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    // Otherwise anyone could adopt a salon by typing its owner's address into
    // a throwaway account on a provider that does not verify.
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO users (phone, name, email, role)
       VALUES ('+919888888889', 'Owner', 'owner2@salon.com', 'business') RETURNING id`,
    );
    const s = await resolveSession(
      pool,
      token({ uid: 'fb-impostor', email: 'owner2@salon.com', emailVerified: false }),
    );
    assert.notEqual(s.userId, seeded.rows[0]!.id, 'must get its own row');
    assert.equal(s.role, 'customer', 'and must not inherit the business role');
  });

  it('refuses to re-claim a row that has already been signed into', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    const first = await resolveSession(
      pool,
      token({ uid: 'fb-first', email: 'shared@x.com', emailVerified: true }),
    );
    // A second provider identity presenting the same address must not inherit
    // the first one's bookings.
    const second = await resolveSession(
      pool,
      token({ uid: 'fb-second', email: 'shared@x.com', emailVerified: true }),
    );
    assert.notEqual(second.userId, first.userId);
  });

  it('does not overwrite a name the user already has', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    await pool.query(`INSERT INTO users (name, email) VALUES ('Chosen Name', 'chosen@x.com')`);
    const s = await resolveSession(
      pool,
      token({ uid: 'fb-n', email: 'chosen@x.com', emailVerified: true, name: 'From Google' }),
    );
    assert.equal(s.name, 'Chosen Name');
  });

  it('surfaces a block so callers can act on it', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    await pool.query(
      `INSERT INTO users (auth_provider_id, blocked_until)
       VALUES ('fb-blocked', now() + interval '10 days')`,
    );
    const s = await resolveSession(pool, token({ uid: 'fb-blocked' }));
    assert.ok(s.blockedUntil && s.blockedUntil.getTime() > Date.now());
  });

  it('authenticate() runs the verifier then resolves', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    await reset(pool);
    const s = await authenticate(
      pool,
      stubVerifier({ uid: 'fb-3', email: 'three@x.com' }),
      'Bearer whatever',
    );
    assert.equal(s.email, 'three@x.com');
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
