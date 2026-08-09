/**
 * The platform operator's reads and writes.
 *
 * The distinction from business/repo.ts is who names the salon. There, it is
 * always the signed-in owner via salonForOwner(), so a salonId is never
 * accepted from the client. Here the admin names it in the URL, and every
 * route is behind requireRole(s, 'admin').
 *
 * Per-salon menu and hours are deliberately NOT reimplemented — upsertService,
 * deactivateService, listServiceSetup, listHours and saveHours in
 * business/repo.ts already take a salonId and have no notion of who is
 * calling. Two copies of the validation is how the two panels drift.
 */
import type { Pool, PoolClient } from '../db/pool.ts';
import { withTransaction } from '../db/pool.ts';
import { queueRefundForBooking } from '../payments/service.ts';
import { cancelPending } from '../notify/outbox.ts';

type Queryable = Pool | PoolClient;

export type SalonStatus = 'pending' | 'active' | 'suspended' | 'banned';

export class AdminError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
    this.code = code;
  }
}

// ---------- validation ----------

/**
 * E.164. The phone is the join between an admin-created owner row and the
 * Google account that will later adopt it, so a malformed one does not fail
 * here — it fails weeks later as an owner who cannot sign in.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

export function validatePhone(phone: string): string {
  const trimmed = phone.trim();
  if (!E164.test(trimmed)) {
    throw new AdminError(400, 'BAD_PHONE', 'phone must be E.164, e.g. +919876543210');
  }
  return trimmed;
}

export function validateCoords(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new AdminError(400, 'BAD_LAT', 'lat must be between -90 and 90');
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new AdminError(400, 'BAD_LNG', 'lng must be between -180 and 180');
  }
}

/**
 * A bad zone is stored happily and then throws inside zonedTimeToUtc on every
 * availability request for that salon, which reads as a broken engine rather
 * than a typo in an onboarding form.
 */
export function validateTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    throw new AdminError(400, 'BAD_TIMEZONE', `${tz} is not an IANA time zone, e.g. Asia/Kolkata`);
  }
}

export function validateCommissionBps(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new AdminError(400, 'BAD_COMMISSION', 'commissionBps must be an integer between 0 and 10000');
  }
  return bps;
}

// ---------- the status machine ----------

/**
 * Written down once rather than as four ifs across a route file, the way
 * booking/status.ts does it. 'banned' is terminal: a salon that defrauded
 * customers is not un-banned by clicking the wrong button twice.
 */
const ALLOWED_STATUS: Record<SalonStatus, SalonStatus[]> = {
  pending: ['active', 'banned'],
  active: ['suspended', 'banned'],
  suspended: ['active', 'banned'],
  banned: [],
};

export function canChangeStatus(from: SalonStatus, to: SalonStatus): boolean {
  return ALLOWED_STATUS[from].includes(to);
}

// ---------- list + filter ----------

export interface AdminSalonRow {
  id: string;
  name: string;
  city: string | null;
  area: string | null;
  address: string;
  status: SalonStatus;
  commissionBps: number;
  ownerId: string;
  ownerName: string | null;
  ownerPhone: string;
  ownerEmail: string | null;
  ownerHasSignedIn: boolean;
  serviceCount: number;
  bookingCount: number;
  createdAt: string;
  approvedAt: string | null;
}

