import type { Pool, PoolClient } from '../db/pool.ts';

type Queryable = Pool | PoolClient;

/**
 * The cron liveness record.
 *
 * runJobsOnce() writes one row (id = 1) on every Render-cron invocation; GET
 * /readyz reads it. The point is a single external, auth-free answer to "is the
 * background-job cron actually running in production?" — a timestamp minutes
 * old means yes, hours old means no. Only the cron path writes it, so it
 * reflects the external scheduler specifically, not the in-process interval
 * workers that sleep with a free-tier web service.
 */
export interface CronHeartbeat {
  lastRunAt: Date;
  ok: boolean;
  ms: number | null;
  runId: string | null;
  counts: Record<string, number> | null;
  runs: number;
}

export async function recordCronHeartbeat(
  db: Queryable,
  run: { ok: boolean; ms: number; runId: string; counts: Record<string, number> },
): Promise<void> {
  await db.query(
    `INSERT INTO cron_heartbeat (id, last_run_at, last_ok, last_ms, last_run_id, last_counts, runs)
          VALUES (1, now(), $1, $2, $3, $4::jsonb, 1)
     ON CONFLICT (id) DO UPDATE
          SET last_run_at = now(),
              last_ok     = $1,
              last_ms     = $2,
              last_run_id = $3,
              last_counts = $4::jsonb,
              runs        = cron_heartbeat.runs + 1`,
    [run.ok, run.ms, run.runId, JSON.stringify(run.counts)],
  );
}

export async function readCronHeartbeat(db: Queryable): Promise<CronHeartbeat | null> {
  const res = await db.query<{
    last_run_at: Date;
    last_ok: boolean;
    last_ms: number | null;
    last_run_id: string | null;
    last_counts: Record<string, number> | null;
    runs: string;
  }>(
    `SELECT last_run_at, last_ok, last_ms, last_run_id, last_counts, runs
       FROM cron_heartbeat WHERE id = 1`,
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    lastRunAt: row.last_run_at,
    ok: row.last_ok,
    ms: row.last_ms,
    runId: row.last_run_id,
    counts: row.last_counts,
    runs: Number(row.runs),
  };
}
