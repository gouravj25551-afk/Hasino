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

export interface DayAvailability {
  /** local YYYY-MM-DD */
  date: string;
  state: DayState;
  /** why the day is closed, when state === 'closed' */
  closedReason: 'holiday' | 'not_working' | null;
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
