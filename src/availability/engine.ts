import type { CartItem, DayAvailability, PartialSuggestion, SlotAvailability } from '../types.ts';
import type { DayGrid } from './grid.ts';
import { zonedTimeToUtc } from '../time/tz.ts';

/** Spec §2: "it is less than 15 minutes from now". */
export const MIN_LEAD_MIN = 15;

/**
 * How a cart's buffers combine into the booking's total buffer.
 *
 * The spec is ambiguous here and it changes real slot math:
 *   §2 formula:      ceil((sum of durations + buffer) / interval)   <- one buffer
 *   §2 partial-fit:  s.duration + s.buffer <= freeMin               <- per service
 *
 * 'max' reads the singular "+ buffer" as one turnaround per booking, sized by
 * the messiest service in it. A colour + beard cart needs the colour's cleanup,
 * not the beard's, and not both. 'sum' is the conservative reading: a 3-service
 * cart burns 30 extra minutes of chair, which on a 30-min grid is a whole extra
 * slot the salon cannot sell.
 *
 * This is worth an explicit decision with the salons before launch — it is the
 * difference between selling 10 and 9 bookings on a busy Saturday. Flip the
 * constant when they answer.
 */
export type BufferPolicy = 'max' | 'sum';
export const BUFFER_POLICY: BufferPolicy = 'max';

export function cartBufferMin(cart: CartItem[], policy: BufferPolicy = BUFFER_POLICY): number {
  if (cart.length === 0) return 0;
  return policy === 'sum'
    ? cart.reduce((a, c) => a + c.bufferMin, 0)
    : cart.reduce((a, c) => Math.max(a, c.bufferMin), 0);
}

/** Total minutes of chair the cart consumes, buffer included. */
export function cartRequiredMin(cart: CartItem[], policy: BufferPolicy = BUFFER_POLICY): number {
  return cart.reduce((a, c) => a + c.durationMin, 0) + cartBufferMin(cart, policy);
}

/** N from spec §2. */
export function slotsNeeded(requiredMin: number, slotIntervalMin: number): number {
  return Math.ceil(requiredMin / slotIntervalMin);
}

export interface ComputeDayOptions {
  grid: DayGrid;
  cart: CartItem[];
  /** slot start (epoch ms) -> chairs consumed */
  occupancy: Map<number, number>;
  now: Date;
  minLeadMin?: number;
  bufferPolicy?: BufferPolicy;
  /** cap on partial suggestions returned per day */
  maxPartials?: number;
}

/**
 * Availability for a single open day.
 *
 * O(slots): one backward pass computes, for every index, how many consecutive
 * slots are free from there. The spec's sketch rescans forward from each index,
 * which is O(slots^2) — harmless at ~30 slots a day, but the backward pass is
 * no harder to read and removes the question.
 */
export function computeDayAvailability(opts: ComputeDayOptions): DayAvailability {
  const { grid, cart, occupancy, now } = opts;
  const minLead = opts.minLeadMin ?? MIN_LEAD_MIN;
  const maxPartials = opts.maxPartials ?? 3;

  const interval = grid.slotIntervalMin;
  const required = cartRequiredMin(cart, opts.bufferPolicy);
  const needed = slotsNeeded(required, interval);
  const earliest = now.getTime() + minLead * 60_000;

  const full: Date[] = [];
  const slots: SlotAvailability[] = [];
  const partial: PartialSuggestion[] = [];

  // capacity 0 means the salon released no chairs online for this weekday
  if (grid.capacity > 0 && cart.length > 0) {
    for (const segment of grid.segments) {
      const n = segment.length;
      const at = segment.map((m) => zonedTimeToUtc(grid.timezone, grid.date, m));
      const bookedAt = (i: number) => occupancy.get(at[i]!.getTime()) ?? 0;

      // freeRun[i] = consecutive slots with spare capacity starting at i,
      // truncated at the segment end (= the break, or closing time)
      const freeRun = new Array<number>(n).fill(0);
      for (let i = n - 1; i >= 0; i--) {
        freeRun[i] = bookedAt(i) < grid.capacity ? (i + 1 < n ? freeRun[i + 1]! : 0) + 1 : 0;
      }

      for (let i = 0; i < n; i++) {
        const start = at[i]!;
        if (start.getTime() < earliest) continue;

        // What the customer is shown about this start time. Only start times
        // the cart actually fits into get a row: a 12:30 that cannot hold a
        // 60-minute cart before closing is not "full", it is not a start time
        // at all, and showing it as taken would be a lie about the salon.
        if (i + needed <= n) {
          // The binding slot decides. One free chair at 10:00 is worth nothing
          // to a two-slot cart if 10:30 is already full.
          let taken = 0;
          for (let j = i; j < i + needed; j++) taken = Math.max(taken, bookedAt(j));
          const remaining = Math.max(0, grid.capacity - taken);
          slots.push({
            at: start,
            capacity: grid.capacity,
            taken: Math.min(taken, grid.capacity),
            remaining,
            state: remaining === 0 ? 'full' : remaining < grid.capacity ? 'limited' : 'open',
          });
        }

        const run = freeRun[i]!;
        if (run >= needed) {
          full.push(start);
          continue;
        }

        const freeMin = run * interval;
        if (freeMin <= 0) continue;
        const fits = cart.filter((s) => s.durationMin + s.bufferMin <= freeMin);
        if (fits.length === 0) continue;

        // Spec §2: offer ONE option, the highest-value service that fits —
        // not every subset combination.
        const suggest = fits.reduce((best, s) => (s.price > best.price ? s : best));
        partial.push({ at: start, freeMin, fits, suggest });
      }
    }
  }

  full.sort((a, b) => a.getTime() - b.getTime());
  slots.sort((a, b) => a.at.getTime() - b.at.getTime());
  partial.sort((a, b) => a.at.getTime() - b.at.getTime());

  return {
    date: grid.date,
    state: full.length > 0 ? 'full' : partial.length > 0 ? 'partial' : 'none',
    closedReason: null,
    capacity: grid.capacity,
    slots,
    full,
    // Partials are a fallback view. When any full-fit start exists the client
    // shows the clean list, so shipping them would be dead weight in the payload.
    partial: full.length > 0 ? [] : partial.slice(0, maxPartials),
  };
}

export function closedDay(date: string, reason: 'holiday' | 'not_working'): DayAvailability {
  return { date, state: 'closed', closedReason: reason, capacity: 0, slots: [], full: [], partial: [] };
}