export async function listSalonsForAdmin(
  db: Queryable,
  filters: { status?: string; city?: string; q?: string; limit?: number } = {},
): Promise<AdminSalonRow[]> {
  const { status, city, q, limit = 100 } = filters;

  // Unlike the public listSalons, this returns every status — the pending ones
  // are the entire point of the screen.
  const res = await db.query<{
    id: string; name: string; city: string | null; area: string | null; address: string;
    status: SalonStatus; commission_bps: number; owner_id: string; owner_name: string | null;
    owner_phone: string; owner_email: string | null; owner_signed_in: boolean;
    service_count: string; booking_count: string; created_at: Date; approved_at: Date | null;
  }>(
    `SELECT s.id, s.name, s.city, s.area, s.address, s.status, s.commission_bps,
            u.id AS owner_id, u.name AS owner_name, u.phone AS owner_phone,
            u.email AS owner_email,
            (u.firebase_uid IS NOT NULL) AS owner_signed_in,
            (SELECT count(*)::int8 FROM salon_services ss
              WHERE ss.salon_id = s.id AND ss.active)          AS service_count,
            (SELECT count(*)::int8 FROM bookings b
              WHERE b.salon_id = s.id)                          AS booking_count,
            s.created_at, s.approved_at
       FROM salons s
       JOIN users u ON u.id = s.owner_id
      WHERE ($1::text IS NULL OR s.status = $1)
        AND ($2::text IS NULL OR s.city = $2)
        AND ($3::text IS NULL OR s.name ILIKE '%' || $3 || '%'
                              OR s.address ILIKE '%' || $3 || '%'
                              OR u.phone ILIKE '%' || $3 || '%'
                              OR u.email ILIKE '%' || $3 || '%')
      ORDER BY
        -- pending first: this list is the admin's inbox, not an archive
        CASE s.status WHEN 'pending' THEN 0 ELSE 1 END,
        s.created_at DESC
      LIMIT $4`,
    [status ?? null, city ?? null, q ?? null, limit],
  );

  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    city: r.city,
    area: r.area,
    address: r.address,
    status: r.status,
    commissionBps: r.commission_bps,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    ownerPhone: r.owner_phone,
    ownerEmail: r.owner_email,
    ownerHasSignedIn: r.owner_signed_in,
    serviceCount: Number(r.service_count),
    bookingCount: Number(r.booking_count),
    createdAt: r.created_at.toISOString(),
    approvedAt: r.approved_at ? r.approved_at.toISOString() : null,
  }));
}

export async function listCities(db: Queryable): Promise<Array<{ city: string; count: number }>> {
  const res = await db.query<{ city: string; n: string }>(
    `SELECT city, count(*)::int8 AS n FROM salons
      WHERE city IS NOT NULL GROUP BY city ORDER BY city`,
  );
  return res.rows.map((r) => ({ city: r.city, count: Number(r.n) }));
}

// ---------- onboarding ----------

export interface OnboardInput {
  name: string;
  address: string;
  city: string;
  area?: string | null;
  lat: number;
  lng: number;
  timezone?: string;
  commissionBps?: number;
  status?: 'pending' | 'active';
  phone?: string | null;
  email?: string | null;
  owner: { phone: string; name?: string | null; email?: string | null };
}

const DEFAULT_HOURS = {
  openAt: '10:00',
  closeAt: '20:00',
  onlineCapacity: 1,
  slotIntervalMin: 30,
};

/**
 * Create a salon and the owner row that will later be adopted by a Google
 * sign-in.
 *
 * The owner is upserted by phone and left WITHOUT a firebase_uid on purpose.
 * resolveSession's `ON CONFLICT (phone) DO UPDATE` sets firebase_uid on first
 * sign-in and does not touch role, so the 'business' assigned here survives.
 * That one clause is the whole owner-onboarding mechanism; nothing else here
 * may set firebase_uid.
 */
