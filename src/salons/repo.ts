import type { Pool, PoolClient } from '../db/pool.ts';
import { formatHHMM, localDateKey, localMinutes, parseHHMM, weekdayOf } from '../time/tz.ts';

type Queryable = Pool | PoolClient;

export interface SalonSummary {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating: number | null;
  reviewCount: number;
  fromPrice: number | null;
  coverImage: string | null;
  photos: string[];
  distanceKm: number | null;
  openNow: boolean;
  closesAt: string | null;
}

export interface SalonDetail extends SalonSummary {
  timezone: string;
  services: Array<{
    serviceId: string;
    name: string;
    category: string;
    price: number;
    durationMin: number;
  }>;
  hours: Array<{
    weekday: number;
    openAt: string;
    closeAt: string;
    breakStart: string | null;
    breakEnd: string | null;
  }>;
}

interface DayHours {
  openAt: string;
  closeAt: string;
  breakStart: string | null;
  breakEnd: string | null;
}

/**
 * Whether a salon is open right now, in its own timezone, and when its
 * current open segment ends. Segments mirror the availability grid
 * (open->break, break->close) rather than treating the break as a filter, so
 * a salon on its lunch break reports closed instead of open-until-close.
 */
function openStatus(
  timezone: string,
  hoursByWeekday: Map<number, DayHours>,
  holidays: Set<string>,
  now: Date,
): { openNow: boolean; closesAt: string | null } {
  const today = localDateKey(now, timezone);
  if (holidays.has(today)) return { openNow: false, closesAt: null };

  const hours = hoursByWeekday.get(weekdayOf(today));
  if (!hours) return { openNow: false, closesAt: null };

  const nowMin = localMinutes(now, timezone);
  const openMin = parseHHMM(hours.openAt);
  const closeMin = parseHHMM(hours.closeAt);
  if (nowMin < openMin || nowMin >= closeMin) return { openNow: false, closesAt: null };

  if (hours.breakStart && hours.breakEnd) {
    const breakStartMin = parseHHMM(hours.breakStart);
    const breakEndMin = parseHHMM(hours.breakEnd);
    if (nowMin >= breakStartMin && nowMin < breakEndMin) return { openNow: false, closesAt: null };
    if (nowMin < breakStartMin) return { openNow: true, closesAt: formatHHMM(breakStartMin) };
  }
  return { openNow: true, closesAt: formatHHMM(closeMin) };
}

/**
 * Browse. Postgres full-text + pg_trgm per spec §7 — no Elasticsearch.
 *
 * `lat`/`lng` are optional: when given, distance is computed in SQL
 * (haversine, no PostGIS) and results sort by it; otherwise the original
 * name ordering is unchanged.
 */
export async function listSalons(
  db: Queryable,
  q?: string,
  opts: { lat?: number; lng?: number; category?: string; limit?: number; now?: Date } = {},
): Promise<SalonSummary[]> {
  const { lat, lng, category, limit = 50, now = new Date() } = opts;

  const res = await db.query<{
    id: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    timezone: string;
    cover_url: string | null;
    rating: string | null;
    review_count: number;
    from_price: number | null;
    distance_km: number | null;
  }>(
    `SELECT s.id, s.name, s.address, s.lat, s.lng, s.timezone, s.cover_url,
            round(avg(r.rating)::numeric, 1) AS rating,
            count(r.id)::int8               AS review_count,
            min(ss.price) FILTER (WHERE ss.active) AS from_price,
            CASE WHEN $3::double precision IS NOT NULL AND $4::double precision IS NOT NULL
                 THEN 6371 * acos(least(1, greatest(-1,
                        cos(radians($3::double precision)) * cos(radians(s.lat))
                          * cos(radians(s.lng) - radians($4::double precision))
                        + sin(radians($3::double precision)) * sin(radians(s.lat))
                      )))
            END AS distance_km
       FROM salons s
       LEFT JOIN reviews r        ON r.salon_id = s.id
       LEFT JOIN salon_services ss ON ss.salon_id = s.id
      WHERE s.status = 'active'
        AND ($1::text IS NULL OR s.name ILIKE '%' || $1 || '%' OR s.address ILIKE '%' || $1 || '%')
        AND ($5::text IS NULL OR EXISTS (
              SELECT 1 FROM salon_services ss2
                JOIN services sv2 ON sv2.id = ss2.service_id
               WHERE ss2.salon_id = s.id AND ss2.active AND sv2.category = $5
            ))
      GROUP BY s.id
      ORDER BY distance_km ASC NULLS LAST, s.name
      LIMIT $2`,
    [q ?? null, limit, lat ?? null, lng ?? null, category ?? null],
  );

  const salonIds = res.rows.map((r) => r.id);
  const { hoursBySalon, holidaysBySalon, photosBySalon } = await loadPresentationData(db, salonIds, now);

  return res.rows.map((r) => {
    const photos = photosBySalon.get(r.id) ?? [];
    const status = openStatus(r.timezone, hoursBySalon.get(r.id) ?? new Map(), holidaysBySalon.get(r.id) ?? new Set(), now);
    return {
      id: r.id,
      name: r.name,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      rating: r.rating === null ? null : Number(r.rating),
      reviewCount: Number(r.review_count),
      fromPrice: r.from_price,
      coverImage: r.cover_url ?? photos[0] ?? null,
      photos,
      distanceKm: r.distance_km === null ? null : Number(r.distance_km.toFixed(1)),
      openNow: status.openNow,
      closesAt: status.closesAt,
    };
  });
}

