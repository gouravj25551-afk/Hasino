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
import { claimStagedImage } from '../salons/images.ts';
import { queueRefundForBooking } from '../payments/service.ts';
import { geocodeAddress } from '../geo/geocode.ts';
import { cancelPending, enqueueNotification } from '../notify/outbox.ts';

type Queryable = Pool | PoolClient;

export type SalonStatus = 'pending' | 'active' | 'suspended' | 'banned' | 'rejected';

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

/** E.164. Stored so the platform can ring the owner; not an identity. */
const E164 = /^\+[1-9]\d{7,14}$/;

export function validatePhone(phone: string): string {
  const trimmed = phone.trim();
  if (!E164.test(trimmed)) {
    throw new AdminError(400, 'BAD_PHONE', 'phone must be E.164, e.g. +919876543210');
  }
  return trimmed;
}

/**
 * The owner's email is the join between the row created here and the Google
 * account that will later adopt it, so a typo does not fail here — it fails
 * weeks later as an owner who cannot sign in and a salon nobody can open.
 *
 * Deliberately a shape check and nothing cleverer: the address is proven by
 * Google at sign-in, and this only has to stop the obvious mistakes. Lowercased
 * because the match at sign-in is case-insensitive and storing it as typed
 * makes the stored value look different from the one that matched.
 */
export function validateEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new AdminError(
      400,
      'BAD_EMAIL',
      "owner email must be a valid address — it is how the owner's Google sign-in finds this salon",
    );
  }
  return trimmed;
}

/**
 * Where a salon is, from what the operator actually knows.
 *
 * Coordinates are optional on both onboarding paths now. When they are given
 * — an owner standing in their own shop, tapping "use my location" — they are
 * trusted and validated. When they are not, the address is geocoded.
 *
 * Hand-typed coordinates were the previous default and they were silently
 * wrong: a Jind salon stored at 12.83, 12.32 is a point in Chad, and nothing
 * in the product says so. It just sorts last, forever, for everyone.
 *
 * A failed geocode is an error rather than a guess. A salon at the wrong
 * coordinates is worse than one that could not be created: it takes bookings
 * from people who will not find it.
 */