export async function onboardSalon(
  db: Pool,
  adminUserId: string,
  input: OnboardInput,
  now: Date = new Date(),
): Promise<{ salonId: string; ownerId: string; ownerExisted: boolean }> {
  const phone = validatePhone(input.owner.phone);
  validateCoords(input.lat, input.lng);
  const timezone = validateTimezone(input.timezone ?? 'Asia/Kolkata');
  const commissionBps = validateCommissionBps(
    input.commissionBps ?? Number(process.env['PLATFORM_COMMISSION_BPS'] ?? 1500),
  );
  const status = input.status ?? 'pending';
  if (status !== 'pending' && status !== 'active') {
    throw new AdminError(400, 'BAD_STATUS', "status must be 'pending' or 'active' at creation");
  }
  if (!input.name.trim()) throw new AdminError(400, 'BAD_NAME', 'name is required');
  if (!input.address.trim()) throw new AdminError(400, 'BAD_ADDRESS', 'address is required');
  if (!input.city.trim()) throw new AdminError(400, 'BAD_CITY', 'city is required');

  return withTransaction(db, async (tx) => {
    const existing = await tx.query<{ id: string; role: string }>(
      `SELECT id, role FROM users WHERE phone = $1 FOR UPDATE`,
      [phone],
    );

    let ownerId: string;
    const ownerExisted = existing.rows.length > 0;

    if (ownerExisted) {
      const owner = existing.rows[0]!;
      const owns = await tx.query<{ id: string }>(`SELECT id FROM salons WHERE owner_id = $1`, [owner.id]);
      if (owns.rows.length > 0) {
        throw new AdminError(
          409,
          'OWNER_HAS_SALON',
          'That phone number already owns a salon. One owner, one salon — register a separate owner.',
        );
      }
      if (owner.role === 'admin') {
        throw new AdminError(
          409,
          'OWNER_IS_ADMIN',
          'That phone number belongs to a platform admin. Use a separate account for the salon owner.',
        );
      }
      // A customer who is now opening a salon keeps their bookings and gains
      // the panel. Their role is re-derived from ADMIN_EMAILS on sign-in, and
      // that rule only ever touches 'admin', so 'business' sticks.
      ownerId = owner.id;
      await tx.query(
        `UPDATE users
            SET role = 'business',
                name  = coalesce(name, $2),
                email = coalesce(email, $3),
                updated_at = now()
          WHERE id = $1`,
        [ownerId, input.owner.name ?? null, input.owner.email ?? null],
      );
    } else {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO users (phone, name, email, role) VALUES ($1, $2, $3, 'business') RETURNING id`,
        [phone, input.owner.name ?? null, input.owner.email ?? null],
      );
      ownerId = created.rows[0]!.id;
    }

    const salon = await tx.query<{ id: string }>(
      `INSERT INTO salons (owner_id, name, address, city, area, lat, lng, timezone,
                           status, commission_bps, phone, email, onboarded_by,
                           approved_by, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        ownerId, input.name.trim(), input.address.trim(), input.city.trim(),
        input.area?.trim() || null, input.lat, input.lng, timezone, status, commissionBps,
        input.phone ?? null, input.email ?? null, adminUserId,
        status === 'active' ? adminUserId : null,
        status === 'active' ? now : null,
      ],
    );
    const salonId = salon.rows[0]!.id;

    // Seven days of hours up front. An active salon with no salon_hours rows
    // renders as permanently closed with no explanation — the availability
    // engine treats a missing weekday as a non-working day, correctly, and the
    // operator has no way to tell that from a bug.
    for (let weekday = 0; weekday < 7; weekday++) {
      await tx.query(
        `INSERT INTO salon_hours (salon_id, weekday, open_at, close_at, break_start,
                                  break_end, online_capacity, slot_interval_min)
         VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6)`,
        [salonId, weekday, DEFAULT_HOURS.openAt, DEFAULT_HOURS.closeAt,
         DEFAULT_HOURS.onlineCapacity, DEFAULT_HOURS.slotIntervalMin],
      );
    }

    await tx.query(
      `INSERT INTO salon_status_events (salon_id, from_status, to_status, reason, actor_id)
       VALUES ($1, NULL, $2, 'onboarded', $3)`,
      [salonId, status, adminUserId],
    );

    return { salonId, ownerId, ownerExisted };
  });
}

export interface UpdateSalonInput {
  name?: string;
  address?: string;
  city?: string;
  area?: string | null;
  lat?: number;
  lng?: number;
  timezone?: string;
  commissionBps?: number;
  phone?: string | null;
  email?: string | null;
}

