/**
 * Listing a salon is a request, and a customer account stays a customer
 * account until an admin says otherwise.
 *
 * test/salon-onboarding.test.ts already pins the core of that machine — an
 * application grants nothing, approval promotes, rejection does not, and the
 * panel is behind the business role. What is pinned here is the surface built
 * on top of it: that the customer app no longer offers the form at all, that
 * the one entry point is outside the customer experience, that a request
 * records who made it and when *this* attempt was made, and that the applicant
 * cannot name anybody but themselves.
 *
 * The database-backed cases need a real Postgres and skip (rather than fail)
 * without one; the surface cases are source assertions, in the style of
 * test/panel-ui.test.ts, because these are browser modules with no build step
 * and no DOM in the runner.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import type pg from 'pg';

import { applyForSalon, changeSalonStatus, listSalonsForAdmin, adminSalonDetail } from '../src/admin/repo.ts';
import { connect, reset } from './db.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/**
 * The same file with its comments removed.
 *
 * "This screen must not say X" is a claim about what it renders, and a doc
 * comment explaining why X was taken out is not a screen saying it. Asserting
 * on the raw source made the explanation of a removal look like the removal
 * failing — so these assertions read the code and the prose is left alone.
 */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')     // block and JSDoc comments
    .replace(/^\s*\/\/.*$/gm, '');        // whole-line // comments
}

let pool: pg.Pool | null = null;
before(async () => { pool = await connect(); });
after(async () => { await pool?.end(); });

async function customer(db: pg.Pool, email: string, name = 'Applicant') {
  const res = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, role) VALUES ($2, $1, 'customer') RETURNING id`,
    [email, name],
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
  lat: 12.97,
  lng: 77.59,
  phone: '+918012345678',
  description: 'Two chairs, open since 2019.',
};
const userRow = async (db: pg.Pool, id: string) => (
  await db.query<{ role: string; name: string | null; phone: string | null; email: string | null }>(
    `SELECT role, name, phone, email FROM users WHERE id = $1`, [id])
).rows[0]!;

/* ---------------------------------------------------------------- surfaces */

describe('a customer is never offered "list your salon"', () => {
  const profile = code('src/http/public/views/profile.js');

  it('the profile page has no invitation and no link to the form', () => {
    // The section that used to sit on every customer's profile.
    assert.doesNotMatch(profile, /Become a Hasino Salon/);
    assert.doesNotMatch(profile, /'Apply as a Salon'/);
    // A customer with no request gets no section at all — not an empty panel,
    // not a heading. That is the `return null` and the caller's guard.
    assert.match(profile, /if \(!salon\) return null;/);
    assert.match(profile, /if \(salonState\) container\.append\(salonState\)/);
  });

  it('the only #/apply link left is for a request this account already made', () => {
    // One navigate() call, inside the rejected branch, which is the way back
    // into a request rather than an invitation to start one.
    const links = profile.match(/navigate\('#\/apply'\)/g) ?? [];
    assert.equal(links.length, 1, 'exactly one, in the rejected branch');
    const rejected = /if \(salon\.status === 'rejected'\) \{[\s\S]*?\n  \}/.exec(profile)?.[0] ?? '';
    assert.match(rejected, /navigate\('#\/apply'\)/);
  });

  it('nor does any other customer surface carry it', () => {
    for (const file of [
      'src/http/public/components/BottomNav.js',
      'src/http/public/components/TopBar.js',
      'src/http/public/views/home.js',
      'src/http/public/views/explore.js',
      'src/http/public/views/bookings.js',
    ]) {
      const src = code(file);
      assert.doesNotMatch(src, /#\/apply/, `${file} must not link to the application form`);
      assert.doesNotMatch(src, /[Ll]ist your salon|Apply as a Salon/, `${file} must not advertise it`);
    }
  });

  it('the salon panel link in the header is for an owner, not an invitation', () => {
    // TopBar offers /business only when the server says role === 'business',
    // which only approval sets.
    const topbar = read('src/http/public/components/TopBar.js');
    assert.match(topbar, /function panelFor\(role\) \{[\s\S]*?role === 'business'/);
  });
});

describe('the entry point lives outside the customer experience', () => {
  const login = read('src/http/public/views/login.js');

  it('the sign-in screen is where someone starts a listing', () => {
    assert.match(login, /'List your salon'/);
    // Same Google sign-in as the customer button; there is no separate
    // salon-owner sign-up that could grant anything.
    assert.match(login, /salonBtn\.onclick = \(\) => start\(salonBtn, 'salon'\)/);
  });

  it('and it lands on the form only after authentication', () => {
    // The intent is remembered across the OAuth round trip and read once.
    const app = read('src/http/public/app.js');
    assert.match(app, /intent === 'salon' \? '#\/apply' : '#\/home'/);
    // #/apply itself requires a session before it renders anything.
    const apply = read('src/http/public/views/apply.js');
    assert.match(apply, /const session = app\.requireSession\(\);\s*\n\s*if \(!session\) return;/);
  });

  it('an approved owner is taken to the panel instead of a form', () => {
    const apply = read('src/http/public/views/apply.js');
    assert.match(
      apply,
      /session\.role === 'business' && session\.salon && session\.salon\.status === 'active'[\s\S]*?window\.location\.replace\('\/business'\)/,
    );
  });

  it('the form never asks for an email the session already proved', () => {
    const apply = read('src/http/public/views/apply.js');
    // Shown, not typed: there is no email input on the form.
    assert.doesNotMatch(apply, /Input\(\{ label: 'Your email'/);
    assert.match(apply, /emailShown\.textContent = session\?\.email/);
    // And the request body carries no email at all.
    const submit = /body: JSON\.stringify\(\{[\s\S]*?\}\),/.exec(apply)?.[0] ?? '';
    assert.notEqual(submit, '', 'the submit payload was not found');
    assert.doesNotMatch(submit, /ownerEmail|email:/);
  });
});

describe('the admin panel has a queue of requests', () => {
  const adminJs = code('src/http/public/admin.js');
  const adminHtml = read('src/http/public/admin.html');

  it('it is its own section, not a filter on an archive', () => {
    assert.match(adminHtml, /data-nav="requests"/);
    assert.match(adminHtml, /Salon requests/);
    assert.match(adminJs, /\[\/\^#\\\/requests\$\/, requestsView\]/);
  });

  it('it reads the pending queue and nothing else', () => {
    const view = /async function requestsView\(\) \{[\s\S]*?\n\}/.exec(adminJs)?.[0] ?? '';
    assert.notEqual(view, '', 'requestsView() not found');
    assert.match(view, /\/api\/admin\/salons\?status=pending/);
  });

  it('each row shows who is asking, how to reach them, and how long they have waited', () => {
    const view = /async function requestsView\(\) \{[\s\S]*?\n\}/.exec(adminJs)?.[0] ?? '';
    for (const field of ['s.name', 's.ownerName', 's.ownerEmail', 's.ownerPhone', 's.serviceCount', 's.submittedAt']) {
      assert.ok(view.includes(field), `the queue must show ${field}`);
    }
  });

  it('approving happens on the detail, after the application has been opened', () => {
    // No one-tap Approve on a list nobody has read.
    const view = /async function requestsView\(\) \{[\s\S]*?\n\}/.exec(adminJs)?.[0] ?? '';
    assert.notEqual(view, '', 'requestsView() not found');
    assert.doesNotMatch(view, /Approve/);
    assert.match(view, /location\.hash = `#\/salon\/\$\{s\.id\}`/);
    // The detail is where the decision is made, and it is admin-only because
    // the whole panel is a separate process behind requireRole.
    assert.match(read('src/http/public/admin.js'), /'Approve & activate'/);
    assert.match(read('src/http/admin-server.ts'), /requireRole\(s, 'admin'\)/);
  });
});

