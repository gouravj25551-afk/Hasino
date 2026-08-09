/**
 * Test scaffolding for the CI smoke run. Not part of the product.
 *
 * The seed is a service catalogue now — no users, no salons — because a real
 * deployment starts empty and an operator onboards salons through /admin. The
 * smoke test still needs something to act on, and it has no browser to sign in
 * with, so it gets fixtures here instead.
 *
 * Nothing in src/ knows this file exists. It writes SQL directly, in the style
 * of test/db.ts's seed(), rather than going through the admin API, so a broken
 * admin route fails the smoke checks instead of failing to produce fixtures.
 *
 *   CI_SMOKE=true node scripts/ci-fixture.ts
 *
 * Identities use 'dev:' firebase_uids so the x-dev-user header resolves them.
 * The admin's dev token is its email address: admin elevation requires a
 * verified email in ADMIN_EMAILS, and DevVerifier reports a token containing
 * '@' as exactly that.
 */
import { getPool } from '../src/db/pool.ts';

if (process.env['CI_SMOKE'] !== 'true') {
  console.error(
    'Refusing to run: scripts/ci-fixture.ts is smoke-test scaffolding and needs CI_SMOKE=true.\n' +
      'It inserts fake users and salons. For a real database use `npm run db:seed`, which\n' +
      'only loads the service catalogue.',
  );
  process.exit(1);
}

if (process.env['NODE_ENV'] === 'production') {
  console.error('Refusing to run against NODE_ENV=production. This inserts fake users and salons.');
  process.exit(1);
}

export const ADMIN_EMAIL = 'ci-admin@hasino.test';

const SALONS = [
  {
    name: 'Fixture Salon One',
    address: '1 Test Road, Indiranagar',
    city: 'Bengaluru',
    area: 'Indiranagar',
    lat: 12.9719,
    lng: 77.6412,
    // One chair, deliberately. Smoke asserts that a second customer is turned
    // away while the first is still paying — the race the pay-then-create
    // ordering used to lose by refunding someone. With more than one chair
    // that check silently passes both holds and proves nothing.
    capacity: 1,
    interval: 30,
    open: '10:00',
    close: '20:00',
    break: ['14:00', '15:00'] as [string, string] | null,
    owner: { phone: '+918000000001', name: 'Fixture Owner One', email: 'owner1@hasino.test' },
    // Smoke edits Haircut and adds Facial, so both must exist in the catalogue;
    // Facial is deliberately NOT offered here, so "a newly added service
    // appears in the customer app" has something to add.
    prices: { Haircut: [25_000, 30], 'Beard Trim': [12_000, 15], 'Head Massage': [40_000, 30] },
  },
  {
    name: 'Fixture Salon Two',
    address: '2 Test Road, Koramangala',
    city: 'Bengaluru',
    area: 'Koramangala',
    lat: 12.9352,
    lng: 77.6245,
    capacity: 2,
    interval: 30,
    open: '09:00',
    close: '21:00',
    break: null,
    owner: { phone: '+918000000002', name: 'Fixture Owner Two', email: 'owner2@hasino.test' },
    prices: { Haircut: [35_000, 40] },
  },
];

const CUSTOMERS = [
  { phone: '+919000000001', name: 'Fixture Customer One', email: 'customer1@hasino.test' },
  { phone: '+919000000002', name: 'Fixture Customer Two', email: 'customer2@hasino.test' },
];

const db = getPool();

// Fixtures only — the catalogue in `services` is left alone, because
// seed-catalog.ts owns it and smoke asserts against its contents.
await db.query(`
  TRUNCATE booking_slots, booking_items, bookings, reviews, salon_strikes,
           salon_holidays, salon_hours, salon_services, salons, users,
           favorites, salon_photos, notifications, ledger_entries,
           payments, refunds, payouts, salon_status_events
  RESTART IDENTITY CASCADE
`);

const serviceIds = new Map<string, string>();
for (const row of (
  await db.query<{ id: string; name: string }>(`SELECT id, name FROM services`)
).rows) {
  serviceIds.set(row.name, row.id);
}
if (serviceIds.size === 0) {
  console.error('No services in the catalogue. Run `node scripts/seed-catalog.ts` first.');
  process.exit(1);
}

const admin = await db.query<{ id: string }>(
  `INSERT INTO users (phone, name, email, role, firebase_uid)
   VALUES ($1, $2, $3, 'admin', $4) RETURNING id`,
  ['+917000000001', 'Fixture Admin', ADMIN_EMAIL, `dev:${ADMIN_EMAIL}`],
);

for (const c of CUSTOMERS) {
  await db.query(
    `INSERT INTO users (phone, name, email, firebase_uid) VALUES ($1, $2, $3, $4)`,
    [c.phone, c.name, c.email, `dev:${c.phone}`],
  );
}

const created: Array<{ id: string; name: string }> = [];

for (const salon of SALONS) {
  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (phone, name, email, role, firebase_uid)
     VALUES ($1, $2, $3, 'business', $4) RETURNING id`,
    [salon.owner.phone, salon.owner.name, salon.owner.email, `dev:${salon.owner.phone}`],
  );
  const ownerId = owner.rows[0]!.id;

  const r = await db.query<{ id: string }>(
    `INSERT INTO salons (owner_id, name, address, city, area, lat, lng, timezone,
                         status, onboarded_by, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Asia/Kolkata', 'active', $8, $8, now())
     RETURNING id`,
    [ownerId, salon.name, salon.address, salon.city, salon.area, salon.lat, salon.lng, admin.rows[0]!.id],
  );
  const salonId = r.rows[0]!.id;
  created.push({ id: salonId, name: salon.name });

  for (const [serviceName, [price, duration]] of Object.entries(salon.prices)) {
    const serviceId = serviceIds.get(serviceName);
    if (!serviceId) {
      console.error(`Catalogue has no service named "${serviceName}" — update seed-catalog.ts or this fixture.`);
      process.exit(1);
    }
    await db.query(
      `INSERT INTO salon_services (salon_id, service_id, price, duration_min, buffer_min)
       VALUES ($1, $2, $3, $4, 10)`,
      [salonId, serviceId, price, duration],
    );
  }

  // Closed Mondays (weekday 1), so the grey-out path has something to grey out.
  for (const weekday of [0, 2, 3, 4, 5, 6]) {
    await db.query(
      `INSERT INTO salon_hours (salon_id, weekday, open_at, close_at, break_start,
                                break_end, online_capacity, slot_interval_min)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [salonId, weekday, salon.open, salon.close, salon.break?.[0] ?? null,
       salon.break?.[1] ?? null, salon.capacity, salon.interval],
    );
  }
}

console.log('CI fixtures:');
for (const s of created) console.log(`  ${s.id}  ${s.name}`);
console.log(`\nadmin: ${ADMIN_EMAIL}  (set ADMIN_EMAILS=${ADMIN_EMAIL})`);
console.log(`customers: ${CUSTOMERS.length}, owners: ${SALONS.length}`);

await db.end();
