/**
 * Apply outstanding migrations before the server starts serving.
 *
 * Why this exists
 * ---------------
 * The schema had no way of reaching production. The Dockerfile's CMD is
 * `node src/main.ts` and nothing runs ahead of it; render.yaml has no
 * pre-deploy command (Render's is a paid-plan feature and this runs on free);
 * and .github/workflows/deploy.yml only migrates when a DATABASE_URL secret is
 * present, which is optional and, unset, degrades to a printed warning nobody
 * reads. So the database advanced only when somebody remembered to run the
 * script by hand, and "the code is newer than the schema" became a state the
 * deploy could reach on its own.
 *
 * That failure is quiet by nature. Migration 010 is an index, so a database
 * missing it serves correct results slightly slower and gives no sign at all.
 * The next migration that adds a column the code reads is the one that turns
 * a deploy into an outage, and by then the lag is weeks old.
 *
 * Why a child process rather than an imported function
 * ---------------------------------------------------
 * scripts/migrate.ts is the project's migration implementation and it is
 * already careful in the ways that matter here: it lays down db/schema.sql on
 * an empty database, holds a Postgres advisory lock so two booting containers
 * cannot both apply 003, wraps each file in a transaction, checksums what it
 * applied so an edited migration is refused rather than silently re-run, and
 * exits non-zero if any of that fails. Running it as-is means boot and the
 * `npm run db:migrate` an operator types are the same code path — there is no
 * second implementation to drift. Refactoring it into an importable function
 * to save a process would have put that proven script at risk to gain nothing
 * this path needs.
 *
 * Opt-in, because the flag is a statement about the environment
 * ------------------------------------------------------------
 * Off by default. A developer's `npm run dev` already migrates through
 * scripts/dev.sh, tests build their own schema, and a machine pointed at a
 * colleague's database should not quietly rewrite it. RUN_MIGRATIONS_ON_BOOT
 * is set where the process genuinely owns its database — the Render service —
 * and nowhere else.
 *
 * What happens when a migration fails
 * -----------------------------------
 * The process exits non-zero and never listens. That reads like the harsher
 * option and is the safer one: Render only shifts traffic to a container that
 * passes its health check, so a failed migration leaves the PREVIOUS version
 * serving, unchanged and healthy. Nothing goes down. Booting anyway would do
 * the opposite — put a build live against a schema it was not written for,
 * which is the outage this is meant to prevent, arrived at by a different
 * route. Postgres has transactional DDL and the script rolls back, so the
 * database is exactly as it was and the fix is a code change, not a repair.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log } from '../obs/logger.ts';

/** Resolved from this module so it holds in the container and in a checkout. */
const SCRIPT = fileURLToPath(new URL('../../scripts/migrate.ts', import.meta.url));

/**
 * A run that hangs is worse than one that fails: without a ceiling a lock held
 * by a stuck instance would keep every new container in "starting" forever,
 * with no deploy and no error. Generous enough for a cold Neon instance and a
 * real migration, short enough that a wedged boot surfaces as one.
 */
const TIMEOUT_MS = 120_000;

export async function migrateOnBoot(): Promise<void> {
  if (process.env['RUN_MIGRATIONS_ON_BOOT'] !== 'true') return;

  // Checked here rather than left to the child so the reason is one line
  // instead of a stack trace out of pool.ts.
  if (!process.env['DATABASE_URL']) {
    log.error('RUN_MIGRATIONS_ON_BOOT is set but DATABASE_URL is not', {
      hint: 'Set DATABASE_URL on the service, or unset RUN_MIGRATIONS_ON_BOOT.',
    });
    process.exit(1);
  }

  log.info('applying database migrations before boot');
  const started = Date.now();

  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      // Inherited so the per-file "+ 011_... 22ms" lines land in the deploy
      // log. When a migration fails, that output is the whole diagnosis.
      stdio: 'inherit',
      env: process.env,
    });

    const timer = setTimeout(() => {
      log.error('migrations timed out', { timeoutMs: TIMEOUT_MS });
      child.kill('SIGKILL');
    }, TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      log.error('could not run the migration script', { error: (err as Error).message });
      resolve(1);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode ?? 1);
    });
  });

  if (code !== 0) {
    log.error('migrations failed — refusing to start', {
      exitCode: code,
      // Said plainly because the deploy log is read by someone who has just
      // seen a health check fail and needs to know what is serving right now.
      effect: 'The previous version keeps serving; this container will not be routed to.',
    });
    process.exit(1);
  }

  log.info('migrations up to date', { ms: Date.now() - started });
}