/* ---------------------------------------------------------------- database */

describe('a request records who made it and when', () => {
  it('ties the salon to the authenticated user, never to a submitted id', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const mine = await customer(db, 'me@example.test');
    const other = await customer(db, 'someone.else@example.test', 'Victim');

    const { salonId } = await applyForSalon(
      db,
      { userId: mine, phone: null, name: 'Me', email: 'me@example.test' },
      APPLICATION,
    );

    const row = await db.query<{ owner_id: string }>(`SELECT owner_id FROM salons WHERE id = $1`, [salonId]);
    assert.equal(row.rows[0]!.owner_id, mine, 'the owner is the session user');
    assert.notEqual(row.rows[0]!.owner_id, other);
    // And the other account is untouched by somebody else's application.
    assert.equal((await userRow(db, other)).role, 'customer');
  });

  it('stores the applicant’s own contact details on their own row', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const mine = await customer(db, 'me@example.test');
    const other = await customer(db, 'else@example.test', 'Untouched');

    await applyForSalon(
      db,
      { userId: mine, phone: null, name: 'Me', email: 'me@example.test' },
      { ...APPLICATION, ownerName: 'Priya Sharma', ownerPhone: '+919876543210' },
    );

    const me = await userRow(db, mine);
    assert.equal(me.name, 'Priya Sharma');
    assert.equal(me.phone, '+919876543210');
    // The email is never written from the form — it is the verified one the
    // session already carried.
    assert.equal(me.email, 'me@example.test');
    // Nobody else's row moved.
    const them = await userRow(db, other);
    assert.equal(them.name, 'Untouched');
    assert.equal(them.phone, null);
  });

  it('refuses a phone number that could not be dialled', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const mine = await customer(db, 'me@example.test');
    await assert.rejects(
      applyForSalon(
        db,
        { userId: mine, phone: null, name: 'Me', email: 'me@example.test' },
        { ...APPLICATION, ownerPhone: '98765' },
      ),
      /E.164|\+/i,
    );
    // Nothing was written on the way to the refusal.
    const salons = await db.query(`SELECT 1 FROM salons`);
    assert.equal(salons.rowCount, 0);
  });

  it('a blank contact field never wipes a number an admin recorded', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const res = await db.query<{ id: string }>(
      `INSERT INTO users (name, email, phone, role)
       VALUES ('Known', 'known@example.test', '+911111111111', 'customer') RETURNING id`,
    );
    const mine = res.rows[0]!.id;
    await applyForSalon(
      db,
      { userId: mine, phone: '+911111111111', name: 'Known', email: 'known@example.test' },
      { ...APPLICATION, ownerName: null, ownerPhone: null },
    );
    const me = await userRow(db, mine);
    assert.equal(me.phone, '+911111111111', 'coalesce keeps what was already there');
    assert.equal(me.name, 'Known');
  });
});

