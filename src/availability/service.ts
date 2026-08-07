import type { Pool, PoolClient } from '../db/pool.ts';
import type { Availability, CartItem, DayAvailability, WindowSnapshot } from '../types.ts';
import { addDays, localDateKey, weekdayOf } from '../time/tz.ts';
import { buildDayGrid } from './grid.ts';
import { type BufferPolicy, cartRequiredMin, closedDay, computeDayAvailability } from './engine.ts';
import { type SnapshotCache, noCache } from './cache.ts';
import { WINDOW_DAYS, loadWindowSnapshot } from './repo.ts';

/**
 * Availability over the 7-day window for a specific cart.
 *
 * Pure given a snapshot — this is the function the tests drive directly.
 */
export function availabilityFromSnapshot(
  snapshot: WindowSnapshot,
  cart: CartItem[],
  now: Date = new Date(),
  bufferPolicy?: BufferPolicy,
): Availability {
  const { timezone } = snapshot;
  const today = localDateKey(now, timezone);
  const days: DayAvailability[] = [];

  for (let i = 0; i < WINDOW_DAYS; i++) {
    const date = addDays(today, i);

    if (snapshot.holidays.has(date)) {
      days.push(closedDay(date, 'holiday'));
      continue;
    }

    const hours = snapshot.hours.get(weekdayOf(date));
    if (!hours) {
      days.push(closedDay(date, 'not_working'));
      continue;
    }

    days.push(
      computeDayAvailability({
        grid: buildDayGrid(hours, date, timezone),
        cart,
        occupancy: snapshot.occupancy,
        now,
        bufferPolicy,
      }),
    );
  }

  return {
    salonId: snapshot.salonId,
    timezone,
    requiredMin: cartRequiredMin(cart, bufferPolicy),
    days,
  };
}

export interface GetAvailabilityOptions {
  cache?: SnapshotCache;
  now?: Date;
  bufferPolicy?: BufferPolicy;
}

export async function getAvailability(
  db: Pool | PoolClient,
  salonId: string,
  cart: CartItem[],
  opts: GetAvailabilityOptions = {},
): Promise<Availability | null> {
  const cache = opts.cache ?? noCache;
  const now = opts.now ?? new Date();

  let snapshot = await cache.get(salonId);
  if (!snapshot || localDateKey(snapshot.takenAt, snapshot.timezone) !== localDateKey(now, snapshot.timezone)) {
    // A snapshot taken before local midnight describes a window starting on
    // the wrong day; TTL alone does not catch that.
    snapshot = await loadWindowSnapshot(db, salonId, now);
    if (!snapshot) return null;
    await cache.set(salonId, snapshot);
  }

  return availabilityFromSnapshot(snapshot, cart, now, opts.bufferPolicy);
}

/** For the date strip: days the customer can tap into without a dead end. */
export function bookableDates(availability: Availability): string[] {
  return availability.days.filter((d) => d.state !== 'closed' && d.state !== 'none').map((d) => d.date);
}
