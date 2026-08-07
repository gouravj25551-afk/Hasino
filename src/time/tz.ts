/**
 * Wall-clock <-> instant conversion for a named IANA zone.
 *
 * salon_hours holds `time` (wall clock, no zone); bookings hold `timestamptz`
 * (instants). Every slot boundary crosses that line, so this is load-bearing.
 *
 * Asia/Kolkata has no DST, so today a fixed +05:30 would work. It is written
 * DST-correct anyway because the cost is ~20 lines and the failure mode of the
 * shortcut — a silently wrong hour, twice a year, in a booking system — is one
 * of the worse bugs to debug from a support ticket.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(zone, f);
  }
  return f;
}

function part(parts: Intl.DateTimeFormatPart[], type: string): number {
  const p = parts.find((x) => x.type === type);
  if (!p) throw new Error(`missing date part: ${type}`);
  return Number(p.value);
}

/** How far ahead of UTC `zone` is at `instant`, in ms. */
export function tzOffsetMs(zone: string, instant: Date): number {
  const p = formatter(zone).formatToParts(instant);
  const asIfUtc = Date.UTC(
    part(p, 'year'),
    part(p, 'month') - 1,
    part(p, 'day'),
    part(p, 'hour'),
    part(p, 'minute'),
    part(p, 'second'),
  );
  return asIfUtc - instant.getTime();
}

/**
 * The instant at which the clock in `zone` reads `dateKey` +
 * `minutesFromMidnight`.
 *
 * Two passes: the offset depends on the instant, and the instant depends on
 * the offset. Converges after one correction for every real-world zone.
 */
export function zonedTimeToUtc(zone: string, dateKey: string, minutesFromMidnight: number): Date {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  const wallMs = Date.UTC(y, m - 1, d) + minutesFromMidnight * 60_000;
  const off1 = tzOffsetMs(zone, new Date(wallMs - 0));
  const off2 = tzOffsetMs(zone, new Date(wallMs - off1));
  return new Date(wallMs - off2);
}

/** Local calendar date of an instant, as YYYY-MM-DD. */
export function localDateKey(instant: Date, zone: string): string {
  const p = formatter(zone).formatToParts(instant);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(part(p, 'year'), 4)}-${pad(part(p, 'month'))}-${pad(part(p, 'day'))}`;
}

/** Minutes since local midnight for an instant. */
export function localMinutes(instant: Date, zone: string): number {
  const p = formatter(zone).formatToParts(instant);
  return part(p, 'hour') * 60 + part(p, 'minute');
}

/** 0 = Sunday, matching Postgres EXTRACT(DOW) and salon_hours.weekday. */
export function weekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (x: number, w = 2) => String(x).padStart(w, '0');
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Accepts "HH:MM" and Postgres's "HH:MM:SS". Seconds are ignored. */
export function parseHHMM(value: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (!m) throw new Error(`bad time literal: ${value}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`bad time literal: ${value}`);
  return h * 60 + min;
}

export function formatHHMM(minutesFromMidnight: number): string {
  const h = Math.floor(minutesFromMidnight / 60);
  const m = minutesFromMidnight % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
