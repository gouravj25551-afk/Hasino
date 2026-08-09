import type { Pool } from '../db/pool.ts';
import type { SnapshotCache } from '../availability/cache.ts';

/**
 * Expired payment holds.
 *
 * A 'pending_payment' booking stops consuming a chair the moment
 * hold_expires_at passes — the occupancy predicate compares against the clock,
 * not against this sweep. The advisory-lock re-check in create.ts re-reads that
 * predicate inside the transaction, so a sweeper that dies cannot sell a chair
 * twice or lose one; it can only leave a stale row behind. What the sweep does
 * is turn that row terminal, which matters for three things the predicate
 * cannot do:
 *
 *   - the customer's "my bookings" list stops showing a booking that is not
 *     going to happen
 *   - the partial index on (hold_expires_at) WHERE status = 'pending_payment'
 *     stays small instead of accumulating every abandoned checkout forever
 *   - a late webhook has something unambiguous to collide with, so the payment
 *     is refunded rather than resurrected onto a chair someone else now holds
 *
 * That ordering is deliberate: correctness lives in the predicate, tidiness
 * lives here. Background jobs that availability depends on are how booking
 * systems oversell.
 */

export interface SweepResult {
  expired: number;
  salonIds: string[];
}

export async function sweepExpiredHolds(
  db: Pool,
  opts: { now?: Date; limit?: number; cache?: SnapshotCache } = {},
): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 500;

  // Batched and skip-locked so two instances of the sweeper — or a sweeper and
  // a deploy rolling over it — cannot both claim the same row.
  const res = await db.query<{ id: string; salon_id: string }>(
    `UPDATE bookings b
        SET status = 'expired'
      WHERE b.id IN (
        SELECT id FROM bookings
         WHERE status = 'pending_payment'
           AND hold_expires_at <= $1
         ORDER BY hold_expires_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING b.id, b.salon_id`,
    [now, limit],
  );

  const salonIds = [...new Set(res.rows.map((r) => r.salon_id))];

  // The cached snapshot stores occupancy as slot -> count, with the hold
  // already folded in; the engine cannot tell which of those counts has since
  // expired. So a snapshot taken while the hold was live keeps the chair
  // hidden for the rest of its 60s TTL. That errs towards showing fewer slots,
  // never towards overselling — but a customer refreshing after an abandoned
  // checkout should see the chair come back, so invalidate.
  if (opts.cache) {
    await Promise.all(salonIds.map((id) => opts.cache!.invalidate(id)));
  }

  return { expired: res.rowCount ?? 0, salonIds };
}
