/**
 * "List your salon", from the click to the panel.
 *
 * The application is not a separate record: the `salons` row IS the
 * application, and its status is the request's status — pending, rejected, or
 * active once an admin approves. That is why there is no onboarding-request
 * table here. The state machine already existed; what these tests pin is the
 * part that decides who gets in.
 *
 * The load-bearing rule: approval, and only approval, grants the business
 * role. An application grants nothing, so /api/business/* answers 403 to a
 * pending applicant no matter what any screen shows.
 *
 * Needs a real Postgres; skips (does not fail) without one.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import type pg from 'pg';

import { applyForSalon, changeSalonStatus, AdminError } from '../src/admin/repo.ts';
import { salonForOwner } from '../src/business/repo.ts';
import { connect, reset } from './db.ts';

let pool: pg.Pool | null = null;

before(async () => {
  pool = await connect();
});

after(async () => {
  await pool?.end();
});

async function customer(db: pg.Pool, email: string) {
  const res = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, role) VALUES ('Applicant', $1, 'customer') RETURNING id`,
    [email],
  );
  return res.rows[0]!.id;
}

async function admin(db: pg.Pool) {
  const res = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, role) VALUES ('Operator', 'ops@example.test', 'admin') RETURNING id`,
  );
  return res.rows[0]!.id;
}

const APPLICATION = {
  name: 'Sharma Hair Studio',
  address: '12 MG Road',
  city: 'Bengaluru',
  area: 'Indiranagar',
  lat: 12.97,
  lng: 77.59,
  phone: '+918012345678',
  email: 'shop@example.test',
  description: 'Two chairs, open since 2019.',
};

async function roleOf(db: pg.Pool, userId: string) {
  const res = await db.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [userId]);
  return res.rows[0]!.role;
}

async function statusOf(db: pg.Pool, salonId: string) {
  const res = await db.query<{ status: string }>(`SELECT status FROM salons WHERE id = $1`, [salonId]);
  return res.rows[0]!.status;
}

describe('list your salon — an application grants nothing', () => {
  it('lands as pending, and leaves the applicant a customer', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const userId = await customer(db, 'owner@example.test');

    const { salonId } = await applyForSalon(
      db,
      { userId, phone: null, name: 'Applicant', email: 'owner@example.test' },
      APPLICATION,
    );

    assert.equal(await statusOf(db, salonId), 'pending');
    assert.equal(await roleOf(db, userId), 'customer', 'applying is not being approved');

    // ...so the panel is shut. salonForOwner is what every /api/business/*
    // route calls, and the role check in front of it is what answers 403 —
    // but even past that, a pending salon is not an approved one.
    const salon = await salonForOwner(db, userId);
    assert.equal(salon.status, 'pending');
  });

  it('refuses a second application while one is in flight', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const userId = await customer(db, 'owner@example.test');
    await applyForSalon(db, { userId, phone: null, name: 'A', email: 'owner@example.test' }, APPLICATION);

    await assert.rejects(
      applyForSalon(db, { userId, phone: null, name: 'A', email: 'owner@example.test' }, APPLICATION),
      (err: unknown) => {
        assert.ok(err instanceof AdminError);
        assert.equal(err.code, 'ALREADY_OWNS_SALON');
        return true;
      },
    );

    const count = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM salons WHERE owner_id = $1`,
      [userId],
    );
    assert.equal(count.rows[0]!.n, 1, 'one owner, one salon — no duplicate requests');
  });

  it('an admin cannot apply for a salon', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const adminId = await admin(db);

    await assert.rejects(
      applyForSalon(db, { userId: adminId, phone: null, name: 'Ops', email: 'ops@example.test' }, APPLICATION),
      (err: unknown) => (err as AdminError).code === 'ADMIN_CANNOT_APPLY',
    );
  });
});

describe('list your salon — approval is what opens the panel', () => {
  it('promotes the owner in the same transaction as going live', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const userId = await customer(db, 'owner@example.test');
    const adminId = await admin(db);
    const { salonId } = await applyForSalon(
      db,
      { userId, phone: null, name: 'A', email: 'owner@example.test' },
      APPLICATION,
    );

    await changeSalonStatus(db, adminId, salonId, 'active', { reason: 'Looks real' });

    assert.equal(await statusOf(db, salonId), 'active');
    assert.equal(await roleOf(db, userId), 'business', 'approval is what makes them an owner');

    // Which is exactly what the panel needs: the role passes requireRole, and
    // salonForOwner finds their salon.
    const salon = await salonForOwner(db, userId);
    assert.equal(salon.id, salonId);
    assert.equal(salon.status, 'active');
  });

  it('records who approved it and when', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const userId = await customer(db, 'owner@example.test');
    const adminId = await admin(db);
    const { salonId } = await applyForSalon(
      db,
      { userId, phone: null, name: 'A', email: 'owner@example.test' },
      APPLICATION,
    );
    await changeSalonStatus(db, adminId, salonId, 'active');

    const row = await db.query<{ approved_by: string; approved_at: Date | null }>(
      `SELECT approved_by, approved_at FROM salons WHERE id = $1`,
      [salonId],
    );
    assert.equal(row.rows[0]!.approved_by, adminId);
    assert.ok(row.rows[0]!.approved_at, 'reviewedAt, in the schema that already had it');
  });
});

describe('list your salon — rejection, and what the owner is told', () => {
  it('keeps them a customer and records the reason', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const userId = await customer(db, 'owner@example.test');
    const adminId = await admin(db);
    const { salonId } = await applyForSalon(
      db,
      { userId, phone: null, name: 'A', email: 'owner@example.test' },
      APPLICATION,
    );

    await changeSalonStatus(db, adminId, salonId, 'rejected', {
      reason: 'The storefront photo is of a different shop.',
    });

    assert.equal(await statusOf(db, salonId), 'rejected');
    assert.equal(await roleOf(db, userId), 'customer', 'a rejection grants nothing');

    // The reason the owner is now shown. This is the query /api/me runs.
    const seen = await db.query<{ rejection_reason: string | null }>(
      `SELECT CASE WHEN s.status = 'rejected' THEN e.reason END AS rejection_reason
         FROM salons s
         LEFT JOIN LATERAL (
           SELECT reason FROM salon_status_events
            WHERE salon_id = s.id AND to_status = s.status
            ORDER BY created_at DESC LIMIT 1
         ) e ON true
        WHERE s.owner_id = $1`,
      [userId],
    );
    assert.equal(seen.rows[0]!.rejection_reason, 'The storefront photo is of a different shop.');
  });

  it('lets them fix it and resubmit, on the same salon row', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const userId = await customer(db, 'owner@example.test');
    const adminId = await admin(db);
    const first = await applyForSalon(
      db,
      { userId, phone: null, name: 'A', email: 'owner@example.test' },
      APPLICATION,
    );
    await changeSalonStatus(db, adminId, first.salonId, 'rejected', { reason: 'Blurry photos' });

    const again = await applyForSalon(
      db,
      { userId, phone: null, name: 'A', email: 'owner@example.test' },
      { ...APPLICATION, description: 'Now with better photos.' },
    );

    assert.equal(again.salonId, first.salonId, 'the same application, resubmitted');
    assert.equal(await statusOf(db, first.salonId), 'pending', 'back in the queue');

    // The rejection is still in the trail — resubmitting is not a way to erase
    // that this was once turned down.
    const trail = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM salon_status_events WHERE salon_id = $1 AND to_status = 'rejected'`,
      [first.salonId],
    );
    assert.equal(trail.rows[0]!.n, 1);

    // ...and the reason no longer shows, because the current status is pending.
    const seen = await db.query<{ rejection_reason: string | null }>(
      `SELECT CASE WHEN s.status = 'rejected' THEN e.reason END AS rejection_reason
         FROM salons s
         LEFT JOIN LATERAL (
           SELECT reason FROM salon_status_events
            WHERE salon_id = s.id AND to_status = s.status
            ORDER BY created_at DESC LIMIT 1
         ) e ON true
        WHERE s.owner_id = $1`,
      [userId],
    );
    assert.equal(seen.rows[0]!.rejection_reason, null);
  });

  it('a rejected owner who is approved later does get in', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const userId = await customer(db, 'owner@example.test');
    const adminId = await admin(db);
    const { salonId } = await applyForSalon(
      db,
      { userId, phone: null, name: 'A', email: 'owner@example.test' },
      APPLICATION,
    );
    await changeSalonStatus(db, adminId, salonId, 'rejected', { reason: 'Try again' });
    await applyForSalon(db, { userId, phone: null, name: 'A', email: 'owner@example.test' }, APPLICATION);
    await changeSalonStatus(db, adminId, salonId, 'active');

    assert.equal(await roleOf(db, userId), 'business');
  });
});

/**
 * The parts that must not be talked out of by a client.
 *
 * Source assertions, because these are one-line edits away from being wrong
 * and none of them would fail a normal test run: the verification gate, the
 * role check in front of the panel, and the fact that nothing outside
 * changeSalonStatus can hand out the 'business' role.
 */