/** Batched hours/holidays/photos for a set of salons, keyed by salon id. */
async function loadPresentationData(
  db: Queryable,
  salonIds: string[],
  now: Date,
): Promise<{
  hoursBySalon: Map<string, Map<number, DayHours>>;
  holidaysBySalon: Map<string, Set<string>>;
  photosBySalon: Map<string, string[]>;
}> {
  const hoursBySalon = new Map<string, Map<number, DayHours>>();
  const holidaysBySalon = new Map<string, Set<string>>();
  const photosBySalon = new Map<string, string[]>();
  if (salonIds.length === 0) return { hoursBySalon, holidaysBySalon, photosBySalon };

  const [hours, holidays, photos] = await Promise.all([
    db.query<{
      salon_id: string;
      weekday: number;
      open_at: string;
      close_at: string;
      break_start: string | null;
      break_end: string | null;
    }>(
      `SELECT salon_id, weekday, open_at, close_at, break_start, break_end
         FROM salon_hours WHERE salon_id = ANY($1)`,
      [salonIds],
    ),
    // A window around "now" rather than an exact date match: each salon has
    // its own timezone, so the server's calendar date can be off by one from
    // a salon's local date near midnight. openStatus() does the exact check.
    db.query<{ salon_id: string; date: string }>(
      `SELECT salon_id, to_char(date, 'YYYY-MM-DD') AS date
         FROM salon_holidays
        WHERE salon_id = ANY($1) AND date BETWEEN ($2::timestamptz - interval '1 day')::date
                                              AND ($2::timestamptz + interval '1 day')::date`,
      [salonIds, now],
    ),
    db.query<{ salon_id: string; url: string }>(
      `SELECT salon_id, url FROM salon_photos WHERE salon_id = ANY($1) ORDER BY salon_id, sort`,
      [salonIds],
    ),
  ]);

  for (const r of hours.rows) {
    if (!hoursBySalon.has(r.salon_id)) hoursBySalon.set(r.salon_id, new Map());
    hoursBySalon.get(r.salon_id)!.set(r.weekday, {
      openAt: r.open_at,
      closeAt: r.close_at,
      breakStart: r.break_start,
      breakEnd: r.break_end,
    });
  }
  for (const r of holidays.rows) {
    if (!holidaysBySalon.has(r.salon_id)) holidaysBySalon.set(r.salon_id, new Set());
    holidaysBySalon.get(r.salon_id)!.add(r.date);
  }
  for (const r of photos.rows) {
    if (!photosBySalon.has(r.salon_id)) photosBySalon.set(r.salon_id, []);
    photosBySalon.get(r.salon_id)!.push(r.url);
  }

  return { hoursBySalon, holidaysBySalon, photosBySalon };
}

