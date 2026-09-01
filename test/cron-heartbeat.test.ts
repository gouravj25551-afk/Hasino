/**
 * The cron liveness record.
 *
 * This is what makes "is the background-job cron running in production?"
 * answerable without the Render dashboard: runJobsOnce() upserts one row,
 * /readyz reports its age. The tests here pin the two behaviours that matter —
 * the row is a single upsert (never a growing history table), and its counter
 * advances per run so a stalled cron is visible as an old timestamp against a
 * frozen count.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';

import { recordCronHeartbeat, readCronHeartbeat } from '../src/obs/heartbeat.ts';
import { connect, reset } from './db.ts';

const pool = await connect();
const run = pool ? describe : describe.skip;

run('cron heartbeat', () => {
  before(async () => { await reset(pool!); });
  after(async () => { await pool!.end(); });

  it('is empty until the cron has run', async () => {
    assert.equal(await readCronHeartbeat(pool!), null);
  });

  it('records a run, and reads it back', async () => {
    await recordCronHeartbeat(pool!, { ok: true, ms: 42, runId: 'aaaa1111', counts: { 'sweep-holds.expired': 3 } });
    const hb = await readCronHeartbeat(pool!);
    assert.ok(hb, 'heartbeat present');
    assert.equal(hb!.ok, true);
    assert.equal(hb!.ms, 42);
    assert.equal(hb!.runId, 'aaaa1111');
    assert.deepEqual(hb!.counts, { 'sweep-holds.expired': 3 });
    assert.equal(hb!.runs, 1);
    // Recent, so /readyz would report a small age.
    assert.ok(Date.now() - hb!.lastRunAt.getTime() < 60_000);
  });

  it('stays one row and advances the counter on each run', async () => {
    await recordCronHeartbeat(pool!, { ok: false, ms: 10, runId: 'bbbb2222', counts: {} });
    const hb = await readCronHeartbeat(pool!);
    assert.equal(hb!.runs, 2, 'counter advanced');
    assert.equal(hb!.ok, false, 'latest run state wins');
    assert.equal(hb!.runId, 'bbbb2222');
    const { rows } = await pool!.query<{ n: string }>(`SELECT count(*)::int8 AS n FROM cron_heartbeat`);
    assert.equal(Number(rows[0]!.n), 1, 'exactly one heartbeat row, never a history table');
  });
});
