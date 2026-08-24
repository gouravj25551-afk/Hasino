// Dates are ISO 'YYYY-MM-DD'. The app runs against a fixed "today" so the seed
// narrative (due today / overdue) is deterministic in the demo.

// Fixed "today" for the demo, chosen so the seeded ABC Traders story lands on
// its due date (sale 24 Aug + 4-day terms → due 28 Aug).
export const TODAY = '2026-08-28'

export function addDays(iso: string, days: number): string {
  // Pure UTC math so the result never drifts by the local timezone offset
  // (a local-midnight Date formatted via toISOString() shifts a day in IST).
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string): number {
  const utc = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((utc(to) - utc(from)) / 86_400_000)
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '24 Aug' */
export function fmtDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return `${d.getDate()} ${MON[d.getMonth()]}`
}

/** '24 Aug 2026' */
export function fmtFull(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`
}

/** 'Today' / 'Tomorrow' / 'in 3 days' / '5 days ago' */
export function relDue(iso: string): string {
  const d = daysBetween(TODAY, iso)
  if (d === 0) return 'Today'
  if (d === 1) return 'Tomorrow'
  if (d === -1) return 'Yesterday'
  if (d > 0) return `in ${d} days`
  return `${-d} days ago`
}