describe('submitted_at is when this request was made', () => {
  it('a first application submits and creates on the same date', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const mine = await customer(db, 'me@example.test');
    const { salonId } = await applyForSalon(
      db, { userId: mine, phone: null, name: 'Me', email: 'me@example.test' }, APPLICATION,
    );
    const row = await db.query<{ created_at: Date; submitted_at: Date }>(
      `SELECT created_at, submitted_at FROM salons WHERE id = $1`, [salonId],
    );
    const { created_at, submitted_at } = row.rows[0]!;
    assert.ok(Math.abs(submitted_at.getTime() - created_at.getTime()) < 1000);
  });

  it('a resubmission moves it, and leaves created_at alone', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const mine = await customer(db, 'me@example.test');
    const operator = await admin(db);
    const { salonId } = await applyForSalon(
      db, { userId: mine, phone: null, name: 'Me', email: 'me@example.test' }, APPLICATION,
    );
    // Backdate the whole row, as if this were applied for weeks ago.
    await db.query(
      `UPDATE salons SET created_at = now() - interval '30 days',
                         submitted_at = now() - interval '30 days' WHERE id = $1`,
      [salonId],
    );
    await changeSalonStatus(db, operator, salonId, 'rejected', { reason: 'Photos are too blurry' });

    await applyForSalon(
      db, { userId: mine, phone: null, name: 'Me', email: 'me@example.test' },
      { ...APPLICATION, description: 'Now with better photos.' },
    );

    const row = await db.query<{ created_at: Date; submitted_at: Date; status: string }>(
      `SELECT created_at, submitted_at, status FROM salons WHERE id = $1`, [salonId],
    );
    const { created_at, submitted_at, status } = row.rows[0]!;
    assert.equal(status, 'pending', 'a resubmission goes back into the queue');
    assert.ok(Date.now() - submitted_at.getTime() < 60_000, 'submitted just now');
    assert.ok(Date.now() - created_at.getTime() > 20 * 24 * 3600_000, 'first applied a month ago');
  });

  it('the admin queue is ordered by when each request was actually made', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const operator = await admin(db);
    const oldApplicant = await customer(db, 'old@example.test');
    const newApplicant = await customer(db, 'new@example.test');

    const first = await applyForSalon(
      db, { userId: oldApplicant, phone: null, name: 'Old', email: 'old@example.test' },
      { ...APPLICATION, name: 'The Old Application' },
    );
    // It is old, and it was rejected and fixed today.
    await db.query(
      `UPDATE salons SET created_at = now() - interval '30 days',
                         submitted_at = now() - interval '30 days' WHERE id = $1`,
      [first.salonId],
    );
    await changeSalonStatus(db, operator, first.salonId, 'rejected', { reason: 'no' });

    await applyForSalon(
      db, { userId: newApplicant, phone: null, name: 'New', email: 'new@example.test' },
      { ...APPLICATION, name: 'Submitted Yesterday' },
    );
    await db.query(
      `UPDATE salons SET submitted_at = now() - interval '1 day' WHERE name = 'Submitted Yesterday'`,
    );
    // Resubmitted now: this is the newest request even though it is the
    // oldest salon row.
    await applyForSalon(
      db, { userId: oldApplicant, phone: null, name: 'Old', email: 'old@example.test' },
      { ...APPLICATION, name: 'The Old Application' },
    );

    const rows = await listSalonsForAdmin(db, { status: 'pending' });
    assert.deepEqual(rows.map((r) => r.name), ['The Old Application', 'Submitted Yesterday']);
    assert.ok(rows.every((r) => r.submittedAt), 'every row carries its submission date');
  });

  it('the detail an admin reviews carries everything the queue promised', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const mine = await customer(db, 'me@example.test');
    const { salonId } = await applyForSalon(
      db, { userId: mine, phone: null, name: 'Me', email: 'me@example.test' },
      { ...APPLICATION, ownerName: 'Priya Sharma', ownerPhone: '+919876543210' },
    );
    const detail = await adminSalonDetail(db, salonId);
    assert.equal(detail.name, APPLICATION.name);
    assert.equal(detail.status, 'pending');
    assert.equal(detail.owner.name, 'Priya Sharma');
    assert.equal(detail.owner.phone, '+919876543210');
    assert.equal(detail.owner.email, 'me@example.test');
    // Still a customer while it waits — the panel shows this so the reviewer
    // can see that approval is what changes it.
    assert.equal(detail.owner.role, 'customer');
    assert.ok(detail.submittedAt, 'the request carries its submission date');
    assert.equal(detail.description, APPLICATION.description);
  });
});

