-- 013_cron_heartbeat.sql — a liveness record for the background-job cron.
--
-- Idempotent: safe to re-run. Apply after 012.
--
-- The background jobs run either as in-process interval loops (startWorkers) or
-- as a Render Cron Job invoking `node scripts/run-jobs.ts`. On the free web
-- tier the in-process loops pause whenever the service sleeps, so the cron is
-- what actually keeps the jobs running — and until now there was no way to tell
-- from outside whether that cron was executing at all. Its logs live in the
-- Render dashboard, which not everyone can see.
--
-- This is the fix: runJobsOnce() (the cron path, and only that path) upserts a
-- single row here on every invocation, and GET /readyz reports how long ago
-- that was. A stale heartbeat means the cron is not running; a heartbeat from
-- minutes ago means it is. A timestamp and a count leak nothing, so the check
-- needs no auth.
--
-- One row, enforced: id is pinned to 1 so this can only ever be a heartbeat,
-- never an accidental history table that grows unbounded under a 5-minute cron.

BEGIN;

CREATE TABLE IF NOT EXISTS cron_heartbeat (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_run_at timestamptz NOT NULL DEFAULT now(),
  last_ok     boolean     NOT NULL DEFAULT true,
  -- How long the run took, and what it did — for reading a degraded cron, not
  -- just a dead one.
  last_ms     integer,
  last_run_id text,
  last_counts jsonb,
  runs        bigint      NOT NULL DEFAULT 0
);

COMMIT;
