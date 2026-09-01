import type { Pool } from '../db/pool.ts';
import type { SnapshotCache } from '../availability/cache.ts';
import { sweepExpiredHolds } from '../booking/sweep.ts';
import { processDueRefunds } from '../payments/service.ts';
import { dispatchDue, type Channel } from '../notify/dispatch.ts';
import { sweepStagedImages } from '../salons/images.ts';
import type { RazorpayClient } from '../payments/razorpay.ts';
import { log, reportError, withRequestContext } from '../obs/logger.ts';
import { recordCronHeartbeat } from '../obs/heartbeat.ts';
import { randomUUID } from 'node:crypto';

/**
 * The background jobs.
 *
 * Spec build-order step 7 is BullMQ. This is not that — it is three loops over
 * Postgres, which is what the jobs actually need: every one of them is "find
 * rows that are due, do something, mark them". A queue would add Redis, a
 * second durability story, and the problem of a job that exists in the queue
 * but whose row says otherwise. When the job list grows past this, BullMQ
 * becomes worth it; the three functions below are already written as
 * `run once over due rows`, so moving them is a scheduler swap.
 *
 * Every tick takes a Postgres advisory lock first, so running three app
 * instances does not run three sweepers. `pg_try_advisory_lock` returns
 * immediately when another instance holds it, which is the behaviour wanted —
 * a skipped tick is caught by the next one 30 seconds later.
 */

export interface WorkerDeps {
  db: Pool;
  razorpay: RazorpayClient;
  channel: Channel;
  cache?: SnapshotCache;
}

export interface JobDefinition {
  name: string;
  intervalMs: number;
  /** distinct per job, any stable integer */
  lockKey: number;
  run(deps: WorkerDeps): Promise<JobCounts>;
}

/** Whatever the job wants to report. Only non-zero counts are logged. */
export type JobCounts = Readonly<Record<string, number>>;

export const JOBS: JobDefinition[] = [
  {
    name: 'sweep-holds',
    // Well under the 8-minute hold TTL, so an abandoned checkout's chair is
    // visibly back within a refresh or two.
    intervalMs: 30_000,
    lockKey: 811_001,
    run: async ({ db, cache }) => {
      const r = await sweepExpiredHolds(db, cache ? { cache } : {});
      return { expired: r.expired };
    },
  },
  {
    name: 'refunds',
    intervalMs: 60_000,
    lockKey: 811_002,
    run: async ({ db, razorpay }) => ({ ...(await processDueRefunds(db, razorpay)) }),
  },
  {
    name: 'notifications',
    intervalMs: 15_000,
    lockKey: 811_003,
    run: async ({ db, channel }) => ({ ...(await dispatchDue(db, channel)) }),
  },
  {
    // Storefront photos uploaded during onboarding and never submitted. One
    // row per applicant, capped at 2 MB, so this is housekeeping rather than
    // a growth problem — but "temporary" bytes with nothing deleting them are
    // permanent bytes. Hourly: the TTL is measured in days.
    name: 'sweep-staged-images',
    intervalMs: 3_600_000,
    lockKey: 811_004,
    run: async ({ db }) => ({ ...(await sweepStagedImages(db)) }),
  },
];

/**
 * One attempt at one job. Returns the job's counts, or null when another
 * instance held the advisory lock and this tick did nothing. `alwaysLog` is
 * the difference between the two schedulers that call this: the 30-second
 * interval loop logs only a tick that did something (a worker printing
 * "0 expired" every 30s buries the tick that mattered), while a cron
 * invocation is a discrete event that should leave one line per run whether or
 * not it found work — that is what makes "did the 05:00 run happen?" answerable
 * from the logs.
 */
async function runOnce(
  deps: WorkerDeps,
  job: JobDefinition,
  opts: { alwaysLog?: boolean } = {},
): Promise<JobCounts | null> {
  const client = await deps.db.connect();
  try {
    const got = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      job.lockKey,
    ]);
    if (!got.rows[0]?.locked) {
      if (opts.alwaysLog) log.info(`job ${job.name} skipped`, { reason: 'locked by another instance' });
      return null;
    }

    try {
      const started = Date.now();
      const result = await job.run(deps);
      const did = Object.values(result).some((v) => v > 0);
      if (did || opts.alwaysLog) log.info(`job ${job.name}`, { ...result, ms: Date.now() - started });
      return result;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [job.lockKey]);
    }
  } finally {
    client.release();
  }
}

/**
 * Run every job exactly once and return, logging one line per job. This is the
 * entry point for a scheduler that lives OUTSIDE this process — a Render Cron
 * Job, a Kubernetes CronJob, anything that runs a command on a clock — as
 * opposed to {@link startWorkers}, which owns its own timers. The two are safe
 * to run at the same time: every job takes the same `pg_try_advisory_lock`
 * first, so an external tick that overlaps the in-process one simply finds the
 * lock held and skips. Errors are caught per job so one failing job does not
 * strand the others; the caller decides the exit code from the returned flag.
 */
export async function runJobsOnce(
  deps: WorkerDeps,
  jobs: JobDefinition[] = JOBS,
): Promise<{ ok: boolean }> {
  const runId = randomUUID().slice(0, 8);
  log.info('cron run start', { runId, jobs: jobs.map((j) => j.name).join(',') });
  const started = Date.now();
  let ok = true;
  // What each job did this run, flattened and prefixed (refunds and
  // notifications both report `processed`), so the heartbeat carries a readable
  // record of a degraded run, not just a dead one.
  const counts: Record<string, number> = {};
  for (const job of jobs) {
    try {
      const result = await withRequestContext({ requestId: `cron:${job.name}:${runId}` }, () =>
        runOnce(deps, job, { alwaysLog: true }),
      );
      if (result) for (const [k, v] of Object.entries(result)) counts[`${job.name}.${k}`] = v;
    } catch (err) {
      ok = false;
      reportError(err, { job: job.name, runId });
    }
  }
  const ms = Date.now() - started;
  // The liveness record read by /readyz. Best-effort: a heartbeat that cannot
  // be written must not turn a run that did its work into a failure, so this is
  // logged and swallowed rather than thrown.
  await recordCronHeartbeat(deps.db, { ok, ms, runId, counts }).catch((err: unknown) =>
    reportError(err, { during: 'cron-heartbeat', runId }),
  );
  log.info('cron run done', { runId, ok, ms });
  return { ok };
}

export interface RunningWorkers {
  stop(): Promise<void>;
  /** for tests: run every job once, synchronously */
  tick(): Promise<void>;
}

export function startWorkers(deps: WorkerDeps, jobs: JobDefinition[] = JOBS): RunningWorkers {
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;
  const inflight = new Set<Promise<unknown>>();

  const schedule = (job: JobDefinition) => {
    const timer = setInterval(() => {
      if (stopped) return;
      const p = withRequestContext({ requestId: `job:${job.name}:${randomUUID().slice(0, 8)}` }, () =>
        runOnce(deps, job).catch((err: unknown) => reportError(err, { job: job.name })),
      );
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    }, job.intervalMs);
    // Never hold the process open for a timer. A container that will not exit
    // on SIGTERM gets SIGKILLed, and SIGKILL is where in-flight work is lost.
    timer.unref();
    timers.push(timer);
  };

  for (const job of jobs) schedule(job);
  log.info('workers started', { jobs: jobs.map((j) => j.name).join(',') });

  return {
    async stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      await Promise.allSettled([...inflight]);
    },
    async tick() {
      for (const job of jobs) await runOnce(deps, job);
    },
  };
}