export async function updateSalon(db: Queryable, salonId: string, input: UpdateSalonInput): Promise<void> {
  if (input.lat !== undefined || input.lng !== undefined) {
    if (input.lat === undefined || input.lng === undefined) {
      throw new AdminError(400, 'BAD_COORDS', 'lat and lng must be changed together');
    }
    validateCoords(input.lat, input.lng);
  }
  if (input.timezone !== undefined) validateTimezone(input.timezone);
  if (input.commissionBps !== undefined) validateCommissionBps(input.commissionBps);

  const sets: string[] = [];
  const params: unknown[] = [salonId];
  const push = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };

  if (input.name !== undefined) push('name', input.name.trim());
  if (input.address !== undefined) push('address', input.address.trim());
  if (input.city !== undefined) push('city', input.city.trim());
  if (input.area !== undefined) push('area', input.area?.trim() || null);
  if (input.lat !== undefined) push('lat', input.lat);
  if (input.lng !== undefined) push('lng', input.lng);
  if (input.timezone !== undefined) push('timezone', input.timezone);
  if (input.commissionBps !== undefined) push('commission_bps', input.commissionBps);
  if (input.phone !== undefined) push('phone', input.phone);
  if (input.email !== undefined) push('email', input.email);

  if (sets.length === 0) return;

  const res = await db.query(`UPDATE salons SET ${sets.join(', ')} WHERE id = $1`, params);
  if (res.rowCount === 0) throw new AdminError(404, 'NOT_FOUND', 'No such salon');
}

// ---------- status changes ----------

export interface StatusChangeResult {
  salonId: string;
  from: SalonStatus;
  to: SalonStatus;
  cancelledBookings: number;
  refundsQueued: number;
}

/**
 * Change a salon's status, optionally cancelling what it has already promised.
 *
 * createBooking already refuses a non-active salon, so no NEW bookings follow.
 * Existing future ones are the trap: suspending a salon with fourteen bookings
 * tomorrow otherwise leaves fourteen customers turning up at a shop the
 * platform has switched off. Cancelling is opt-in because deactivating to fix
 * a typo should not refund a day of trade, but the caller must decide.
 */
