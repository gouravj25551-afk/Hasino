/** Money is always paise. Durations are always whole minutes. */

export interface CartItem {
  serviceId: string;
  name: string;
  /** paise */
  price: number;
  durationMin: number;
  bufferMin: number;
}

/**
 * One row of salon_hours. A weekday with no row is a non-working day.
 * weekday: 0 = Sunday, matching Postgres EXTRACT(DOW) and JS getUTCDay().
 * Times are wall-clock in the salon's timezone, "HH:MM" or "HH:MM:SS".
 */
export interface DayHours {
  weekday: number;
  openAt: string;
  closeAt: string;
  breakStart: string | null;
  breakEnd: string | null;
  onlineCapacity: number;
  slotIntervalMin: number;
}

/**
 * Everything about a salon's 7-day window that does NOT depend on the cart.
 * This is the cacheable unit — see cache.ts for why the cart must stay out.
 */
export interface WindowSnapshot {
  salonId: string;
  timezone: string;
  /** keyed by weekday 0-6 */
  hours: Map<number, DayHours>;
  /** local YYYY-MM-DD keys */
  holidays: Set<string>;
  /** slot start (epoch ms) -> number of chairs consumed */
  occupancy: Map<number, number>;
  /** when the snapshot was read, for staleness assertions in tests */
  takenAt: Date;
}

export interface PartialSuggestion {
  at: Date;
  /** contiguous free minutes starting at `at` */
  freeMin: number;
  /** every cart service that would fit in the gap */
  fits: CartItem[];
  /** the one to actually offer: highest price among `fits` (spec §2) */
  suggest: CartItem;
}

export type DayState = 'full' | 'partial' | 'none' | 'closed';

/**
 * How much of the salon's concurrent capacity is left at one start time.
 *
 * "Chairs" is salon_hours.online_capacity: the number of customers the salon
 * can serve at the same time, per slot — not a budget for the day. A salon
 * with 3 chairs can hold three separate 10:00-10:30 bookings, and the fourth
 * customer is the one who is turned away.
 *
 * `taken` is the worst slot the cart would occupy, not the first: a 60-minute
 * cart starting at 10:00 on a 30-minute grid is only bookable if BOTH 10:00
 * and 10:30 still have a chair, so what is left at 10:00 alone would overstate
 * availability.
 */
export type SlotState = 'open' | 'limited' | 'full';

export interface SlotAvailability {
  at: Date;
  /** chairs the salon released online for this weekday */
  capacity: number;
  /** chairs already consumed at the binding slot of this cart's run */
  taken: number;
  /** how many more customers can still start this cart here: capacity - taken */
  remaining: number;
  /** 'open' = untouched, 'limited' = some chairs gone, 'full' = none left */
  state: SlotState;
}

export interface DayAvailability {
  /** local YYYY-MM-DD */
  date: string;
  state: DayState;
  /** why the day is closed, when state === 'closed' */
  closedReason: 'holiday' | 'not_working' | null;
  /** chairs this weekday runs on; 0 on a closed day */
  capacity: number;
  /**
   * Every start time the cart *fits* into, bookable or not, with what is left
   * at each. `full` below is the bookable subset — this is what lets the UI
   * show a taken time as taken instead of hiding it.
   */
  slots: SlotAvailability[];
  /** valid start times for the whole cart */
  full: Date[];
  /** only meaningful when full.length === 0 (spec §2, "fallback, not the default view") */
  partial: PartialSuggestion[];
}

export interface Availability {
  salonId: string;
  timezone: string;
  /** total minutes the cart occupies, buffer included */
  requiredMin: number;
  days: DayAvailability[];
}
