/**
 * Demo data so a fresh database has something to browse.
 * Destructive: truncates every table. Refuses to run against production.
 *
 *   node scripts/seed-demo.ts
 */
import { getPool } from '../src/db/pool.ts';

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DESTRUCTIVE_SEED !== 'true') {
  console.error('Refusing to truncate a production database. Set ALLOW_DESTRUCTIVE_SEED=true to override.');
  process.exit(1);
}

const SERVICES = [
  { name: 'Haircut', category: 'hair' },
  { name: 'Beard Trim', category: 'hair' },
  { name: 'Hair Colour', category: 'hair' },
  { name: 'Head Massage', category: 'spa' },
  { name: 'Facial', category: 'skin' },
];

const SALONS = [
  {
    name: 'Sharma Hair Studio',
    address: '4th Block, Koramangala, Bengaluru',
    lat: 12.9352,
    lng: 77.6245,
    capacity: 3,
    interval: 30,
    open: '10:00',
    close: '20:00',
    break: ['14:00', '15:00'] as [string, string] | null,
    prices: { Haircut: [25_000, 30], 'Beard Trim': [12_000, 15], 'Hair Colour': [90_000, 60], 'Head Massage': [40_000, 30] },
  },
  {
    name: 'The Barber Room',
    address: 'Indiranagar 100ft Road, Bengaluru',
    lat: 12.9719,
    lng: 77.6412,
    capacity: 2,
    interval: 20,
    open: '09:00',
    close: '21:00',
    break: null,
    prices: { Haircut: [35_000, 40], 'Beard Trim': [15_000, 20], Facial: [70_000, 40] },
  },
  {
    name: 'Glow Unisex Salon',
    address: 'HSR Layout Sector 2, Bengaluru',
    lat: 12.9121,
    lng: 77.6446,
    capacity: 4,
    interval: 45,
    open: '11:00',
    close: '19:00',
    break: ['13:30', '14:15'] as [string, string] | null,
    prices: { Haircut: [45_000, 45], 'Hair Colour': [150_000, 90], Facial: [85_000, 45], 'Head Massage': [50_000, 45] },
  },
];

const db = getPool();

await db.query(`
  TRUNCATE booking_slots, booking_items, bookings, reviews, salon_strikes,
           salon_holidays, salon_hours, salon_services, services, salons, users
  RESTART IDENTITY CASCADE
`);

const serviceIds = new Map<string, string>();
for (const s of SERVICES) {
  const r = await db.query<{ id: string }>(
    `INSERT INTO services (name, category) VALUES ($1, $2) RETURNING id`,
    [s.name, s.category],
  );
  serviceIds.set(s.name, r.rows[0]!.id);
}

// One owner per salon. salons.owner_id is the only link, and the business
// panel resolves "my salon" from the signed-in owner — so a shared owner would
// make that lookup ambiguous.
const customers: Array<{ id: string; name: string }> = [];
for (const [i, name] of ['Aarav', 'Priya', 'Rohan'].entries()) {
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (phone, name) VALUES ($1, $2) RETURNING id`,
    [`+91900000${String(i + 10).padStart(4, '0')}`, name],
  );
  customers.push({ id: r.rows[0]!.id, name });
}

const created: Array<{ id: string; name: string }> = [];

for (const [i, salon] of SALONS.entries()) {
  const ownerRow = await db.query<{ id: string }>(
    `INSERT INTO users (phone, name, role) VALUES ($1, $2, 'business') RETURNING id`,
    [`+91800000${String(i + 10).padStart(4, '0')}`, salon.name + ' Owner'],
  );
  const ownerId = ownerRow.rows[0]!.id;

  const r = await db.query<{ id: string }>(
    `INSERT INTO salons (owner_id, name, address, lat, lng, timezone, status)
     VALUES ($1, $2, $3, $4, $5, 'Asia/Kolkata', 'active') RETURNING id`,
    [ownerId, salon.name, salon.address, salon.lat, salon.lng],
  );
  const salonId = r.rows[0]!.id;
  created.push({ id: salonId, name: salon.name });

  for (const [serviceName, [price, duration]] of Object.entries(salon.prices)) {
    await db.query(
      `INSERT INTO salon_services (salon_id, service_id, price, duration_min, buffer_min)
       VALUES ($1, $2, $3, $4, 10)`,
      [salonId, serviceIds.get(serviceName)!, price, duration],
    );
  }

  // closed Mondays (weekday 1) — a real non-working day to exercise the grey-out
  for (const weekday of [0, 2, 3, 4, 5, 6]) {
    await db.query(
      `INSERT INTO salon_hours (salon_id, weekday, open_at, close_at, break_start,
                                break_end, online_capacity, slot_interval_min)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [salonId, weekday, salon.open, salon.close, salon.break?.[0] ?? null, salon.break?.[1] ?? null, salon.capacity, salon.interval],
    );
  }
}

// DEV_AUTH resolves x-dev-user through firebase_uid, so local identities need
// one. Prefixed 'dev:' — real Firebase uids never collide with that.
await db.query(`UPDATE users SET firebase_uid = 'dev:' || id WHERE firebase_uid IS NULL`);

console.log('Seeded salons:');
for (const s of created) console.log(`  ${s.id}  ${s.name}`);
console.log('\nCustomers: ' + customers.map((c) => c.name).join(', '));
console.log('(each salon has its own owner; all closed Mondays; Asia/Kolkata)');

await db.end();
