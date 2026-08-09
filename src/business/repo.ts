import type { Pool, PoolClient } from '../db/pool.ts';
import { addDays, localDateKey, zonedTimeToUtc } from '../time/tz.ts';

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
}> {
  const res = await db.query<{
    id: string;
    name: string;
    timezone: string;
    status: string;
    rzp_kyc_status: string;
    commission_bps: number;
  }>(
    `SELECT id, name, timezone, status, rzp_kyc_status, commission_bps
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
  };
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
    customer_phone: string;
    services: string[];
  }>(
    `SELECT b.id, b.start_at, b.end_at, b.status, b.amount, b.verify_code, b.refund_status,
            u.name AS customer_name, u.phone AS customer_phone,
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
      GROUP BY b.id, u.name, u.phone
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
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
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
    verifyCode:
      r.verify_code && r.start_at.getTime() - now.getTime() <= 15 * 60_000 && r.status === 'booked'
        ? r.verify_code
        : null,
  }));
}

export { localDateKey };
