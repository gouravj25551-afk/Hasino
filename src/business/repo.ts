import type { Pool, PoolClient } from '../db/pool.ts';
import { addDays, localDateKey, zonedTimeToUtc } from '../time/tz.ts';
import { noShowAvailableAt } from '../booking/status.ts';
import { chairConsumingSql } from '../booking/occupancy.ts';
import { resolveCoords } from '../admin/repo.ts';

type Queryable = Pool | PoolClient;

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(message = 'You do not own this salon') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Every business endpoint goes through this. Ownership is never taken on trust. */
export async function salonForOwner(
  db: Queryable,
  ownerId: string,
): Promise<{
  id: string;
  name: string;
  timezone: string;
  status: string;
  rzpKycStatus: string;
  commissionBps: number;
  /** Same field the customer app reads, so both show the same picture. */
  coverImage: string | null;
}> {
  const res = await db.query<{
    id: string;
    name: string;
    timezone: string;
    status: string;
    rzp_kyc_status: string;
    commission_bps: number;
    cover_url: string | null;
  }>(
    `SELECT id, name, timezone, status, rzp_kyc_status, commission_bps, cover_url
       FROM salons WHERE owner_id = $1`,
    [ownerId],
  );
  const row = res.rows[0];
  if (!row) throw new ForbiddenError('No salon is registered to this account');
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    status: row.status,
    rzpKycStatus: row.rzp_kyc_status,
    commissionBps: row.commission_bps,
    coverImage: row.cover_url,
  };
}

// ---------- the salon's own profile ----------

/**
 * Everything the owner's Profile screen shows, from the salon row it already
 * has. No new table and no second copy: these are the same columns the
 * customer app reads for the salon card and detail page, which is what makes
 * an edit here visible there.
 *
 * The email is the salon's own contact address (salons.email), not the account
 * the owner signs in with — that one belongs to Clerk and is never editable
 * from a form. The account identity is reported separately so the screen can
 * say whose it is without offering to change it.
 */
export async function salonProfile(db: Queryable, salonId: string) {
  const res = await db.query<{
    id: string;
    name: string;
    description: string | null;
    address: string;
    city: string | null;
    area: string | null;
    lat: number;
    lng: number;
    phone: string | null;
    email: string | null;
    timezone: string;
    status: string;
    cover_url: string | null;
    owner_email: string | null;
    owner_name: string | null;
    chairs: number[];
    working_days: number;
  }>(
    `SELECT s.id, s.name, s.description, s.address, s.city, s.area, s.lat, s.lng,
            s.phone, s.email, s.timezone, s.status, s.cover_url,
            u.email AS owner_email, u.name AS owner_name,
            coalesce(
              (SELECT array_agg(DISTINCT sh.online_capacity) FROM salon_hours sh WHERE sh.salon_id = s.id),
              '{}'
            ) AS chairs,
            (SELECT count(*)::int FROM salon_hours sh WHERE sh.salon_id = s.id) AS working_days
       FROM salons s
       JOIN users u ON u.id = s.owner_id
      WHERE s.id = $1`,
    [salonId],
  );
  const r = res.rows[0];
  if (!r) throw new ForbiddenError('No salon is registered to this account');

  const distinct = r.chairs.map(Number).sort((a, b) => a - b);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    address: r.address,
    city: r.city,
    area: r.area,
    lat: r.lat,
    lng: r.lng,
    phone: r.phone,
    email: r.email,
    timezone: r.timezone,
    status: r.status,
    coverImage: r.cover_url,
    // Who this account is, for display only. Changing it is Clerk's business.
    account: { email: r.owner_email, name: r.owner_name },
    // One number when every working day runs on the same count, which is the
    // normal case; null when they differ, and the screen sends the owner to
    // Timings rather than flattening a deliberate Sunday difference.
    chairs: distinct.length === 1 ? distinct[0]! : null,
    chairsVary: distinct.length > 1,
    workingDays: Number(r.working_days),
  };
}