export async function resolveCoords(input: {
  lat?: number | null;
  lng?: number | null;
  address: string;
  area?: string | null;
  city: string;
}): Promise<{ lat: number; lng: number }> {
  if (typeof input.lat === 'number' && typeof input.lng === 'number') {
    validateCoords(input.lat, input.lng);
    return { lat: input.lat, lng: input.lng };
  }

  const place = await geocodeAddress({ address: input.address, area: input.area ?? null, city: input.city });
  if (!place) {
    throw new AdminError(
      400,
      'ADDRESS_NOT_FOUND',
      `Could not find "${[input.address, input.area, input.city].filter(Boolean).join(', ')}" on the map. `
        + 'Check the address and city, or supply lat and lng directly.',
    );
  }
  validateCoords(place.lat, place.lng);
  return { lat: place.lat, lng: place.lng };
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
  // An application is approved, turned down, or — for an outright fraudulent
  // one — banned. 'rejected' rather than 'banned' for the ordinary no, because
  // banned is terminal and a rejection usually means "not like this".
  pending: ['active', 'rejected', 'banned'],
  active: ['suspended', 'banned'],
  suspended: ['active', 'banned'],
  // Reopened for review, never straight to live: a rejected application has to
  // go back through the same approval as every other one.
  rejected: ['pending', 'banned'],
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
  ownerPhone: string | null;
  ownerEmail: string | null;
  ownerHasSignedIn: boolean;
  serviceCount: number;
  bookingCount: number;
  createdAt: string;
  /** When the current request was submitted — moves on a resubmission. */
  submittedAt: string;
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
    owner_phone: string | null; owner_email: string | null; owner_signed_in: boolean;
    service_count: string; booking_count: string; created_at: Date; submitted_at: Date;
    approved_at: Date | null;
  }>(
    `SELECT s.id, s.name, s.city, s.area, s.address, s.status, s.commission_bps,
            u.id AS owner_id, u.name AS owner_name, u.phone AS owner_phone,
            u.email AS owner_email,
            (u.auth_provider_id IS NOT NULL) AS owner_signed_in,
            (SELECT count(*)::int8 FROM salon_services ss
              WHERE ss.salon_id = s.id AND ss.active)          AS service_count,
            (SELECT count(*)::int8 FROM bookings b
              WHERE b.salon_id = s.id)                          AS booking_count,
            s.created_at, s.submitted_at, s.approved_at
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
        -- and within that, by when the request was actually made. A
        -- resubmitted application is a new request and belongs at the top of
        -- the queue, not filed under the date its first attempt was created.
        s.submitted_at DESC
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
    submittedAt: r.submitted_at.toISOString(),
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
  /** Optional. Geocoded from the address when absent — see resolveCoords. */
  lat?: number | null;
  lng?: number | null;
  timezone?: string;
  commissionBps?: number;
  status?: 'pending' | 'active';
  phone?: string | null;
  email?: string | null;
  owner: { phone: string; email: string; name?: string | null };
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
 * The owner row is created WITHOUT an auth_provider_id on purpose.
 * resolveSession's claimByEmail() sets it on that owner's first sign-in,
 * matching on the verified email address and leaving role alone, so the
 * 'business' assigned here survives. That is the whole owner-onboarding
 * mechanism; nothing else here may set auth_provider_id.
 *
 * Which is why owner.email is required rather than optional. It used to be
 * the phone number that did this matching, and an email was a nicety; now it
 * is the only join key there is, and an owner row without one can never be
 * claimed by anybody — a salon that silently cannot be signed into.
 */
export async function onboardSalon(
  db: Pool,
  adminUserId: string,
  input: OnboardInput,
  now: Date = new Date(),
): Promise<{ salonId: string; ownerId: string; ownerExisted: boolean }> {
  const phone = validatePhone(input.owner.phone);
  const ownerEmail = validateEmail(input.owner.email);
  const { lat, lng } = await resolveCoords(input);
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
    // Matched on email, because that is what the owner's Google sign-in will
    // match on. Looking them up by phone here while sign-in looks them up by
    // email is how one person ends up with two rows.
    const existing = await tx.query<{ id: string; role: string }>(
      `SELECT id, role FROM users WHERE lower(email) = $1 FOR UPDATE`,
      [ownerEmail],
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
          'That email address already owns a salon. One owner, one salon — register a separate owner.',
        );
      }
      if (owner.role === 'admin') {
        throw new AdminError(
          409,
          'OWNER_IS_ADMIN',
          'That email address belongs to a platform admin. Use a separate account for the salon owner.',
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
                phone = coalesce(phone, $3),
                updated_at = now()
          WHERE id = $1`,
        [ownerId, input.owner.name ?? null, phone],
      );
    } else {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO users (phone, name, email, role) VALUES ($1, $2, $3, 'business') RETURNING id`,
        [phone, input.owner.name ?? null, ownerEmail],
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
        input.area?.trim() || null, lat, lng, timezone, status, commissionBps,
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

    // Approval is what makes someone a salon owner — not their application,
    // and not their Google account. It happens here, in the same transaction
    // as the status change, so a salon can never be live with an owner who
    // cannot open the panel, or the reverse.
    //
    // Only ever a promotion from 'customer'. An admin who owns a salon keeps
    // 'admin' (applyForSalon refuses them anyway), and the role is not taken
    // away on suspend: a suspended owner still needs to read their bookings
    // and fix whatever got them suspended.
    if (goingLive) {
      await tx.query(
        `UPDATE users
            SET role = 'business', updated_at = now()
          WHERE id = (SELECT owner_id FROM salons WHERE id = $1)
            AND role = 'customer'`,
        [salonId],
      );
    }

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
    phone: string | null; email: string | null; created_at: Date; submitted_at: Date;
    approved_at: Date | null;
    description: string | null; cover_url: string | null;
    owner_id: string; owner_name: string | null; owner_phone: string | null; owner_email: string | null;
    owner_signed_in: boolean; owner_role: string;
  }>(
    `SELECT s.id, s.name, s.address, s.city, s.area, s.lat, s.lng, s.timezone, s.status,
            s.commission_bps, s.phone, s.email, s.created_at, s.submitted_at, s.approved_at,
            s.description, s.cover_url,
            u.id AS owner_id, u.name AS owner_name, u.phone AS owner_phone,
            u.email AS owner_email, (u.auth_provider_id IS NOT NULL) AS owner_signed_in,
            u.role AS owner_role
       FROM salons s JOIN users u ON u.id = s.owner_id
      WHERE s.id = $1`,
    [salonId],
  );
  const s = salon.rows[0];
  if (!s) throw new AdminError(404, 'NOT_FOUND', 'No such salon');

  // The gallery the applicant submitted. This is most of what the admin is
  // actually judging, so it is part of the detail rather than a second call.
  const photos = await db.query<{ url: string }>(
    `SELECT url FROM salon_photos WHERE salon_id = $1 ORDER BY sort, id`,
    [salonId],
  );

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
    description: s.description,
    coverUrl: s.cover_url,
    photos: photos.rows.map((p) => p.url),
    createdAt: s.created_at.toISOString(),
    // When this request was submitted, which a resubmission moves and
    // createdAt does not. What the queue is ordered by.
    submittedAt: s.submitted_at.toISOString(),
    approvedAt: s.approved_at ? s.approved_at.toISOString() : null,
    owner: {
      id: s.owner_id,
      // Shown so the admin can see that approval is what grants this — a
      // pending application's owner is still a plain customer.
      role: s.owner_role,
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
         WHERE u.role = 'business' AND u.auth_provider_id IS NULL) AS owners_never_signed_in,
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

// ---------- self-serve application ----------

export interface ApplyInput {
  name: string;
  address: string;
  city: string;
  area?: string | null;
  /** Optional. Geocoded from the address when absent — see resolveCoords. */
  lat?: number | null;
  lng?: number | null;
  timezone?: string;
  phone?: string | null;
  email?: string | null;
  /** What the admin reads to decide this is a real salon. */
  description?: string | null;
  /** Storefront shot — the card image, and the one that shows a real shop. */
  coverUrl?: string | null;
  /** Gallery, in the order given. */
  photoUrls?: string[];
  /** Applied to all seven days; the owner refines them in their panel later. */
  openAt?: string | null;
  closeAt?: string | null;
  /**
   * The applicant's own name and number, as opposed to the salon's.
   *
   * Google supplies a name and no number, so the admin reviewing an
   * application had a business to ring and no person — and `users.phone` is
   * null for every account created since sign-in stopped asking for one.
   * These are contact details, never identity: who the applicant *is* comes
   * from the session, and this cannot reassign an application to anyone else.
   * They are written onto the applicant's own users row.
   */
  ownerName?: string | null;
  ownerPhone?: string | null;
  /**
   * The menu, picked from the public service catalogue. Priced here so the
   * admin can see what this salon intends to charge before approving it — a
   * salon with no menu is invisible to customers anyway, so collecting it at
   * application time is one less thing an approved owner has to do before they
   * are of any use.
   */
  services?: Array<{ serviceId: string; price: number; durationMin?: number }>;
}

/** 'HH:MM', 24-hour. salon_hours stores a wall-clock time. */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateHhmm(value: string, field: string): string {
  if (!HHMM.test(value)) throw new AdminError(400, 'BAD_HOURS', `${field} must be HH:MM, e.g. 09:30`);
  return value;
}

/**
 * Only http(s), and only a bare URL.
 *
 * These are rendered into <img src> in both panels and the customer app. A
 * `javascript:` or `data:` URL there is stored XSS with an admin as the most
 * likely viewer — the one person who opens every application that gets
 * submitted.
 */
function validatePhotoUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AdminError(400, 'BAD_PHOTO_URL', `${trimmed.slice(0, 60)} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AdminError(400, 'BAD_PHOTO_URL', 'photo URLs must be http(s)');
  }
  return trimmed;
}

