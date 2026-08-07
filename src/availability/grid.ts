import type { DayHours } from '../types.ts';
import { parseHHMM } from '../time/tz.ts';

/**
 * The bookable slot grid for one local date.
 *
 * `segments` is the important part. Each segment is a maximal run of slots a
 * single booking may span. The lunch break splits the day into two segments,
 * and slots are only emitted while `start + interval <= segmentEnd`.
 *
 * That makes two of the spec's four exclusion rules structural rather than
 * post-hoc filters: a booking cannot cross the break and cannot run past
 * closing, because the slots it would need are simply not in the grid. The
 * other two rules (holiday, 15-minute lead time) are handled by the caller and
 * the engine respectively.
 */
export interface DayGrid {
  /** local YYYY-MM-DD */
  date: string;
  timezone: string;
  slotIntervalMin: number;
  capacity: number;
  /** minutes from local midnight, ascending, grouped into bookable runs */
  segments: number[][];
}

export function buildDayGrid(hours: DayHours, date: string, timezone: string): DayGrid {
  const interval = hours.slotIntervalMin;
  if (!Number.isInteger(interval) || interval <= 0) {
    throw new Error(`bad slot_interval_min: ${interval}`);
  }

  const open = parseHHMM(hours.openAt);
  const close = parseHHMM(hours.closeAt);

  const windows: Array<[number, number]> = [];
  if (hours.breakStart !== null && hours.breakEnd !== null) {
    const rawStart = parseHHMM(hours.breakStart);
    const rawEnd = parseHHMM(hours.breakEnd);
    const breakStart = Math.min(Math.max(rawStart, open), close);
    const breakEnd = Math.min(Math.max(rawEnd, open), close);
    if (breakEnd > breakStart) {
      windows.push([open, breakStart], [breakEnd, close]);
    } else {
      windows.push([open, close]);
    }
  } else {
    windows.push([open, close]);
  }

  const segments: number[][] = [];
  for (const [from, to] of windows) {
    // Snap the window start up to the next point on the day's grid, so every
    // slot in the day is congruent to `open` mod interval. Without this, a
    // break ending at 13:15 on a 30-min grid would emit 13:15/13:45 slots and
    // the salon's "2/4 booked" counter would refer to two different grids
    // depending on the time of day.
    const offset = from - open;
    const snapped = open + Math.ceil(offset / interval) * interval;
    const slots: number[] = [];
    for (let t = snapped; t + interval <= to; t += interval) slots.push(t);
    if (slots.length > 0) segments.push(slots);
  }

  return { date, timezone, slotIntervalMin: interval, capacity: hours.onlineCapacity, segments };
}

