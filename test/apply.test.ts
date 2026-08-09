/**
 * Self-serve "List your salon".
 *
 * The application grants 'business' immediately, which sounds alarming and is
 * not: the role only ever unlocks salonForOwner(ownerId) — their own pending
 * salon — and listSalons filters status='active', so nothing they do is
 * public until an admin approves. These tests pin both halves of that.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type pg from 'pg';

import { AdminError, applyForSalon, changeSalonStatus } from '../src/admin/repo.ts';
import { salonForOwner } from '../src/business/repo.ts';
import { listSalons } from '../src/salons/repo.ts';
import { connect, reset } from './db.ts';

let pool: pg.Pool | null = null;
before(async () => { pool = await connect(); });
after(async () => { await pool?.end(); });

const ORIGINAL_ADMIN_EMAILS = process.env['ADMIN_EMAILS'];
afterEach(() => {
  if (ORIGINAL_ADMIN_EMAILS === undefined) delete process.env['ADMIN_EMAILS'];
  else process.env['ADMIN_EMAILS'] = ORIGINAL_ADMIN_EMAILS;
});

async function customer(db: pg.Pool, phone: string) {
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (phone, name, email, firebase_uid) VALUES ($1,'Applicant','applicant@x.com',$2)
     RETURNING id`,
    [phone, `fb:${phone}`],
  );
  return { userId: r.rows[0]!.id, phone, name: 'Applicant', email: 'applicant@x.com' };
}

const FORM = {
  name: 'Corner Barbers', address: '5 Lane', city: 'Mumbai', lat: 19.076, lng: 72.877,
};

describe('self-serve application', () => {
  it('creates a pending salon and promotes the applicant', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, '+919700000001');

    const { salonId } = await applyForSalon(db, me, FORM);

    const row = await db.query<{ status: string; owner_id: string }>(
      `SELECT status, owner_id FROM salons WHERE id = $1`, [salonId],
    );
    assert.equal(row.rows[0]!.status, 'pending');
    assert.equal(row.rows[0]!.owner_id, me.userId);

    const role = await db.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [me.userId]);
    assert.equal(role.rows[0]!.role, 'business');
  });

  it('is invisible to customers until an admin approves it', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, '+919700000002');
    const { salonId } = await applyForSalon(db, me, FORM);

    assert.equal((await listSalons(db)).some((s) => s.id === salonId), false);

    const admin = await db.query<{ id: string }>(
      `INSERT INTO users (phone, role) VALUES ('+917000000098','admin') RETURNING id`,
    );
    await changeSalonStatus(db, admin.rows[0]!.id, salonId, 'active');
    assert.equal((await listSalons(db)).some((s) => s.id === salonId), true);
  });

  it('lets the applicant set up their own salon and nobody else’s', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const mine = await customer(db, '+919700000003');
    const theirs = await customer(db, '+919700000004');
    const { salonId } = await applyForSalon(db, mine, FORM);
    await applyForSalon(db, theirs, { ...FORM, name: 'Other Barbers' });

    // salonForOwner is the only thing 'business' unlocks, and it is scoped to
    // the caller — there is no path from here to another salon's menu.
    assert.equal((await salonForOwner(db, mine.userId)).id, salonId);
    assert.notEqual((await salonForOwner(db, theirs.userId)).id, salonId);
  });

  it('gives it seven days of hours so approval never yields a live salon with none', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, '+919700000005');
    const { salonId } = await applyForSalon(db, me, FORM);
    const n = await db.query<{ n: string }>(
      `SELECT count(*)::int8 AS n FROM salon_hours WHERE salon_id = $1`, [salonId],
    );
    assert.equal(Number(n.rows[0]!.n), 7);
  });

  it('refuses a second application', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, '+919700000006');
    await applyForSalon(db, me, FORM);
    await assert.rejects(
      applyForSalon(db, me, { ...FORM, name: 'Second' }),
      (e: AdminError) => e.code === 'ALREADY_OWNS_SALON' && e.status === 409,
    );
  });

  it('refuses an admin — a platform account must not own a salon', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const r = await db.query<{ id: string }>(
      `INSERT INTO users (phone, email, role) VALUES ('+919700000007','boss@hasino.in','admin') RETURNING id`,
    );
    await assert.rejects(
      applyForSalon(db, { userId: r.rows[0]!.id, phone: '+919700000007', name: null, email: 'boss@hasino.in' }, FORM),
      (e: AdminError) => e.code === 'ADMIN_CANNOT_APPLY',
    );
  });

  it('tells the people in ADMIN_EMAILS', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    process.env['ADMIN_EMAILS'] = 'one@hasino.in, two@hasino.in';
    const me = await customer(db, '+919700000008');
    await applyForSalon(db, me, FORM);

    // A queue nobody is told about is a queue nobody empties.
    const n = await db.query<{ to_address: string }>(
      `SELECT to_address FROM notifications WHERE template = 'salon_application' ORDER BY to_address`,
    );
    assert.deepEqual(n.rows.map((r) => r.to_address), ['one@hasino.in', 'two@hasino.in']);
  });

  it('rejects coordinates and timezones that would break availability later', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, '+919700000009');
    await assert.rejects(
      applyForSalon(db, me, { ...FORM, lat: 999 }),
      (e: AdminError) => e.code === 'BAD_LAT',
    );
    await assert.rejects(
      applyForSalon(db, me, { ...FORM, timezone: 'Mars/Olympus' }),
      (e: AdminError) => e.code === 'BAD_TIMEZONE',
    );
  });
});
