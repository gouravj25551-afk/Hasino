import pg from 'pg';
import { TZ } from './helpers.ts';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://localhost:5432/hasino_test';

export async function connect(): Promise<pg.Pool | null> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 16 });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
}

export interface SeedService {
  name: string;
  durationMin: number;
  price: number;
  bufferMin?: number;
}

export interface SeedInput {
  openAt?: string;
  closeAt?: string;
  breakStart?: string | null;
  breakEnd?: string | null;
  onlineCapacity?: number;
  slotIntervalMin?: number;
  services?: SeedService[];
  customers?: number;
  holidays?: string[];
}

export interface Fixture {
  salonId: string;
  ownerId: string;
  customerIds: string[];
  serviceIds: Record<string, string>;
}

/**
 * Wipes the whole test database.
 *
 * Every DB-backed test file shares one database, so they must not run in
 * parallel — `npm test` passes --test-concurrency=1 for exactly this reason.
 * Drop that flag and these suites truncate each other's fixtures mid-run.
 */
export async function reset(pool: pg.Pool): Promise<void> {
  await pool.query(`
    TRUNCATE booking_slots, booking_items, bookings, reviews, salon_strikes,
             salon_holidays, salon_hours, salon_services, services, salons, users,
             payments, refunds, ledger_entries, payouts, webhook_events,
             notifications, idempotency_keys, cron_heartbeat
    RESTART IDENTITY CASCADE
  `);
}

export async function seed(pool: pg.Pool, input: SeedInput = {}): Promise<Fixture> {
  await reset(pool);

  const services = input.services ?? [{ name: 'haircut', durationMin: 20, price: 20_000, bufferMin: 10 }];
  const customerCount = input.customers ?? 1;

  const owner = await pool.query<{ id: string }>(
    `INSERT INTO users (phone, name, role) VALUES ('+910000000000', 'Owner', 'business') RETURNING id`,
  );
  const ownerId = owner.rows[0]!.id;

  const salon = await pool.query<{ id: string }>(
    `INSERT INTO salons (owner_id, name, address, lat, lng, timezone, status)
     VALUES ($1, 'Fixture Salon', 'Somewhere', 12.97, 77.59, $2, 'active') RETURNING id`,
    [ownerId, TZ],
  );
  const salonId = salon.rows[0]!.id;

  const serviceIds: Record<string, string> = {};
  for (const s of services) {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO services (name, category) VALUES ($1, 'hair') RETURNING id`,
      [s.name],
    );
    const id = row.rows[0]!.id;
    serviceIds[s.name] = id;
    await pool.query(
      `INSERT INTO salon_services (salon_id, service_id, price, duration_min, buffer_min)
       VALUES ($1, $2, $3, $4, $5)`,
      [salonId, id, s.price, s.durationMin, s.bufferMin ?? 10],
    );
  }

  for (let weekday = 0; weekday < 7; weekday++) {
    await pool.query(
      `INSERT INTO salon_hours (salon_id, weekday, open_at, close_at, break_start,
                                break_end, online_capacity, slot_interval_min)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        salonId,
        weekday,
        input.openAt ?? '10:00',
        input.closeAt ?? '13:00',
        input.breakStart ?? null,
        input.breakEnd ?? null,
        input.onlineCapacity ?? 1,
        input.slotIntervalMin ?? 30,
      ],
    );
  }

  for (const date of input.holidays ?? []) {
    await pool.query(`INSERT INTO salon_holidays (salon_id, date, reason) VALUES ($1, $2::date, 'test')`, [
      salonId,
      date,
    ]);
  }

  const customerIds: string[] = [];
  for (let i = 0; i < customerCount; i++) {
    const row = await pool.query<{ id: string }>(
      // An email, because the notification outbox skips a customer without one
      // and half the payment assertions are about what got queued.
      `INSERT INTO users (phone, name, email) VALUES ($1, $2, $3) RETURNING id`,
      [`+9199999${String(i).padStart(5, '0')}`, `Customer ${i}`, `customer${i}@example.test`],
    );
    customerIds.push(row.rows[0]!.id);
  }

  return { salonId, ownerId, customerIds, serviceIds };
}

/**
 * Chairs consumed at a slot, counting live payment holds.
 *
 * Deliberately a copy of the predicate in src/booking/occupancy.ts rather than
 * an import of it: if the production predicate is changed by mistake, a test
 * that imports it changes with it and stays green.
 */
export async function chairsHeld(
  pool: pg.Pool,
  salonId: string,
  slotStartAt: Date,
  now: Date = new Date(),
): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int8 AS n
       FROM booking_slots bs
       JOIN bookings b ON b.id = bs.booking_id
      WHERE bs.salon_id = $1 AND bs.slot_start_at = $2
        AND (b.status IN ('booked','verified','in_progress')
             OR (b.status = 'pending_payment' AND b.hold_expires_at > $3))`,
    [salonId, slotStartAt, now],
  );
  return Number(res.rows[0]!.n);
}

export async function bookingStatus(pool: pg.Pool, bookingId: string): Promise<string> {
  const res = await pool.query<{ status: string }>(`SELECT status FROM bookings WHERE id = $1`, [
    bookingId,
  ]);
  return res.rows[0]?.status ?? 'missing';
}

export async function slotHolders(pool: pg.Pool, salonId: string, slotStartAt: Date): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int8 AS n
       FROM booking_slots bs
       JOIN bookings b ON b.id = bs.booking_id
      WHERE bs.salon_id = $1 AND bs.slot_start_at = $2
        AND b.status IN ('booked','verified','in_progress')`,
    [salonId, slotStartAt],
  );
  return Number(res.rows[0]!.n);
}