export async function changeSalonStatus(
  db: Pool,
  adminUserId: string,
  salonId: string,
  to: SalonStatus,
  opts: { reason?: string | null; cancelFutureBookings?: boolean; now?: Date } = {},
): Promise<StatusChangeResult> {
  const now = opts.now ?? new Date();

  return withTransaction(db, async (tx) => {
    const res = await tx.query<{ status: SalonStatus }>(
      `SELECT status FROM salons WHERE id = $1 FOR UPDATE`,
      [salonId],
    );
    const row = res.rows[0];
    if (!row) throw new AdminError(404, 'NOT_FOUND', 'No such salon');

    const from = row.status;
    if (from === to) {
      throw new AdminError(409, 'NO_CHANGE', `The salon is already ${to}`);
    }
    if (!canChangeStatus(from, to)) {
      throw new AdminError(
        409,
        'INVALID_TRANSITION',
        from === 'banned'
          ? 'A banned salon is terminal and cannot be reinstated'
          : `Cannot go from ${from} to ${to}`,
      );
    }

    const goingLive = to === 'active';
    await tx.query(
      `UPDATE salons
          SET status = $2,
              approved_by = CASE WHEN $3 THEN $4 ELSE approved_by END,
              approved_at = CASE WHEN $3 AND approved_at IS NULL THEN $5 ELSE approved_at END
        WHERE id = $1`,
      [salonId, to, goingLive, adminUserId, now],
    );

    let cancelledBookings = 0;
    let refundsQueued = 0;

    if (opts.cancelFutureBookings && to !== 'active') {
      const cancelled = await tx.query<{ id: string }>(
        `UPDATE bookings
            SET status = 'cancelled_by_salon',
                cancelled_at = $3,
                refund_status = 'pending'
          WHERE salon_id = $1
            AND start_at >= $2
            AND status IN ('booked','verified','in_progress')
          RETURNING id`,
        [salonId, now, now],
      );
      cancelledBookings = cancelled.rowCount ?? 0;
      for (const b of cancelled.rows) {
        const outcome = await queueRefundForBooking(tx, b.id, `salon ${to} by platform`, now);
        if (outcome === 'queued') refundsQueued += 1;
        await cancelPending(tx, b.id, ['booking_reminder']);
      }
    }

    await tx.query(
      `INSERT INTO salon_status_events (salon_id, from_status, to_status, reason, actor_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [salonId, from, to, opts.reason ?? null, adminUserId],
    );

    return { salonId, from, to, cancelledBookings, refundsQueued };
  });
}

/** How many bookings a deactivation would strand, so the UI can ask before it does. */
export async function countFutureBookings(db: Queryable, salonId: string, now: Date = new Date()): Promise<number> {
  const res = await db.query<{ n: string }>(
    `SELECT count(*)::int8 AS n FROM bookings
      WHERE salon_id = $1 AND start_at >= $2
        AND status IN ('booked','verified','in_progress')`,
    [salonId, now],
  );
  return Number(res.rows[0]!.n);
}

export async function statusHistory(db: Queryable, salonId: string) {
  const res = await db.query<{
    from_status: string | null; to_status: string; reason: string | null;
    created_at: Date; actor_name: string | null; actor_email: string | null;
  }>(
    `SELECT e.from_status, e.to_status, e.reason, e.created_at,
            u.name AS actor_name, u.email AS actor_email
       FROM salon_status_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.salon_id = $1
      ORDER BY e.created_at DESC
      LIMIT 50`,
    [salonId],
  );
  return res.rows.map((r) => ({
    from: r.from_status,
    to: r.to_status,
    reason: r.reason,
    at: r.created_at.toISOString(),
    actor: r.actor_name ?? r.actor_email ?? 'system',
  }));
}

// ---------- detail ----------

export async function adminSalonDetail(db: Queryable, salonId: string) {
  const salon = await db.query<{
    id: string; name: string; address: string; city: string | null; area: string | null;
    lat: number; lng: number; timezone: string; status: SalonStatus; commission_bps: number;
    phone: string | null; email: string | null; created_at: Date; approved_at: Date | null;
    owner_id: string; owner_name: string | null; owner_phone: string; owner_email: string | null;
    owner_signed_in: boolean;
  }>(
    `SELECT s.id, s.name, s.address, s.city, s.area, s.lat, s.lng, s.timezone, s.status,
            s.commission_bps, s.phone, s.email, s.created_at, s.approved_at,
            u.id AS owner_id, u.name AS owner_name, u.phone AS owner_phone,
            u.email AS owner_email, (u.firebase_uid IS NOT NULL) AS owner_signed_in
       FROM salons s JOIN users u ON u.id = s.owner_id
      WHERE s.id = $1`,
    [salonId],
  );
  const s = salon.rows[0];
  if (!s) throw new AdminError(404, 'NOT_FOUND', 'No such salon');

  const bookings = await db.query<{
    id: string; start_at: Date; end_at: Date; status: string; amount: number;
    customer_name: string | null; customer_phone: string;
  }>(
    `SELECT b.id, b.start_at, b.end_at, b.status, b.amount,
            u.name AS customer_name, u.phone AS customer_phone
       FROM bookings b JOIN users u ON u.id = b.customer_id
      WHERE b.salon_id = $1
      ORDER BY b.start_at DESC
      LIMIT 20`,
    [salonId],
  );

  return {
    id: s.id,
    name: s.name,
    address: s.address,
    city: s.city,
    area: s.area,
    lat: s.lat,
    lng: s.lng,
    timezone: s.timezone,
    status: s.status,
    commissionBps: s.commission_bps,
    phone: s.phone,
    email: s.email,
    createdAt: s.created_at.toISOString(),
    approvedAt: s.approved_at ? s.approved_at.toISOString() : null,
    owner: {
      id: s.owner_id,
      name: s.owner_name,
      phone: s.owner_phone,
      email: s.owner_email,
      hasSignedIn: s.owner_signed_in,
    },
    recentBookings: bookings.rows.map((b) => ({
      id: b.id,
      startAt: b.start_at.toISOString(),
      endAt: b.end_at.toISOString(),
      status: b.status,
      amount: b.amount,
      customerName: b.customer_name,
      customerPhone: b.customer_phone,
    })),
  };
}

// ---------- catalogue ----------

export async function listCatalogue(db: Queryable) {
  const res = await db.query<{ id: string; name: string; category: string; usage: string }>(
    `SELECT sv.id, sv.name, sv.category,
            (SELECT count(*)::int8 FROM salon_services ss WHERE ss.service_id = sv.id) AS usage
       FROM services sv ORDER BY sv.category, sv.name`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    usageCount: Number(r.usage),
  }));
}

export async function addCatalogueService(db: Queryable, name: string, category: string) {
  const n = name.trim();
  const c = category.trim().toLowerCase();
  if (!n) throw new AdminError(400, 'BAD_NAME', 'name is required');
  if (!c) throw new AdminError(400, 'BAD_CATEGORY', 'category is required');

  const res = await db.query<{ id: string }>(
    `INSERT INTO services (name, category) VALUES ($1, $2)
     ON CONFLICT (name) DO NOTHING RETURNING id`,
    [n, c],
  );
  const row = res.rows[0];
  if (!row) throw new AdminError(409, 'DUPLICATE', `The catalogue already has a service called "${n}"`);
  return { id: row.id, name: n, category: c };
}

/**
 * Only when nothing references it. A hard delete of a service in use would
 * cascade into booking_items and rewrite what customers were actually sold.
 */
export async function deleteCatalogueService(db: Queryable, serviceId: string): Promise<void> {
  const used = await db.query<{ n: string }>(
    `SELECT count(*)::int8 AS n FROM salon_services WHERE service_id = $1`,
    [serviceId],
  );
  if (Number(used.rows[0]!.n) > 0) {
    throw new AdminError(
      409,
      'SERVICE_IN_USE',
      `${used.rows[0]!.n} salon(s) offer this service. Remove it from their menus first.`,
    );
  }
  const res = await db.query(`DELETE FROM services WHERE id = $1`, [serviceId]);
  if (res.rowCount === 0) throw new AdminError(404, 'NOT_FOUND', 'No such service');
}

// ---------- overview ----------

export async function adminOverview(db: Queryable, now: Date = new Date()) {
  const res = await db.query<{
    pending: string; active: string; suspended: string; banned: string;
    no_services: string; owners_never_signed_in: string;
    bookings_today: string; gmv_month: string | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'pending')::int8   AS pending,
       count(*) FILTER (WHERE status = 'active')::int8    AS active,
       count(*) FILTER (WHERE status = 'suspended')::int8 AS suspended,
       count(*) FILTER (WHERE status = 'banned')::int8    AS banned,
       -- onboarded but never set up: the ones that need chasing
       count(*) FILTER (
         WHERE status IN ('pending','active')
           AND NOT EXISTS (SELECT 1 FROM salon_services ss
                            WHERE ss.salon_id = salons.id AND ss.active)
       )::int8 AS no_services,
       (SELECT count(*)::int8 FROM users u
         WHERE u.role = 'business' AND u.firebase_uid IS NULL) AS owners_never_signed_in,
       (SELECT count(*)::int8 FROM bookings b
         WHERE b.start_at >= date_trunc('day', $1::timestamptz)
           AND b.start_at <  date_trunc('day', $1::timestamptz) + interval '1 day') AS bookings_today,
       (SELECT sum(b.amount) FROM bookings b
         WHERE b.start_at >= date_trunc('month', $1::timestamptz)
           AND b.status IN ('booked','verified','in_progress','completed')) AS gmv_month
     FROM salons`,
    [now],
  );
  const r = res.rows[0]!;
  return {
    pending: Number(r.pending),
    active: Number(r.active),
    suspended: Number(r.suspended),
    banned: Number(r.banned),
    salonsWithoutServices: Number(r.no_services),
    ownersNeverSignedIn: Number(r.owners_never_signed_in),
    bookingsToday: Number(r.bookings_today),
    gmvThisMonth: Number(r.gmv_month ?? 0),
  };
}