export interface ProfileInput {
  name: string;
  description: string | null;
  address: string;
  city: string;
  area: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * Save the salon's own details.
 *
 * The address is geocoded when it changes, because lat/lng is what customer
 * discovery sorts by: an owner who corrects their street and keeps the old
 * pin is a salon that shows up in the wrong part of town. A geocoder that
 * cannot place the new address leaves the old coordinates alone and says so —
 * better a stale pin than one in the sea.
 *
 * `salonId` is resolved from the authenticated owner by the route. Nothing
 * here takes a salon id from a request body.
 */
export async function updateSalonProfile(
  db: Queryable,
  salonId: string,
  input: ProfileInput,
): Promise<{ geocoded: boolean }> {
  const name = input.name.trim();
  const address = input.address.trim();
  const city = input.city.trim();
  if (!name) throw new Error('name is required');
  if (!address) throw new Error('address is required');
  if (!city) throw new Error('city is required');
  if (name.length > 120) throw new Error('name must be 120 characters or fewer');
  if ((input.description ?? '').length > 2000) {
    throw new Error('description must be 2000 characters or fewer');
  }

  const current = await db.query<{ address: string; city: string | null; area: string | null }>(
    `SELECT address, city, area FROM salons WHERE id = $1`,
    [salonId],
  );
  const before = current.rows[0];
  if (!before) throw new ForbiddenError('No salon is registered to this account');

  const area = input.area?.trim() || null;
  const moved =
    before.address !== address || (before.city ?? '') !== city || (before.area ?? '') !== (area ?? '');

  let coords: { lat: number; lng: number } | null = null;
  if (moved) {
    try {
      coords = await resolveCoords({ address, city, area });
    } catch {
      // Keep the pin the salon already had. The alternative is refusing an
      // otherwise valid edit because a third-party geocoder was down.
      coords = null;
    }
  }

  await db.query(
    `UPDATE salons
        SET name = $2, description = $3, address = $4, city = $5, area = $6,
            phone = $7, email = $8,
            lat = coalesce($9, lat), lng = coalesce($10, lng)
      WHERE id = $1`,
    [
      salonId,
      name,
      input.description?.trim() || null,
      address,
      city,
      area,
      input.phone?.trim() || null,
      input.email?.trim() || null,
      coords?.lat ?? null,
      coords?.lng ?? null,
    ],
  );

  return { geocoded: coords !== null };
}

// ---------- screen 1: service setup ----------

export async function listServiceSetup(db: Queryable, salonId: string) {
  const res = await db.query<{
    service_id: string;
    name: string;
    category: string;
    price: number | null;
    duration_min: number | null;
    buffer_min: number | null;
    active: boolean | null;
  }>(
    `SELECT sv.id AS service_id, sv.name, sv.category,
            ss.price, ss.duration_min, ss.buffer_min, ss.active
       FROM services sv
       LEFT JOIN salon_services ss ON ss.service_id = sv.id AND ss.salon_id = $1
      ORDER BY sv.category, sv.name`,
    [salonId],
  );
  return res.rows.map((r) => ({
    serviceId: r.service_id,
    name: r.name,
    category: r.category,
    offered: r.price !== null,
    price: r.price,
    durationMin: r.duration_min,
    bufferMin: r.buffer_min,
    active: r.active ?? false,
  }));
}

export interface ServiceInput {
  price: number;
  durationMin: number;
  bufferMin: number;
  active: boolean;
}

export function validateService(input: ServiceInput): void {
  if (!Number.isInteger(input.price) || input.price < 0) throw new Error('price must be paise >= 0');
  if (!Number.isInteger(input.durationMin) || input.durationMin <= 0) {
    throw new Error('durationMin must be > 0');
  }
  if (!Number.isInteger(input.bufferMin) || input.bufferMin < 0) throw new Error('bufferMin must be >= 0');
}

export async function upsertService(
  db: Queryable,
  salonId: string,
  serviceId: string,
  input: ServiceInput,
): Promise<void> {
  validateService(input);
  await db.query(
    `INSERT INTO salon_services (salon_id, service_id, price, duration_min, buffer_min, active)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (salon_id, service_id) DO UPDATE
       SET price = EXCLUDED.price, duration_min = EXCLUDED.duration_min,
           buffer_min = EXCLUDED.buffer_min, active = EXCLUDED.active`,
    [salonId, serviceId, input.price, input.durationMin, input.bufferMin, input.active],
  );
}

/**
 * Deactivates rather than deletes. A hard delete would orphan booking_items,
 * which snapshot price and duration precisely so history survives menu edits.
 */
export async function deactivateService(db: Queryable, salonId: string, serviceId: string): Promise<void> {
  await db.query(`UPDATE salon_services SET active = false WHERE salon_id = $1 AND service_id = $2`, [
    salonId,
    serviceId,
  ]);
}

/**
 * Take a service off this salon's menu entirely.
 *
 * Safe to delete, unlike the catalogue row it points at. History does not read
 * this table: booking_items snapshots the price and duration a customer
 * actually agreed to, and the only other reader — the reschedule cart in
 * src/booking/reschedule.ts — LEFT JOINs it for buffer_min with a coalesce.
 * Removing a row loses nothing that a past booking depends on.
 *
 * Both this and deactivateService exist because they are different intents. An
 * owner removing a service they no longer offer wants it gone from their menu;
 * an admin suspending one wants the price and duration preserved for when it
 * comes back. The admin routes keep the second.
 */
export async function removeService(db: Queryable, salonId: string, serviceId: string): Promise<void> {
  await db.query(`DELETE FROM salon_services WHERE salon_id = $1 AND service_id = $2`, [
    salonId,
    serviceId,
  ]);
}

export interface NewServiceInput extends ServiceInput {
  name: string;
  category: string;
}

/**
 * Put a service on this salon's menu, creating the catalogue entry if Hasino
 * does not have one by that name yet.
 *
 * The catalogue is shared on purpose — one row called 'Haircut' rather than
 * one per salon — so that a customer searching for a haircut finds every
 * salon that offers one, and so two salons' menus can be compared at all. What
 * was missing was any way for an owner to reach it: prices could be set
 * against services that already existed, and a salon offering something the
 * catalogue had never heard of had no way to say so. On a deployment whose
 * catalogue was never seeded that meant a services screen with nothing on it
 * and no way to add anything.
 *
 * Matching is case-insensitive so 'haircut' and 'Haircut' do not become two
 * services that split one menu between them. An existing name keeps its
 * existing category: the catalogue is shared, and one salon should not be able
 * to recategorise a service for everybody by re-adding it.
 */
export async function addSalonService(
  db: Queryable,
  salonId: string,
  input: NewServiceInput,
): Promise<{ serviceId: string; name: string; category: string }> {
  validateService(input);
  const name = input.name.trim();
  const category = input.category.trim().toLowerCase() || 'other';
  if (!name) throw new Error('name is required');
  if (name.length > 60) throw new Error('name must be 60 characters or fewer');

  const existing = await db.query<{ id: string; name: string; category: string }>(
    `SELECT id, name, category FROM services WHERE lower(name) = lower($1)`,
    [name],
  );
  let service = existing.rows[0];

  if (!service) {
    const created = await db.query<{ id: string; name: string; category: string }>(
      `INSERT INTO services (name, category) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name, category`,
      [name, category],
    );
    service = created.rows[0];
    if (!service) {
      // Lost the race to another request inserting the same name. The row
      // exists now, which is the outcome we wanted either way.
      const reread = await db.query<{ id: string; name: string; category: string }>(
        `SELECT id, name, category FROM services WHERE lower(name) = lower($1)`,
        [name],
      );
      service = reread.rows[0]!;
    }
  }

  await upsertService(db, salonId, service.id, input);
  return { serviceId: service.id, name: service.name, category: service.category };
}

// ---------- screen 2: timings ----------

export async function listHours(db: Queryable, salonId: string) {
  const res = await db.query<{
    weekday: number;
    open_at: string;
    close_at: string;
    break_start: string | null;
    break_end: string | null;
    online_capacity: number;
    slot_interval_min: number;
  }>(
    `SELECT weekday, open_at, close_at, break_start, break_end, online_capacity, slot_interval_min
       FROM salon_hours WHERE salon_id = $1 ORDER BY weekday`,
    [salonId],
  );
  const byDay = new Map(res.rows.map((r) => [r.weekday, r]));
  return Array.from({ length: 7 }, (_, weekday) => {
    const r = byDay.get(weekday);
    return r
      ? {
          weekday,
          working: true,
          openAt: r.open_at.slice(0, 5),
          closeAt: r.close_at.slice(0, 5),
          breakStart: r.break_start?.slice(0, 5) ?? null,
          breakEnd: r.break_end?.slice(0, 5) ?? null,
          onlineCapacity: r.online_capacity,
          slotIntervalMin: r.slot_interval_min,
        }
      : { weekday, working: false, openAt: '10:00', closeAt: '20:00', breakStart: null,
          breakEnd: null, onlineCapacity: 1, slotIntervalMin: 30 };
  });
}

/**
 * The most chairs any one future slot already has committed to it.
 *
 * The number a salon may safely reduce its capacity to. Chairs are concurrency
 * — three chairs means three bookings can share 10:00-10:30 — so lowering the
 * count below what is already booked would leave existing customers holding
 * chairs the salon says it does not have. The availability engine would stop
 * offering the slot, which is right, but the bookings already taken would
 * quietly be over capacity and the barber would find out on the day.
 *
 * Counts what the availability read counts, via the one predicate in
 * booking/occupancy.ts — including live payment holds, because a hold is a
 * chair somebody is in the middle of paying for.
 *
 * `weekday` narrows it to one day of the week, in the salon's own timezone,
 * for the per-day capacity on the Timings screen. Omitted, it is the peak
 * across the whole future, which is what a single "chairs" control needs.
 */
export async function peakFutureChairUsage(
  db: Queryable,
  salonId: string,
  opts: { weekday?: number; timezone?: string; now?: Date } = {},
): Promise<{ peak: number; at: Date | null }> {
  const now = opts.now ?? new Date();
  const params: unknown[] = [salonId, now];
  let dayFilter = '';
  if (opts.weekday !== undefined) {
    params.push(opts.timezone ?? 'Asia/Kolkata', opts.weekday);
    dayFilter = `AND EXTRACT(DOW FROM bs.slot_start_at AT TIME ZONE $3)::int = $4`;
  }

  const res = await db.query<{ slot_start_at: Date; booked: number }>(
    `SELECT bs.slot_start_at, COUNT(*)::int8 AS booked
       FROM booking_slots bs
       JOIN bookings b ON b.id = bs.booking_id
      WHERE bs.salon_id = $1
        AND bs.slot_start_at >= $2
        AND ${chairConsumingSql('$2')}
        ${dayFilter}
      GROUP BY bs.slot_start_at
      ORDER BY COUNT(*) DESC, bs.slot_start_at
      LIMIT 1`,
    params,
  );
  const row = res.rows[0];
  return { peak: row ? Number(row.booked) : 0, at: row ? row.slot_start_at : null };
}

export class ChairsBelowBookedError extends Error {
  readonly code = 'CHAIRS_BELOW_BOOKED';
  readonly peak: number;
  readonly at: Date | null;
  constructor(peak: number, at: Date | null) {
    super(
      `You already have ${peak} booking${peak === 1 ? '' : 's'} sharing a slot, so this cannot go below ${peak} chair${peak === 1 ? '' : 's'}. ` +
        'Cancel or move those bookings first.',
    );
    this.name = 'ChairsBelowBookedError';
    this.peak = peak;
    this.at = at;
  }
}

/**
 * Chairs, as one number across every working day.
 *
 * The schema keeps capacity per weekday, which is the right model — a salon
 * with a Sunday skeleton crew is normal — and the Timings screen is where that
 * is edited. This is the answer to "how many chairs do you have?", which is
 * how an owner thinks about it, and it only touches days the salon already
 * works: it will not turn a closed Sunday into an open one.
 */
export async function setChairsEveryDay(
  db: Queryable,
  salonId: string,
  chairs: number,
  now: Date = new Date(),
): Promise<{ weekdaysUpdated: number }> {
  if (!Number.isInteger(chairs) || chairs < 0 || chairs > 50) {
    throw new Error('chairs must be a whole number between 0 and 50');
  }

  const { peak, at } = await peakFutureChairUsage(db, salonId, { now });
  if (chairs < peak) throw new ChairsBelowBookedError(peak, at);

  const res = await db.query(
    `UPDATE salon_hours SET online_capacity = $2 WHERE salon_id = $1`,
    [salonId, chairs],
  );
  return { weekdaysUpdated: res.rowCount ?? 0 };
}

export interface HoursInput {
  working: boolean;
  openAt: string;
  closeAt: string;
  breakStart: string | null;
  breakEnd: string | null;
  onlineCapacity: number;
  slotIntervalMin: number;
}

export async function saveHours(
  db: Queryable,
  salonId: string,
  weekday: number,
  input: HoursInput,
): Promise<void> {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('weekday must be 0-6');

  // A non-working day is the absence of a row — see salon_hours in db/schema.sql.
  if (!input.working) {
    await db.query(`DELETE FROM salon_hours WHERE salon_id = $1 AND weekday = $2`, [salonId, weekday]);
    return;
  }

  if (![20, 30, 45].includes(input.slotIntervalMin)) {
    throw new Error('slotIntervalMin must be 20, 30 or 45');
  }
  if (input.onlineCapacity < 0) throw new Error('onlineCapacity must be >= 0');
  if (input.closeAt <= input.openAt) throw new Error('closeAt must be after openAt');
  const hasBreak = Boolean(input.breakStart) && Boolean(input.breakEnd);
  if (Boolean(input.breakStart) !== Boolean(input.breakEnd)) {
    throw new Error('a break needs both a start and an end');
  }
  if (hasBreak && input.breakEnd! <= input.breakStart!) {
    throw new Error('break end must be after break start');
  }

  await db.query(
    `INSERT INTO salon_hours (salon_id, weekday, open_at, close_at, break_start, break_end,
                              online_capacity, slot_interval_min)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (salon_id, weekday) DO UPDATE
       SET open_at = EXCLUDED.open_at, close_at = EXCLUDED.close_at,
           break_start = EXCLUDED.break_start, break_end = EXCLUDED.break_end,
           online_capacity = EXCLUDED.online_capacity,
           slot_interval_min = EXCLUDED.slot_interval_min`,
    [
      salonId,
      weekday,
      input.openAt,
      input.closeAt,
      hasBreak ? input.breakStart : null,
      hasBreak ? input.breakEnd : null,
      input.onlineCapacity,
      input.slotIntervalMin,
    ],
  );
}

export async function listHolidays(db: Queryable, salonId: string) {
  const res = await db.query<{ date: string; reason: string | null }>(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, reason
       FROM salon_holidays WHERE salon_id = $1 AND date >= current_date ORDER BY date`,
    [salonId],
  );
  return res.rows;
}

export async function addHoliday(
  db: Queryable,
  salonId: string,
  date: string,
  reason: string | null,
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  await db.query(
    `INSERT INTO salon_holidays (salon_id, date, reason) VALUES ($1, $2::date, $3)
     ON CONFLICT (salon_id, date) DO UPDATE SET reason = EXCLUDED.reason`,
    [salonId, date, reason],
  );
}

export async function removeHoliday(db: Queryable, salonId: string, date: string): Promise<void> {
  await db.query(`DELETE FROM salon_holidays WHERE salon_id = $1 AND date = $2::date`, [salonId, date]);
}

// ---------- screen 3: today's bookings ----------

/** Local-day bounds as instants, so "today" means the salon's today. */
export function dayBounds(timezone: string, date: string): { start: Date; end: Date } {
  return {
    start: zonedTimeToUtc(timezone, date, 0),
    end: zonedTimeToUtc(timezone, addDays(date, 1), 0),
  };
}

export async function listBookingsForDay(
  db: Queryable,
  salonId: string,
  timezone: string,
  date: string,
) {
  const { start, end } = dayBounds(timezone, date);
  const res = await db.query<{
    id: string;
    start_at: Date;
    end_at: Date;
    status: string;
    amount: number;
    verify_code: string | null;
    refund_status: string;
    customer_name: string | null;
    customer_phone: string | null;
    customer_email: string | null;
    services: string[];
  }>(
    `SELECT b.id, b.start_at, b.end_at, b.status, b.amount, b.verify_code, b.refund_status,
            u.name AS customer_name, u.phone AS customer_phone,
            -- The only contact a Google-only account has: phone is now
            -- optional and most customers will never have one.
            u.email AS customer_email,
            coalesce(array_agg(sv.name ORDER BY sv.name)
                     FILTER (WHERE sv.name IS NOT NULL), '{}') AS services
       FROM bookings b
       JOIN users u ON u.id = b.customer_id
       LEFT JOIN booking_items bi ON bi.booking_id = b.id
       LEFT JOIN services sv ON sv.id = bi.service_id
      WHERE b.salon_id = $1 AND b.start_at >= $2 AND b.start_at < $3
        -- A booking the salon can act on. 'pending_payment' is a chair being
        -- held while a customer pays: it is real enough to block the slot, but
        -- putting it on a barber's Today screen would show a queue of people
        -- who may never arrive, with [Verify] buttons that must not work.
        -- 'expired' is the same customer, thirty seconds later.
        AND b.status NOT IN ('pending_payment','expired')
      GROUP BY b.id, u.name, u.phone, u.email
      ORDER BY b.start_at`,
    [salonId, start, end],
  );

  return res.rows.map((r) => ({
    id: r.id,
    startAt: r.start_at.toISOString(),
    endAt: r.end_at.toISOString(),
    status: r.status,
    amount: r.amount,
    refundStatus: r.refund_status,
    // When the customer's grace period runs out. Computed from the stored
    // start_at by the same function the write path enforces, so the panel
    // cannot draw an enabled button a minute before the API would accept it.
    // The panel compares this against the server clock it is handed with the
    // list, never against the phone's.
    noShowAvailableAt: noShowAvailableAt(r.start_at).toISOString(),
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    customerEmail: r.customer_email,
    services: r.services,
  }));
}

// ---------- screen 7: reviews + analytics ----------

/**
 * The fraud counters from spec §4. Flag thresholds: no-show rate above 15%,
 * cancel rate above 10%. Computed live — at ~25 salons this is cheap, and a
 * materialised version can wait until it is not.
 */
export async function salonStats(db: Queryable, salonId: string) {
  const res = await db.query<{
    total: number;
    completed: number;
    no_show: number;
    cancelled: number;
    revenue: number | null;
    rating: string | null;
    reviews: number;
    strikes: number;
  }>(
    `SELECT count(*)::int8 AS total,
            count(*) FILTER (WHERE status = 'completed')::int8 AS completed,
            count(*) FILTER (WHERE status = 'no_show')::int8 AS no_show,
            count(*) FILTER (WHERE status = 'cancelled_by_salon')::int8 AS cancelled,
            sum(amount) FILTER (WHERE status = 'completed') AS revenue,
            (SELECT round(avg(rating)::numeric,1) FROM reviews WHERE salon_id = $1) AS rating,
            (SELECT count(*)::int8 FROM reviews WHERE salon_id = $1) AS reviews,
            (SELECT strike_count FROM salons WHERE id = $1) AS strikes
       FROM bookings WHERE salon_id = $1 AND start_at >= now() - interval '60 days'`,
    [salonId],
  );
  const r = res.rows[0]!;
  const total = Number(r.total);
  const noShowRate = total ? Number(r.no_show) / total : 0;
  const cancelRate = total ? Number(r.cancelled) / total : 0;
  return {
    windowDays: 60,
    total,
    completed: Number(r.completed),
    noShow: Number(r.no_show),
    cancelled: Number(r.cancelled),
    revenue: Number(r.revenue ?? 0),
    rating: r.rating === null ? null : Number(r.rating),
    reviews: Number(r.reviews),
    strikes: Number(r.strikes ?? 0),
    noShowRate,
    cancelRate,
    flags: [
      ...(noShowRate > 0.15 ? ['no_show_rate above 15%'] : []),
      ...(cancelRate > 0.1 ? ['cancel_rate above 10%'] : []),
    ],
  };
}

export async function listReviews(db: Queryable, salonId: string) {
  const res = await db.query(
    `SELECT r.id, r.rating, r.comment, r.reply, r.created_at, u.name AS customer_name
       FROM reviews r
       JOIN bookings b ON b.id = r.booking_id
       JOIN users u ON u.id = b.customer_id
      WHERE r.salon_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
    [salonId],
  );
  return res.rows;
}

/** Customer's own bookings, newest first. */
export async function listCustomerBookings(db: Queryable, customerId: string, now: Date = new Date()) {
  const res = await db.query<{
    id: string;
    salon_name: string;
    salon_id: string;
    start_at: Date;
    end_at: Date;
    status: string;
    amount: number;
    verify_code: string | null;
    refund_status: string;
    hold_expires_at: Date | null;
    reschedule_deadline: Date | null;
    reschedule_count: number;
    services: string[];
  }>(
    `SELECT b.id, s.name AS salon_name, s.id AS salon_id, b.start_at, b.end_at,
            b.status, b.amount, b.verify_code, b.refund_status,
            b.hold_expires_at, b.reschedule_deadline, b.reschedule_count,
            coalesce(array_agg(sv.name ORDER BY sv.name)
                     FILTER (WHERE sv.name IS NOT NULL), '{}') AS services
       FROM bookings b
       JOIN salons s ON s.id = b.salon_id
       LEFT JOIN booking_items bi ON bi.booking_id = b.id
       LEFT JOIN services sv ON sv.id = bi.service_id
      WHERE b.customer_id = $1
        -- An expired hold is a checkout the customer walked away from. Keeping
        -- the row is an audit trail; showing it is telling them about a booking
        -- they never made. A live 'pending_payment' row does show — it is a
        -- payment they can still finish.
        AND b.status <> 'expired'
      GROUP BY b.id, s.name, s.id
      ORDER BY b.start_at DESC LIMIT 50`,
    [customerId],
  );

  return res.rows.map((r) => ({
    id: r.id,
    salonId: r.salon_id,
    salonName: r.salon_name,
    startAt: r.start_at.toISOString(),
    endAt: r.end_at.toISOString(),
    status: r.status,
    amount: r.amount,
    refundStatus: r.refund_status,
    services: r.services,
    holdExpiresAt: r.hold_expires_at ? r.hold_expires_at.toISOString() : null,
    rescheduleDeadline: r.reschedule_deadline ? r.reschedule_deadline.toISOString() : null,
    // The one place the §4 window and the §10 cap are turned into something the
    // UI can render, so the button and the endpoint cannot disagree about
    // whether a booking is movable.
    canReschedule:
      r.reschedule_count < 1 &&
      (r.status === 'booked'
        ? r.start_at.getTime() - now.getTime() > 15 * 60_000
        : ['no_show', 'cancelled_by_customer', 'cancelled_by_salon'].includes(r.status) &&
          r.reschedule_deadline !== null &&
          r.reschedule_deadline.getTime() > now.getTime()),
    // Spec §4: the code appears 15 minutes before the slot. Withheld until
    // then so a screenshot taken at booking time is not a permanent key.
    //
    // Per booking, from that booking's own row — a customer with three live
    // bookings gets three codes, each revealed on its own slot's clock, and
    // one of them being verified changes nothing about the other two.
    verifyCode:
      r.verify_code && r.start_at.getTime() - now.getTime() <= 15 * 60_000 && r.status === 'booked'
        ? r.verify_code
        : null,
    // When this booking's code turns up, so the app can say so instead of
    // showing a blank space that reads as a code having gone missing.
    verifyCodeAt:
      r.verify_code && r.status === 'booked'
        ? new Date(r.start_at.getTime() - 15 * 60_000).toISOString()
        : null,
  }));
}

export { localDateKey };
