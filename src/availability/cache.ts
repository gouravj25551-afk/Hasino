import type { WindowSnapshot } from '../types.ts';

/**
 * Spec §2: "Cache per salon in Redis for 60s, key avail:{salon_id}.
 *           Invalidate on any booking create/cancel for that salon."
 *
 * What is cached matters. The key has no cart in it, so the cached value must
 * not depend on the cart. Caching the computed slot list under avail:{salon_id}
 * would serve the 30-minute haircut's slots to the next customer's 90-minute
 * cart — they would see start times that cannot hold their booking, tap one,
 * and get rejected by the advisory-lock re-check at the end of a payment flow.
 *
 * So the cached unit is the WindowSnapshot: hours, holidays, occupancy. Those
 * are salon-wide facts. The per-cart computation is pure and runs on every
 * request; it is a few hundred integer comparisons.
 */
export interface SnapshotCache {
  get(salonId: string): Promise<WindowSnapshot | null>;
  set(salonId: string, snapshot: WindowSnapshot): Promise<void>;
  invalidate(salonId: string): Promise<void>;
}

export const SNAPSHOT_TTL_MS = 60_000;

export function cacheKey(salonId: string): string {
  return `avail:${salonId}`;
}

/** Default for tests and single-process dev. Swap for Redis in production. */
export class MemorySnapshotCache implements SnapshotCache {
  #entries = new Map<string, { snapshot: WindowSnapshot; expiresAt: number }>();
  #ttlMs: number;

  constructor(ttlMs: number = SNAPSHOT_TTL_MS) {
    this.#ttlMs = ttlMs;
  }

  async get(salonId: string): Promise<WindowSnapshot | null> {
    const hit = this.#entries.get(cacheKey(salonId));
    if (!hit) return null;
    if (Date.now() >= hit.expiresAt) {
      this.#entries.delete(cacheKey(salonId));
      return null;
    }
    return hit.snapshot;
  }

  async set(salonId: string, snapshot: WindowSnapshot): Promise<void> {
    this.#entries.set(cacheKey(salonId), { snapshot, expiresAt: Date.now() + this.#ttlMs });
  }

  async invalidate(salonId: string): Promise<void> {
    this.#entries.delete(cacheKey(salonId));
  }
}

/** Cache that never hits — the safe default until Redis is wired up. */
export const noCache: SnapshotCache = {
  async get() {
    return null;
  },
  async set() {},
  async invalidate() {},
};