describe('list your salon — authorization is server-side', () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const server = read('src/http/server.ts');

  it('an unverified email cannot apply, whatever the form allows', () => {
    const route = /if \(method === 'POST' && path === '\/api\/salons\/apply'\)[\s\S]*?limits\.booking\.check/.exec(
      server,
    )?.[0] ?? '';
    assert.notEqual(route, '', 'apply route not found');
    assert.match(route, /!applicant\.emailVerified/);
    assert.match(route, /EMAIL_NOT_VERIFIED/);
  });

  it('verification comes from the token, not from a column somebody can edit', () => {
    const session = read('src/auth/session.ts');
    assert.match(session, /emailVerified: token\.emailVerified === true/);
    // Nothing reads it back off the users row — there is no such column.
    assert.doesNotMatch(read('db/schema.sql'), /email_verified/);
  });

  it('the panel is behind the business role, which only approval grants', () => {
    assert.match(server, /seg\[1\] === 'business'[\s\S]{0,200}requireRole\(s, 'business'\)/);
    const repo = read('src/admin/repo.ts');
    // The single place the role is handed out, inside the status transaction.
    const grants = repo.match(/SET role = 'business'/g) ?? [];
    assert.equal(grants.length, 2, 'changeSalonStatus (approval) and onboardSalon (admin-created)');
    const apply = /export async function applyForSalon[\s\S]*?\n}/.exec(repo)?.[0] ?? '';
    assert.doesNotMatch(apply, /SET role = 'business'/, 'applying must never promote anyone');
  });

  it('approve and reject are admin-only, on the panel that is not public', () => {
    const adminServer = read('src/http/admin-server.ts');
    assert.match(adminServer, /requireRole\(s, 'admin'\)/);
    assert.match(read('src/http/routes-admin.ts'), /rest\[0\] === 'status'/);
    // The customer server mounts no admin API at all.
    const code = server.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /adminRoutes\(/);
  });

  it('the owner is told the status and the reason, and never sets them', () => {
    // /api/me reports; there is no route that writes status from the customer
    // app. Applying is the only write, and it always lands pending.
    assert.match(server, /rejection_reason/);
    assert.match(server, /emailVerified: s\.emailVerified/);
    const apply = read('src/http/public/views/apply.js');
    assert.match(apply, /session\.emailVerified === false/);
    assert.match(apply, /session\.salon\.rejectionReason/);
    assert.match(read('src/http/public/views/profile.js'), /salon\.rejectionReason/);
  });
});
