/**
 * Run the background jobs once and exit. This is the command a Render Cron Job
 * (or any external scheduler) runs on a clock.
 *
 *   npm run jobs
 *
 * Why this exists
 * ---------------
 * The four background jobs — expiring holds, processing refunds, sending queued
 * mail, sweeping staged images — normally run as interval loops INSIDE the web
 * process (startWorkers in src/http/server.ts). On a box that is always awake
 * that is enough and this script is never needed.
 *
 * On Render's FREE web tier it is not enough: the service sleeps after ~15
 * minutes with no HTTP traffic, and a sleeping process runs no timers. Holds
 * then expire late, refunds queue up, and mail waits — the "the cron isn't
 * working" symptom. A Render Cron Job is a separate container that wakes on its
 * own schedule regardless of whether the web service is asleep, so pointing one
 * at this script is what makes the jobs actually run in that deployment.
 *
 * Safety
 * ------
 *   - Every job takes a Postgres advisory lock first (see workers/runner.ts),
 *     so this can run at the same time as the in-process workers, or as a
 *     second cron container, without doing any work twice. An overlapping tick
 *     finds the lock held and skips.
 *   - It runs each job once and exits. A cron command that does not exit holds
 *     an instance slot open until Render kills it; this one closes the pool and
 *     returns.
 *   - Exit code is 1 if any job threw, so a failed run shows up red in Render's
 *     cron history instead of passing silently.
 *
 * It deliberately does NOT run migrations or bind a port. It is the jobs and
 * nothing else. The snapshot cache is omitted on purpose: it is per-process
 * in-memory, so invalidating this short-lived process's copy would do nothing
 * for the web process — whose cache expires on its own 60s TTL anyway.
 */
import { getPool } from '../src/db/pool.ts';
import { runJobsOnce } from '../src/workers/runner.ts';
import { paymentsConfigFromEnv } from '../src/payments/razorpay.ts';
import { channelFromEnv } from '../src/notify/dispatch.ts';
import { log, reportError } from '../src/obs/logger.ts';

const db = getPool();
const payments = paymentsConfigFromEnv(false);

let code = 0;
try {
  const { ok } = await runJobsOnce({
    db,
    razorpay: payments.client,
    channel: channelFromEnv(),
  });
  if (!ok) code = 1;
} catch (err) {
  reportError(err, { during: 'run-jobs' });
  code = 1;
} finally {
  await db.end();
}

// One process, one run, one exit. Anything still holding the loop open (a
// stray timer) would keep the cron container alive past its work; make the
// exit explicit.
log.info('run-jobs exiting', { code });
process.exit(code);
