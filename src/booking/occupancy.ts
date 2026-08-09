/**
 * The one definition of "this booking is holding a chair".
 *
 * This predicate appears in exactly two places that must never disagree:
 *
 *   src/availability/repo.ts  — what the customer is shown
 *   src/booking/create.ts     — the advisory-lock re-check that commits
 *
 * If the read counts a status the re-check does not, the app offers slots it
 * then rejects. If the re-check counts one the read does not, the app
 * double-books. Both were one careless edit away while the list was written out
 * twice, so it lives here instead.
 *
 * A 'pending_payment' hold consumes a chair only while it is unexpired. The
 * comparison is against a parameter rather than now() so tests can drive the
 * clock; the sweeper (sweep.ts) then flips expired rows to 'expired' so they
 * stop matching on their status alone.
 */

export const SETTLED_CHAIR_STATUSES = ['booked', 'verified', 'in_progress'] as const;

/**
 * SQL fragment for a joined `bookings b`.
 *
 * `nowParam` is a placeholder this codebase generates ($1, $2, ...), never a
 * caller-supplied string — there is no interpolation of data here.
 */
export function chairConsumingSql(nowParam: string, alias = 'b'): string {
  return `(
    ${alias}.status IN ('booked','verified','in_progress')
    OR (${alias}.status = 'pending_payment' AND ${alias}.hold_expires_at > ${nowParam})
  )`;
}
