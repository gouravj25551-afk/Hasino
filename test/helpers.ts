import type { CartItem, DayHours, WindowSnapshot } from '../src/types.ts';
import { formatHHMM, localMinutes, parseHHMM, zonedTimeToUtc } from '../src/time/tz.ts';

export const TZ = 'Asia/Kolkata';

/** A Monday. Every fixture salon works all 7 days, so the weekday is arbitrary. */
export const DATE = '2026-08-03';

/** 06:00 local — before any fixture salon opens, so the 15-min lead rule never fires. */
export const NOW = zonedTimeToUtc(TZ, DATE, 6 * 60);

/** Instant of a local wall-clock time on a fixture date. */
export function at(hhmm: string, date: string = DATE): Date {
  return zonedTimeToUtc(TZ, date, parseHHMM(hhmm));
}

/** "10:00" for an instant — makes assertion failures readable. */
export function hhmm(instant: Date): string {
  return formatHHMM(localMinutes(instant, TZ));
}

export function times(instants: Date[]): string[] {
  return instants.map(hhmm);
}

export function service(
  name: string,
  durationMin: number,
  price: number,
  bufferMin = 10,
): CartItem {
  return { serviceId: `svc-${name}`, name, price, durationMin, bufferMin };
}

export interface HoursInput {
  openAt?: string;
  closeAt?: string;
  breakStart?: string | null;
  breakEnd?: string | null;
  onlineCapacity?: number;
  slotIntervalMin?: number;
}

export function hoursFor(input: HoursInput = {}): Map<number, DayHours> {
  const map = new Map<number, DayHours>();
  for (let weekday = 0; weekday < 7; weekday++) {
    map.set(weekday, {
      weekday,
      openAt: input.openAt ?? '10:00',
      closeAt: input.closeAt ?? '13:00',
      breakStart: input.breakStart ?? null,
      breakEnd: input.breakEnd ?? null,
      onlineCapacity: input.onlineCapacity ?? 2,
      slotIntervalMin: input.slotIntervalMin ?? 30,
    });
  }
  return map;
}

/** [["11:00", 2], ...] -> occupancy map keyed by epoch ms. */
export function occupancy(entries: Array<[string, number]>, date: string = DATE): Map<number, number> {
  const map = new Map<number, number>();
  for (const [time, count] of entries) map.set(at(time, date).getTime(), count);
  return map;
}

export function snapshot(input: {
  hours?: Map<number, DayHours>;
  holidays?: string[];
  occupancy?: Map<number, number>;
  now?: Date;
} = {}): WindowSnapshot {
  return {
    salonId: 'salon-fixture',
    timezone: TZ,
    hours: input.hours ?? hoursFor(),
    holidays: new Set(input.holidays ?? []),
    occupancy: input.occupancy ?? new Map(),
    takenAt: input.now ?? NOW,
  };
}