/**
 * "List your salon", for a signed-in customer.
 *
 * Always pending, and the applicant becomes the owner. Granting 'business'
 * here is safe: the role only ever unlocks salonForOwner(ownerId), which is
 * their own pending salon, and listSalons filters status='active' so nothing
 * is publicly visible until an admin approves. They can set up their menu and
 * hours while they wait, which is the point.
 *
 * The applicant's phone comes from their session — already verified by
 * the identity provider — never from the request body.
 */
export async function applyForSalon(
  db: Pool,
  // phone is nullable: a Google sign-in carries none, and the number the admin
  // actually needs to ring is the salon's own, which is a field on the form.
  applicant: { userId: string; phone: string | null; name: string | null; email: string | null },
  input: ApplyInput,
): Promise<{ salonId: string }> {
  const { lat, lng } = await resolveCoords(input);
  const timezone = validateTimezone(input.timezone ?? 'Asia/Kolkata');
  if (!input.name.trim()) throw new AdminError(400, 'BAD_NAME', 'name is required');
  if (!input.address.trim()) throw new AdminError(400, 'BAD_ADDRESS', 'address is required');
  if (!input.city.trim()) throw new AdminError(400, 'BAD_CITY', 'city is required');

  const commissionBps = validateCommissionBps(Number(process.env['PLATFORM_COMMISSION_BPS'] ?? 1500));

  const openAt = validateHhmm(input.openAt?.trim() || DEFAULT_HOURS.openAt, 'openAt');
  const closeAt = validateHhmm(input.closeAt?.trim() || DEFAULT_HOURS.closeAt, 'closeAt');
  if (openAt >= closeAt) {
    // Lexicographic works on zero-padded HH:MM and says what it means.
    throw new AdminError(400, 'BAD_HOURS', 'closing time must be after opening time');
  }
  // The applicant's own number, in the same E.164 shape every other phone on
  // the platform uses. Optional — a Google account has none and the salon's
  // own number is the required one — but a value that is present has to be
  // dialable, or it is worse than blank.
  const ownerPhone = input.ownerPhone?.trim() ? validatePhone(input.ownerPhone) : null;
  const ownerName = input.ownerName?.trim() ? input.ownerName.trim().slice(0, 120) : null;

  const coverUrl = input.coverUrl?.trim() ? validatePhotoUrl(input.coverUrl) : null;
  const photoUrls = (input.photoUrls ?? []).filter((u) => u.trim()).map(validatePhotoUrl).slice(0, 12);

  // Priced in paise, like everything else that touches money here. A price of
  // zero is a free service and legitimate; a negative one is not.
  const services = (input.services ?? []).filter((x) => x && x.serviceId);
  for (const svc of services) {
    if (!Number.isInteger(svc.price) || svc.price < 0 || svc.price > 10_000_00) {
      throw new AdminError(400, 'BAD_PRICE', 'each service price must be a whole number of paise, 0 to 1000000');
    }
    if (svc.durationMin !== undefined && (!Number.isInteger(svc.durationMin) || svc.durationMin < 5 || svc.durationMin > 480)) {
      throw new AdminError(400, 'BAD_DURATION', 'each service duration must be 5 to 480 minutes');
    }
  }

  return withTransaction(db, async (tx) => {
    const owns = await tx.query<{ id: string; status: SalonStatus }>(
      `SELECT id, status FROM salons WHERE owner_id = $1 FOR UPDATE`,
      [applicant.userId],
    );
    const existing = owns.rows[0];

    // A turned-down application can be resubmitted. It goes back to 'pending'
    // and is reviewed again like any other — reapplying is not a way around
    // approval, it is a way to fix whatever the rejection was about. Every
    // other state is a real conflict: one owner, one salon.
    if (existing && existing.status !== 'rejected') {
      throw new AdminError(409, 'ALREADY_OWNS_SALON', 'You already have a salon on Hasino.');
    }
    const role = await tx.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [applicant.userId]);
    if (role.rows[0]?.role === 'admin') {
      throw new AdminError(
        409,
        'ADMIN_CANNOT_APPLY',
        'Platform admins cannot own a salon. Onboard it to a separate account from /admin.',
      );
    }

    // A resubmission updates the row it was rejected on rather than replacing
    // it. salon_status_events cascades on delete, so recreating the row would
    // erase the fact that this application was once turned down — which is the
    // first thing an admin looking at it again should see.
    const fields = [
      applicant.userId, input.name.trim(), input.address.trim(), input.city.trim(),
      input.area?.trim() || null, lat, lng, timezone, commissionBps,
      input.phone ?? null, input.email ?? null,
      input.description?.trim() || null, coverUrl,
    ];
    // submitted_at moves on every submission, created_at never does: one is
    // "when was this request made", which a resubmission changes, and the
    // other is "when did this salon first exist", which it does not. The
    // pending queue is ordered by the first.
    const salon = existing
      ? await tx.query<{ id: string }>(
          `UPDATE salons
              SET owner_id = $1, name = $2, address = $3, city = $4, area = $5,
                  lat = $6, lng = $7, timezone = $8, status = 'pending',
                  commission_bps = $9, phone = $10, email = $11,
                  description = $12,
                  -- coalesce, not assignment: a resubmission that supplies no
                  -- photo means "I did not change it", not "delete it". The
                  -- straight assignment orphaned an uploaded image — the row
                  -- stayed in salon_images and cover_url stopped pointing at
                  -- it. A staged upload overwrites this a few lines below.
                  cover_url = coalesce($13, cover_url),
                  submitted_at = now()
            WHERE id = $14
            RETURNING id`,
          [...fields, existing.id],
        )
      : await tx.query<{ id: string }>(
          `INSERT INTO salons (owner_id, name, address, city, area, lat, lng, timezone,
                               status, commission_bps, phone, email, description, cover_url,
                               submitted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12,$13, now())
           RETURNING id`,
          fields,
        );
    const salonId = salon.rows[0]!.id;

    // The applicant's own contact details, onto their own row and nowhere
    // else. coalesce so a blank field never wipes a number an admin recorded,
    // and the id is the session's — this cannot touch another account.
    if (ownerName || ownerPhone) {
      await tx.query(
        `UPDATE users
            SET name  = coalesce($2, name),
                phone = coalesce($3, phone),
                updated_at = now()
          WHERE id = $1`,
        [applicant.userId, ownerName, ownerPhone],
      );
    }

    if (existing) {
      // The previous submission's menu, photos and hours are replaced by this
      // one; leaving them would merge two different applications.
      await tx.query(`DELETE FROM salon_photos WHERE salon_id = $1`, [salonId]);
      await tx.query(`DELETE FROM salon_services WHERE salon_id = $1`, [salonId]);
      await tx.query(`DELETE FROM salon_hours WHERE salon_id = $1`, [salonId]);
    }

    for (const [i, url] of photoUrls.entries()) {
      await tx.query(
        `INSERT INTO salon_photos (salon_id, url, sort) VALUES ($1, $2, $3)`,
        [salonId, url, i],
      );
    }

    for (const svc of services) {
      // ON CONFLICT because a form can submit the same service twice; the last
      // price wins rather than the insert blowing up the whole application.
      await tx.query(
        `INSERT INTO salon_services (salon_id, service_id, price, duration_min, buffer_min, active)
         VALUES ($1, $2, $3, $4, 0, true)
         ON CONFLICT (salon_id, service_id) DO UPDATE
           SET price = EXCLUDED.price, duration_min = EXCLUDED.duration_min, active = true`,
        [salonId, svc.serviceId, svc.price, svc.durationMin ?? 30],
      );
    }

    // The storefront photo, if one was uploaded before this was submitted.
    //
    // In this transaction on purpose: an application that was accepted and
    // whose photo silently stayed in staging is the half-state worth designing
    // out. It runs after the row is written because it needs the salon id, and
    // it overwrites cover_url — an uploaded photo beats a pasted link, which
    // is the more deliberate of the two acts and the one Hasino hosts itself.
    await claimStagedImage(tx, applicant.userId, salonId);

    // The applicant is deliberately NOT promoted here. Signing in with Google
    // proves who they are; it proves nothing about the salon. Granting
    // 'business' on submission would hand the panel — and a live-looking salon
    // — to anyone who filled in a form, which is the whole thing approval
    // exists to prevent. The role is granted by changeSalonStatus() when an
    // admin approves, and only then.

    // Seven default rows so an approved salon is never live-with-no-hours: the
    // availability engine reads a missing weekday as closed, correctly, and the
    // operator has no way to tell that from a bug.
    for (let weekday = 0; weekday < 7; weekday++) {
      await tx.query(
        `INSERT INTO salon_hours (salon_id, weekday, open_at, close_at, break_start,
                                  break_end, online_capacity, slot_interval_min)
         VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6)`,
        [salonId, weekday, openAt, closeAt,
         DEFAULT_HOURS.onlineCapacity, DEFAULT_HOURS.slotIntervalMin],
      );
    }

    await tx.query(
      `INSERT INTO salon_status_events (salon_id, from_status, to_status, reason, actor_id)
       VALUES ($1, $2, 'pending', $3, $4)`,
      [
        salonId,
        existing ? 'rejected' : null,
        existing ? 'resubmitted by the applicant' : 'self-serve application',
        applicant.userId,
      ],
    );

    // Tell whoever empties the queue. Best-effort, inside the transaction so a
    // created application always has its notification.
    for (const to of adminNotificationAddresses()) {
      await enqueueNotification(tx, {
        userId: null,
        channel: 'email',
        template: 'salon_application',
        to,
        payload: {
          salonId,
          salonName: input.name.trim(),
          city: input.city.trim(),
          address: input.address.trim(),
          ownerName: ownerName ?? applicant.name,
          ownerPhone: ownerPhone ?? applicant.phone,
          ownerEmail: applicant.email,
        },
        dedupeKey: `salon_application:${salonId}:${to}`,
      });
    }

    return { salonId };
  });
}

function adminNotificationAddresses(): string[] {
  return (process.env['ADMIN_EMAILS'] ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}