describe('existing salon owners are not disturbed', () => {
  it('an approved owner keeps their salon, their role and their panel', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    // An owner who was approved before any of this existed: a business role
    // and an active salon, with no request ever having gone through the new
    // path.
    const owner = await db.query<{ id: string }>(
      `INSERT INTO users (name, email, phone, role)
       VALUES ('Established', 'established@example.test', '+912222222222', 'business') RETURNING id`,
    );
    const ownerId = owner.rows[0]!.id;
    const salon = await db.query<{ id: string }>(
      `INSERT INTO salons (owner_id, name, address, city, lat, lng, status)
       VALUES ($1, 'Long-standing Salon', '1 Old Road', 'Bengaluru', 12.9, 77.6, 'active')
       RETURNING id`,
      [ownerId],
    );
    const salonId = salon.rows[0]!.id;

    // The column the migration added has a value for a row nobody submitted.
    const row = await db.query<{ submitted_at: Date | null; status: string }>(
      `SELECT submitted_at, status FROM salons WHERE id = $1`, [salonId],
    );
    assert.ok(row.rows[0]!.submitted_at, 'submitted_at defaults rather than being null');
    assert.equal(row.rows[0]!.status, 'active');
    assert.equal((await userRow(db, ownerId)).role, 'business', 'still an owner');

    // And they are not asked to reapply: the queue does not contain them.
    const pending = await listSalonsForAdmin(db, { status: 'pending' });
    assert.deepEqual(pending.map((p) => p.id), []);
  });

  it('the migration backfills rather than dropping the column on existing rows', () => {
    const sql = read('db/migrations/011_salon_submitted_at.sql');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS submitted_at/);
    assert.match(sql, /UPDATE salons SET submitted_at = created_at WHERE submitted_at IS NULL/);
    // Idempotent: the NOT NULL is only applied when the column is still
    // nullable, so a second run is a no-op rather than an error.
    assert.match(sql, /is_nullable = 'YES'/);
    assert.doesNotMatch(sql, /DROP COLUMN|DELETE FROM salons/);
  });
});

describe('the business rule, stated where it is enforced', () => {
  it('applying never promotes anyone', () => {
    const repo = read('src/admin/repo.ts');
    const fn = /export async function applyForSalon\([\s\S]*?\n}/.exec(repo)?.[0] ?? '';
    assert.notEqual(fn, '', 'applyForSalon() not found');
    // No role write anywhere in the application path.
    assert.doesNotMatch(fn, /SET role|role = 'business'/);
    assert.match(fn, /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,'pending'/, 'always pending');
  });

  it('approval is the only thing that does', () => {
    const repo = read('src/admin/repo.ts');
    const fn = /export async function changeSalonStatus\([\s\S]*?\n}/.exec(repo)?.[0] ?? '';
    assert.match(fn, /if \(goingLive\) \{[\s\S]*?SET role = 'business'/);
    // Only ever a promotion from customer: an admin who somehow owns a salon
    // stays an admin.
    assert.match(fn, /AND role = 'customer'/);
  });

  it('the panel and the admin surface are behind the roles, not behind the UI', () => {
    assert.match(read('src/http/server.ts'), /requireRole\(s, 'business'\)/);
    assert.match(read('src/http/admin-server.ts'), /requireRole\(s, 'admin'\)/);
    // /api/admin/* is not mounted on the public server at all.
    assert.match(read('src/http/server.ts'), /There is deliberately no \/api\/admin\/\* here/);
    // And roles do not nest: admin is not a superset of business.
    assert.match(read('src/auth/session.ts'), /if \(session\.role !== role\)/);
  });

  it('a new account is always a customer, whatever the token claims', () => {
    const session = read('src/auth/session.ts');
    assert.match(session, /VALUES \(\$1, \$2, \$3, \$4, 'customer'\)/);
    assert.match(session, /Roles never come from token claims/);
  });
});