export async function getSalon(db: Queryable, salonId: string, now: Date = new Date()): Promise<SalonDetail | null> {
  const salon = await db.query<{
    id: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    timezone: string;
    cover_url: string | null;
  }>(
    `SELECT id, name, address, lat, lng, timezone, cover_url
       FROM salons WHERE id = $1 AND status = 'active'`,
    [salonId],
  );
  const s = salon.rows[0];
  if (!s) return null;

  const [services, hours, stats, presentation] = await Promise.all([
    db.query<{
      service_id: string;
      name: string;
      category: string;
      price: number;
      duration_min: number;
    }>(
      `SELECT ss.service_id, sv.name, sv.category, ss.price, ss.duration_min
         FROM salon_services ss
         JOIN services sv ON sv.id = ss.service_id
        WHERE ss.salon_id = $1 AND ss.active
        ORDER BY sv.category, sv.name`,
      [salonId],
    ),
    db.query<{
      weekday: number;
      open_at: string;
      close_at: string;
      break_start: string | null;
      break_end: string | null;
    }>(
      `SELECT weekday, open_at, close_at, break_start, break_end
         FROM salon_hours WHERE salon_id = $1 ORDER BY weekday`,
      [salonId],
    ),
    db.query<{ rating: string | null; review_count: number; from_price: number | null }>(
      `SELECT round(avg(r.rating)::numeric, 1) AS rating,
              count(r.id)::int8 AS review_count,
              (SELECT min(price) FROM salon_services WHERE salon_id = $1 AND active) AS from_price
         FROM reviews r WHERE r.salon_id = $1`,
      [salonId],
    ),
    loadPresentationData(db, [salonId], now),
  ]);

  const stat = stats.rows[0];
  const photos = presentation.photosBySalon.get(salonId) ?? [];
  const status = openStatus(
    s.timezone,
    presentation.hoursBySalon.get(salonId) ?? new Map(),
    presentation.holidaysBySalon.get(salonId) ?? new Set(),
    now,
  );

  return {
    id: s.id,
    name: s.name,
    address: s.address,
    lat: s.lat,
    lng: s.lng,
    timezone: s.timezone,
    rating: stat?.rating == null ? null : Number(stat.rating),
    reviewCount: Number(stat?.review_count ?? 0),
    fromPrice: stat?.from_price ?? null,
    coverImage: s.cover_url ?? photos[0] ?? null,
    photos,
    distanceKm: null,
    openNow: status.openNow,
    closesAt: status.closesAt,
    services: services.rows.map((r) => ({
      serviceId: r.service_id,
      name: r.name,
      category: r.category,
      price: r.price,
      durationMin: r.duration_min,
    })),
    hours: hours.rows.map((r) => ({
      weekday: r.weekday,
      openAt: r.open_at,
      closeAt: r.close_at,
      breakStart: r.break_start,
      breakEnd: r.break_end,
    })),
  };
}

export async function getBooking(db: Queryable, bookingId: string) {
  const res = await db.query(
    `SELECT b.id, b.salon_id, s.name AS salon_name, b.customer_id,
            b.start_at, b.end_at, b.status, b.amount, b.verify_code,
            b.created_at
       FROM bookings b JOIN salons s ON s.id = b.salon_id
      WHERE b.id = $1`,
    [bookingId],
  );
  return res.rows[0] ?? null;
}

// ---------- favorites ----------

export async function listFavorites(db: Queryable, userId: string): Promise<string[]> {
  const res = await db.query<{ salon_id: string }>(
    `SELECT salon_id FROM favorites WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return res.rows.map((r) => r.salon_id);
}

export async function addFavorite(db: Queryable, userId: string, salonId: string): Promise<void> {
  await db.query(
    `INSERT INTO favorites (user_id, salon_id) VALUES ($1, $2)
     ON CONFLICT (user_id, salon_id) DO NOTHING`,
    [userId, salonId],
  );
}

export async function removeFavorite(db: Queryable, userId: string, salonId: string): Promise<void> {
  await db.query(`DELETE FROM favorites WHERE user_id = $1 AND salon_id = $2`, [userId, salonId]);
}
