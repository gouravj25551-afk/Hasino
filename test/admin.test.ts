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
import {
  AdminError,
  addCatalogueService,
  changeSalonStatus,
  deleteCatalogueService,
  onboardSalon,
  statusHistory,
} from '../src/admin/repo.ts';
import { listSalons } from '../src/salons/repo.ts';
import { createBooking } from '../src/booking/create.ts';
import { StubRazorpayClient, type PaymentsConfig } from '../src/payments/razorpay.ts';
import { applyCapture, openCheckout } from '../src/payments/service.ts';
import { NOW, at } from './helpers.ts';
import { bookingStatus, connect, reset, seed } from './db.ts';

let pool: pg.Pool | null = null;
before(async () => { pool = await connect(); });
after(async () => { await pool?.end(); });

/** An admin actor id for the audit columns. Elevation itself is tested above. */
async function makeAdmin(db: pg.Pool): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (phone, name, email, role) VALUES ('+917000000099','Admin','admin@hasino.in','admin')
     RETURNING id`,
  );
  return r.rows[0]!.id;
}

/**
 * A salon with one genuinely paid, future booking.
 *
 * Paid matters: queueRefundForBooking looks for a captured payment and
 * correctly reports 'nothing_to_refund' without one, so an unpaid fixture
 * would let the refund assertion pass vacuously.
 */
async function paidBookingFixture(db: pg.Pool) {
  const fx = await seed(db, { onlineCapacity: 1 });
  const admin = await makeAdmin(db);
  const client = new StubRazorpayClient();
  const cfg: PaymentsConfig = {
    client, keyId: 'rzp_test_admin', keySecret: client.keySecret,
    webhookSecret: 'whsec_admin', commissionBps: 1500, holdTtlMs: 8 * 60_000, enabled: true,
  };

  const booking = await createBooking(
    db,
    { salonId: fx.salonId, customerId: fx.customerIds[0]!, serviceIds: [fx.serviceIds['haircut']!], startAt: at('11:00') },
    { now: NOW, holdTtlMs: cfg.holdTtlMs },
  );
  const checkout = await openCheckout(db, cfg, booking.id, fx.customerIds[0]!);
  const signed = client.pay(checkout.orderId);
  await applyCapture(db, cfg, { orderId: signed.orderId, paymentId: signed.paymentId }, { now: NOW });

  return { salonId: fx.salonId, admin, bookingId: booking.id };
}

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

    // An admin onboarded this owner: role set, no auth_provider_id yet.
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

/**
 * Onboarding and the status machine.
 *
 * The mechanism worth protecting is the one the PRD calls load-bearing: an
 * admin creates a users row with role='business' and no auth_provider_id, and the
 * owner's first Google sign-in adopts it without losing the role. That is one
 * ON CONFLICT clause in resolveSession and nothing else guards it.
 */
describe('admin onboarding', () => {
  it('creates an owner who is business and has never signed in', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const admin = await makeAdmin(db);

    const { salonId, ownerId, ownerExisted } = await onboardSalon(db, admin, {
      name: 'Cuts', address: '1 Road', city: 'Pune', lat: 18.52, lng: 73.85,
      owner: { phone: '+919812340100', name: 'Owner', email: 'owner@x.com' },
    });
    assert.equal(ownerExisted, false);

    const u = await db.query<{ role: string; auth_provider_id: string | null }>(
      `SELECT role, auth_provider_id FROM users WHERE id = $1`, [ownerId],
    );
    assert.equal(u.rows[0]!.role, 'business');
    assert.equal(u.rows[0]!.auth_provider_id, null, 'the row is claimed at sign-in, not created signed-in');

    const hours = await db.query<{ n: string }>(
      `SELECT count(*)::int8 AS n FROM salon_hours WHERE salon_id = $1`, [salonId],
    );
    assert.equal(Number(hours.rows[0]!.n), 7, 'an active salon with no hours reads as permanently closed');
  });

  it('that owner signing in with Google adopts the row and keeps business', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const admin = await makeAdmin(db);
    process.env['ADMIN_EMAILS'] = 'boss@hasino.in';

    const { salonId, ownerId } = await onboardSalon(db, admin, {
      name: 'Cuts', address: '1 Road', city: 'Pune', lat: 18.52, lng: 73.85,
      owner: { phone: '+919812340101', name: 'Owner', email: 'owner@x.com' },
    });

    const s = await resolveSession(
      db,
      token({ uid: 'fb-newowner', phone: '+919812340101', email: 'owner@x.com', emailVerified: true }),
    );
    assert.equal(s.userId, ownerId, 'must adopt the admin-created row, not make a second one');
    assert.equal(s.role, 'business');

    const owns = await db.query<{ id: string }>(`SELECT id FROM salons WHERE owner_id = $1`, [s.userId]);
    assert.equal(owns.rows[0]!.id, salonId);
  });

  it('refuses a second salon for the same owner', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const admin = await makeAdmin(db);
    const input = {
      address: '1 Road', city: 'Pune', lat: 18.52, lng: 73.85,
      owner: { phone: '+919812340102' },
    };
    await onboardSalon(db, admin, { ...input, name: 'First' });
    await assert.rejects(
      onboardSalon(db, admin, { ...input, name: 'Second' }),
      (err: AdminError) => err.code === 'OWNER_HAS_SALON' && err.status === 409,
    );
  });

  it('rejects a malformed phone, coordinates and timezone', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const admin = await makeAdmin(db);
    const base = { name: 'X', address: 'A', city: 'C', lat: 12.9, lng: 77.6 };

    await assert.rejects(
      onboardSalon(db, admin, { ...base, owner: { phone: '9876543210' } }),
      (e: AdminError) => e.code === 'BAD_PHONE',
    );
    await assert.rejects(
      onboardSalon(db, admin, { ...base, lat: 999, owner: { phone: '+919812340103' } }),
      (e: AdminError) => e.code === 'BAD_LAT',
    );
    // A bad zone stores happily and then throws inside zonedTimeToUtc on every
    // availability request, which reads as a broken engine rather than a typo.
    await assert.rejects(
      onboardSalon(db, admin, { ...base, timezone: 'Mars/Olympus', owner: { phone: '+919812340104' } }),
      (e: AdminError) => e.code === 'BAD_TIMEZONE',
    );
  });
});

describe('salon status machine', () => {
  it('a pending salon is invisible to customers; approving reveals it, suspending hides it', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const admin = await makeAdmin(db);
    const { salonId } = await onboardSalon(db, admin, {
      name: 'Hidden Cuts', address: '1 Road', city: 'Pune', lat: 18.52, lng: 73.85,
      owner: { phone: '+919812340105' }, status: 'pending',
    });

    const pendingList = await listSalons(db);
    assert.equal(pendingList.some((s) => s.id === salonId), false, 'pending must not be public');

    await changeSalonStatus(db, admin, salonId, 'active');
    const activeList = await listSalons(db);
    assert.equal(activeList.some((s) => s.id === salonId), true);

    await changeSalonStatus(db, admin, salonId, 'suspended');
    const suspendedList = await listSalons(db);
    assert.equal(suspendedList.some((s) => s.id === salonId), false);
  });

  it('refuses an illegal transition, and banned is terminal', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const admin = await makeAdmin(db);
    const { salonId } = await onboardSalon(db, admin, {
      name: 'X', address: 'A', city: 'C', lat: 12.9, lng: 77.6,
      owner: { phone: '+919812340106' }, status: 'pending',
    });

    // pending -> suspended is not a step that means anything
    await assert.rejects(
      changeSalonStatus(db, admin, salonId, 'suspended'),
      (e: AdminError) => e.code === 'INVALID_TRANSITION' && e.status === 409,
    );

    await changeSalonStatus(db, admin, salonId, 'banned');
    await assert.rejects(
      changeSalonStatus(db, admin, salonId, 'active'),
      (e: AdminError) => e.code === 'INVALID_TRANSITION',
    );
  });

  it('records every transition with who and why', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const admin = await makeAdmin(db);
    const { salonId } = await onboardSalon(db, admin, {
      name: 'X', address: 'A', city: 'C', lat: 12.9, lng: 77.6,
      owner: { phone: '+919812340107' }, status: 'pending',
    });
    await changeSalonStatus(db, admin, salonId, 'active', { reason: 'docs verified' });

    const history = await statusHistory(db, salonId);
    assert.equal(history[0]!.to, 'active');
    assert.equal(history[0]!.reason, 'docs verified');
    assert.equal(history.at(-1)!.to, 'pending', 'onboarding is itself an event');
  });

  it('leaves future bookings alone by default', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const { salonId, admin, bookingId } = await paidBookingFixture(db);

    await changeSalonStatus(db, admin, salonId, 'suspended', { now: NOW });
    assert.equal(await bookingStatus(db, bookingId), 'booked', 'deactivating to fix a typo must not refund a day of trade');
  });

  it('cancels future bookings and queues refunds when asked', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const { salonId, admin, bookingId } = await paidBookingFixture(db);

    const result = await changeSalonStatus(db, admin, salonId, 'suspended', {
      cancelFutureBookings: true,
      now: NOW,
    });
    assert.equal(result.cancelledBookings, 1);
    assert.equal(result.refundsQueued, 1, 'a paid booking must have its money queued back');
    assert.equal(await bookingStatus(db, bookingId), 'cancelled_by_salon');

    const refunds = await db.query<{ n: string }>(
      `SELECT count(*)::int8 AS n FROM refunds WHERE booking_id = $1`, [bookingId],
    );
    assert.equal(Number(refunds.rows[0]!.n), 1);
  });
});

describe('catalogue', () => {
  it('rejects a duplicate name', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    await addCatalogueService(db, 'Haircut', 'hair');
    await assert.rejects(
      addCatalogueService(db, 'Haircut', 'hair'),
      (e: AdminError) => e.code === 'DUPLICATE' && e.status === 409,
    );
  });

  it('refuses to delete a service a salon still offers', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const admin = await makeAdmin(db);
    const { salonId } = await onboardSalon(db, admin, {
      name: 'X', address: 'A', city: 'C', lat: 12.9, lng: 77.6,
      owner: { phone: '+919812340108' },
    });
    const svc = await addCatalogueService(db, 'Hot Towel Shave', 'beard');
    await db.query(
      `INSERT INTO salon_services (salon_id, service_id, price, duration_min) VALUES ($1,$2,25000,25)`,
      [salonId, svc.id],
    );

    // A hard delete here cascades into booking_items and rewrites what
    // customers were actually sold.
    await assert.rejects(
      deleteCatalogueService(db, svc.id),
      (e: AdminError) => e.code === 'SERVICE_IN_USE' && e.status === 409,
    );
  });

  it('deletes one nothing references', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const svc = await addCatalogueService(db, 'Unused Thing', 'spa');
    await deleteCatalogueService(db, svc.id);
    const left = await db.query(`SELECT id FROM services WHERE id = $1`, [svc.id]);
    assert.equal(left.rowCount, 0);
  });
});
