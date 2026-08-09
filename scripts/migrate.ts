/**
 * Apply db/migrations/*.sql in filename order, once each.
 *
 *   node scripts/migrate.ts            apply everything outstanding
 *   node scripts/migrate.ts --status   list what would run, change nothing
 *
 * Every migration in this repo is written to be idempotent on its own, which is
 * what makes a hand-run `psql -f` safe. This adds the other half: a record of
 * what has been applied, so a deploy does not re-run six months of DDL on every
 * boot and so two instances starting at once cannot interleave.
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
