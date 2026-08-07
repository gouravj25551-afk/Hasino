import type { Pool, PoolClient } from '../db/pool.ts';
import type { CartItem, DayHours, WindowSnapshot } from '../types.ts';
import { addDays, localDateKey } from '../time/tz.ts';

export const WINDOW_DAYS = 7; // today + 6

type Queryable = Pool | PoolClient;

/**
 * The whole 7-day window in three queries, per spec §2 — hours, holidays,
 * occupancy. Never one query per slot.
 */
export async function loadWindowSnapshot(
  db: Queryable,
  salonId: string,
  now: Date = new Date(),
): Promise<WindowSnapshot | null> {
  const salon = await db.query<{ timezone: string }>(
    `SELECT timezone FROM salons WHERE id = $1 AND status = 'active'`,
    [salonId],
  );
  const timezone = salon.rows[0]?.timezone;
  if (!timezone) return null;

  const from = localDateKey(now, timezone);
  const to = addDays(from, WINDOW_DAYS);

  const [hoursRes, holidayRes, occRes] = await Promise.all([
    db.query<{
      weekday: number;
      open_at: string;
      close_at: string;
      break_start: string | null;
      break_end: string | null;
      online_capacity: number;
      slot_interval_min: number;
    }>(
      `SELECT weekday, open_at, close_at, break_start, break_end,
              online_capacity, slot_interval_min
         FROM salon_hours
        WHERE salon_id = $1`,
      [salonId],
    ),

    db.query<{ date: string }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date
         FROM salon_holidays
        WHERE salon_id = $1 AND date >= $2::date AND date < $3::date`,
      [salonId, from, to],
    ),

    // Only these three statuses consume a chair (spec §5). completed, no_show,
    // cancelled_* and rescheduled do not.
    db.query<{ slot_start_at: Date; booked: number }>(
      `SELECT bs.slot_start_at, COUNT(*)::int8 AS booked
         FROM booking_slots bs
         JOIN bookings b ON b.id = bs.booking_id
        WHERE bs.salon_id = $1
          AND bs.slot_start_at >= $2
          AND bs.slot_start_at <  $3
          AND b.status IN ('booked','verified','in_progress')
        GROUP BY bs.slot_start_at`,
      [salonId, windowStart(now), windowEnd(now)],
    ),
  ]);

  const hours = new Map<number, DayHours>();
  for (const r of hoursRes.rows) {
    hours.set(r.weekday, {
      weekday: r.weekday,
      openAt: r.open_at,
      closeAt: r.close_at,
      breakStart: r.break_start,
      breakEnd: r.break_end,
      onlineCapacity: r.online_capacity,
      slotIntervalMin: r.slot_interval_min,
    });
  }

  const occupancy = new Map<number, number>();
  for (const r of occRes.rows) occupancy.set(r.slot_start_at.getTime(), Number(r.booked));

  return {
    salonId,
    timezone,
    hours,
    holidays: new Set(holidayRes.rows.map((r) => r.date)),
    occupancy,
    takenAt: now,
  };
}

/**
 * Start of the occupancy scan. Deliberately the start of the current local
 * day rather than `now`: a booking in progress right now still holds its
 * chair, and the grid for today includes slots that began before `now`.
 * Filtering those out here would make an in-progress booking invisible to the
 * run-length pass and let a later start time claim a chair that is taken.
 */
function windowStart(now: Date): Date {
  return new Date(now.getTime() - 24 * 60 * 60_000);
}

function windowEnd(now: Date): Date {
  return new Date(now.getTime() + (WINDOW_DAYS + 1) * 24 * 60 * 60_000);
}

/**
 * Resolve a cart. Not part of the 3-query availability budget — this is cart
 * resolution, and it is what freezes price/duration into booking_items.
 */
export async function loadCart(
  db: Queryable,
  salonId: string,
  serviceIds: string[],
): Promise<CartItem[]> {
  if (serviceIds.length === 0) return [];
  const res = await db.query<{
    service_id: string;
    name: string;
    price: number;
    duration_min: number;
    buffer_min: number;
  }>(
    `SELECT ss.service_id, s.name, ss.price, ss.duration_min, ss.buffer_min
       FROM salon_services ss
       JOIN services s ON s.id = ss.service_id
      WHERE ss.salon_id = $1 AND ss.service_id = ANY($2::uuid[]) AND ss.active`,
    [salonId, serviceIds],
  );
  return res.rows.map((r) => ({
    serviceId: r.service_id,
    name: r.name,
    price: r.price,
    durationMin: r.duration_min,
    bufferMin: r.buffer_min,
  }));
}
