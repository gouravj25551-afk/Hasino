/**
 * Bring a database up to date: db/schema.sql first if it is empty, then
 * db/migrations/*.sql in filename order, once each.
 *
 *   node scripts/migrate.ts            apply everything outstanding
 *   node scripts/migrate.ts --status   list what would run, change nothing
 *
 * db/schema.sql is the baseline, not a migration. It creates every table; the
 * numbered files are deltas layered on top of it, which is why 001 opens with
 * `ALTER TABLE users` and would fail on an empty database with `relation
 * "users" does not exist`. That is not an ordering bug — 001 through 007 sort
 * correctly and always did — it is the baseline being missing. Fresh installs
 * used to get it from a hand-run `psql -f db/schema.sql`, which is one step
 * too many to remember on the day you are pointing this at a new host.
 *
 * So: if `users` does not exist, this applies the baseline and records it,
 * then runs the numbered files as usual. On a fresh database those are
 * near-no-ops — every one of them is written to be idempotent, and several say
 * outright that fresh databases already have their column from schema.sql —
 * but they run rather than being marked applied on trust, so the recorded
 * state is something that happened rather than something assumed.
 *
 * Each file runs inside a transaction, and the whole run holds a Postgres
 * advisory lock. Postgres has transactional DDL, so a migration that fails
 * half-way leaves the schema exactly as it was — the failure mode this avoids
 * is the one where a partially-applied migration is recorded as done.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getPool, closePool } from '../src/db/pool.ts';

const DIR = new URL('../db/migrations/', import.meta.url);
const SCHEMA = new URL('../db/schema.sql', import.meta.url);
/** Sorts before 001 and is not a filename in DIR, so the loop never sees it. */
const BASELINE = '000_schema.sql';
const LOCK_KEY = 811_000;
const statusOnly = process.argv.includes('--status');

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const db = getPool();

await db.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    ms         integer
  )
`);

/**
 * Apply db/schema.sql if the database has no tables yet.
 *
 * The test is `users` rather than a row in schema_migrations, so a database
 * built the old way — hand-run psql, no migration ledger — is left alone and
 * only gets the deltas it is missing. Re-creating tables under a live pilot
 * because a bookkeeping table happened to be absent is the one outcome worth
 * ruling out completely, and CREATE TABLE IF NOT EXISTS is not enough on its
 * own: schema.sql also has constraint and index work that is not all guarded.
 */
async function applyBaseline(): Promise<void> {
  const fresh = await db.query<{ fresh: boolean }>(
    `SELECT to_regclass('public.users') IS NULL AS fresh`,
  );
  if (!fresh.rows[0]?.fresh) return;

  const sql = readFileSync(SCHEMA, 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);

  if (statusOnly) {
    console.log(`  + ${BASELINE}  (db/schema.sql, would apply — database is empty)`);
    return;
  }

  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    // Re-check under the lock: two containers booting together must not both
    // lay down the schema.
    const still = await client.query<{ fresh: boolean }>(
      `SELECT to_regclass('public.users') IS NULL AS fresh`,
    );
    if (!still.rows[0]?.fresh) {
      console.log(`  = ${BASELINE}  (applied by another instance)`);
      return;
    }

    const started = Date.now();
    // schema.sql opens with BEGIN and ends with COMMIT of its own, so it is
    // already one transaction — wrapping it in another would only nest.
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum, ms) VALUES ($1, $2, $3)
       ON CONFLICT (filename) DO NOTHING`,
      [BASELINE, checksum, Date.now() - started],
    );
    console.log(`  + ${BASELINE}  (db/schema.sql) ${Date.now() - started}ms`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

try {
  await applyBaseline();
} catch (err) {
  // Same shape as a failed migration below, rather than a raw stack trace: the
  // schema is untouched either way (schema.sql is one transaction), and the
  // message is the part worth reading.
  console.error(`  ! ${BASELINE} (db/schema.sql) failed: ${(err as Error).message}`);
  await closePool();
  process.exit(1);
}

const applied = new Map<string, string>();
for (const row of (await db.query<{ filename: string; checksum: string }>(
  `SELECT filename, checksum FROM schema_migrations`,
)).rows) {
  applied.set(row.filename, row.checksum);
}

let failures = 0;
let ran = 0;

for (const file of files) {
  const sql = readFileSync(new URL(file, DIR), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
  const seen = applied.get(file);

  if (seen === checksum) {
    if (statusOnly) console.log(`  = ${file}`);
    continue;
  }

  if (seen && seen !== checksum) {
    // Editing a migration that has already run means every environment has a
    // different schema and nobody can tell which. Write a new file instead.
    console.error(
      `  ! ${file} has changed since it was applied (${seen} -> ${checksum}).\n` +
        `    Add a new migration rather than editing this one.`,
    );
    failures += 1;
    continue;
  }

  if (statusOnly) {
    console.log(`  + ${file}  (would apply)`);
    continue;
  }

  const client = await db.connect();
  try {
    // Serialise across instances. Two containers booting together must not
    // both run 003.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    // Re-read under the lock: the other instance may have applied it while we
    // were waiting.
    const now = await client.query(`SELECT checksum FROM schema_migrations WHERE filename = $1`, [file]);
    if (now.rows[0]?.checksum === checksum) {
      console.log(`  = ${file}  (applied by another instance)`);
      continue;
    }

    const started = Date.now();
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum, ms) VALUES ($1, $2, $3)
       ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now(), ms = EXCLUDED.ms`,
      [file, checksum, Date.now() - started],
    );
    await client.query('COMMIT');
    console.log(`  + ${file}  ${Date.now() - started}ms`);
    ran += 1;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`  ! ${file} failed: ${(err as Error).message}`);
    failures += 1;
    break; // migrations are ordered; running the next one on a failed schema is guesswork
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

await closePool();

if (failures > 0) {
  console.error(`\n${failures} migration(s) failed.`);
  process.exit(1);
}
console.log(statusOnly ? '\nstatus only, nothing applied.' : `\n${ran} migration(s) applied.`);
