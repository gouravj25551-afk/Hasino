/**
 * The global service catalogue.
 *
 * `services` is the admin-managed master list every `salon_services` row
 * references. With it empty, an admin onboarding their first salon has nothing
 * to put on the menu and the product does not work — so this is not demo data,
 * it is the minimum a fresh deployment needs.
 *
 * It inserts ZERO users and ZERO salons. People and salons arrive through
 * /admin or the self-serve application, never from a script.
 *
 *   npm run db:seed
 *
 * Safe to re-run and safe against a live database: ON CONFLICT DO NOTHING on
 * the service name, and it truncates nothing. The previous seed truncated
 * every table in the database, which is not a behaviour that should exist in
 * something a person might run against production by mistake.
 *
 * Admins can add more services and categories from the panel afterwards.
 */
import { getPool } from '../src/db/pool.ts';

const SERVICES: Array<{ name: string; category: string }> = [
  { name: 'Haircut', category: 'hair' },
  { name: 'Hair Colour', category: 'hair' },
  { name: 'Hair Spa', category: 'hair' },
  { name: 'Beard Trim', category: 'beard' },
  { name: 'Shave', category: 'beard' },
  { name: 'Facial', category: 'skin' },
  { name: 'Threading', category: 'skin' },
  { name: 'Waxing', category: 'skin' },
  { name: 'Manicure', category: 'nails' },
  { name: 'Pedicure', category: 'nails' },
  { name: 'Head Massage', category: 'spa' },
  { name: 'Bridal Makeup', category: 'bridal' },
];

const db = getPool();

let inserted = 0;
for (const s of SERVICES) {
  const res = await db.query(
    `INSERT INTO services (name, category) VALUES ($1, $2)
     ON CONFLICT (name) DO NOTHING`,
    [s.name, s.category],
  );
  inserted += res.rowCount ?? 0;
}

const total = await db.query<{ n: string }>(`SELECT count(*)::int8 AS n FROM services`);

console.log(`Catalogue: ${inserted} added, ${total.rows[0]!.n} total.`);
console.log('No users or salons were created — onboard those from /admin.');

await db.end();
