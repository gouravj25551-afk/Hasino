import type { Pool, PoolClient } from '../db/pool.ts';

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

/**
 * Browse. Postgres full-text + pg_trgm per spec §7 — no Elasticsearch.
 * Distance sort is a placeholder ordering by name; MVP is one city and ~25
 * salons, so this is not yet worth PostGIS.
 */
export async function listSalons(db: Queryable, q?: string, limit = 50): Promise<SalonSummary[]> {
  const res = await db.query<{
    id: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    rating: string | null;
    review_count: number;
    from_price: number | null;
  }>(
    `SELECT s.id, s.name, s.address, s.lat, s.lng,
            round(avg(r.rating)::numeric, 1) AS rating,
            count(r.id)::int8               AS review_count,
            min(ss.price) FILTER (WHERE ss.active) AS from_price
       FROM salons s
       LEFT JOIN reviews r        ON r.salon_id = s.id
       LEFT JOIN salon_services ss ON ss.salon_id = s.id
      WHERE s.status = 'active'
        AND ($1::text IS NULL OR s.name ILIKE '%' || $1 || '%' OR s.address ILIKE '%' || $1 || '%')
      GROUP BY s.id
      ORDER BY s.name
      LIMIT $2`,
    [q ?? null, limit],
  );

  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    address: r.address,
    lat: r.lat,
    lng: r.lng,
    rating: r.rating === null ? null : Number(r.rating),
    reviewCount: Number(r.review_count),
    fromPrice: r.from_price,
  }));
}

export async function getSalon(db: Queryable, salonId: string): Promise<SalonDetail | null> {
  const salon = await db.query<{
    id: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    timezone: string;
  }>(
    `SELECT id, name, address, lat, lng, timezone
       FROM salons WHERE id = $1 AND status = 'active'`,
    [salonId],
  );
  const s = salon.rows[0];
  if (!s) return null;

  const [services, hours, stats] = await Promise.all([
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
  ]);

  const stat = stats.rows[0];
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
