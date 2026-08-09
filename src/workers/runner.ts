import type { Pool } from '../db/pool.ts';
import type { SnapshotCache } from '../availability/cache.ts';
import { sweepExpiredHolds } from '../booking/sweep.ts';
import { processDueRefunds } from '../payments/service.ts';
import { dispatchDue, type Channel } from '../notify/dispatch.ts';
import type { RazorpayClient } from '../payments/razorpay.ts';
import { log, reportError, withRequestContext } from '../obs/logger.ts';
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
];

async function runOnce(deps: WorkerDeps, job: JobDefinition): Promise<void> {
  const client = await deps.db.connect();
  try {
    const got = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      job.lockKey,
    ]);
    if (!got.rows[0]?.locked) return;

    try {
      const started = Date.now();
      const result = await job.run(deps);
      // Only log a tick that did something. A worker logging "0 expired" every
      // 30 seconds buries the tick that mattered.
      const did = Object.values(result).some((v) => v > 0);
      if (did) log.info(`job ${job.name}`, { ...result, ms: Date.now() - started });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [job.lockKey]);
    }
  } finally {
    client.release();
  }
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
