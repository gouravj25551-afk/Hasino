import type { Pool } from '../db/pool.ts';
import { withTransaction } from '../db/pool.ts';
import { BookingError } from './errors.ts';

export type BookingStatus =
  | 'booked'
  | 'verified'
  | 'in_progress'
  | 'completed'
  | 'no_show'
  | 'rescheduled'
  | 'cancelled_by_customer'
  | 'cancelled_by_salon';

/**
 * Spec §4. Only these moves are legal; everything else is a bug or a
 * double-tap on a barber's phone.
 *
 * The three chair-consuming statuses (booked, verified, in_progress) are the
 * ones availability counts — see src/availability/repo.ts. Every terminal
 * status here releases the chair, which is why no explicit slot cleanup is
 * needed on cancel.
 */
export const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  booked: ['verified', 'no_show', 'cancelled_by_customer', 'cancelled_by_salon', 'rescheduled'],
  verified: ['in_progress', 'no_show', 'cancelled_by_salon'],
  in_progress: ['completed', 'cancelled_by_salon'],
  completed: [],
  no_show: ['rescheduled'],
  rescheduled: [],
  cancelled_by_customer: ['rescheduled'],
  cancelled_by_salon: [],
};

export class InvalidTransitionError extends BookingError {
  constructor(from: BookingStatus, to: BookingStatus) {
    super('INVALID_TRANSITION', `Cannot go from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class BadCodeError extends BookingError {
  constructor() {
    super('BAD_CODE', 'That code does not match this booking');
    this.name = 'BadCodeError';
  }
}

export class BookingNotFoundError extends BookingError {
  constructor() {
    super('NOT_FOUND', 'Booking not found for this salon');
    this.name = 'BookingNotFoundError';
  }
}

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Spec §4: 6 digits. Uniform over 000000-999999, no modulo bias. */
export function generateVerifyCode(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

/** Spec §4: no_show / cancel -> reschedule allowed within 36 hours. */
export const RESCHEDULE_WINDOW_HOURS = 36;

interface TransitionOptions {
  code?: string;
  now?: Date;
}

/**
 * Move a booking to `to`, re-reading its current status inside the
 * transaction. Scoped to salonId so a salon cannot touch another's bookings.
 */
export async function transition(
  db: Pool,
  salonId: string,
  bookingId: string,
  to: BookingStatus,
  opts: TransitionOptions = {},
): Promise<{ id: string; status: BookingStatus; customerId: string }> {
  const now = opts.now ?? new Date();

  return withTransaction(db, async (tx) => {
    const res = await tx.query<{ status: BookingStatus; verify_code: string | null; customer_id: string }>(
      `SELECT status, verify_code, customer_id
         FROM bookings WHERE id = $1 AND salon_id = $2 FOR UPDATE`,
      [bookingId, salonId],
    );
    const row = res.rows[0];
    if (!row) throw new BookingNotFoundError();

    if (!canTransition(row.status, to)) throw new InvalidTransitionError(row.status, to);

    if (to === 'verified') {
      // trim: barbers type this off a customer's phone screen
      if (!opts.code || opts.code.trim() !== row.verify_code) throw new BadCodeError();
    }

    const sets: string[] = ['status = $3'];
    const params: unknown[] = [bookingId, salonId, to];
    const push = (frag: string, value: unknown) => {
      params.push(value);
      sets.push(`${frag} = $${params.length}`);
    };

    if (to === 'verified') push('code_verified_at', now);
    if (to === 'in_progress') push('actual_start', now);
    if (to === 'completed') push('actual_end', now);

    if (to === 'no_show' || to === 'cancelled_by_customer') {
      push('reschedule_deadline', new Date(now.getTime() + RESCHEDULE_WINDOW_HOURS * 3600_000));
    }

    if (to === 'cancelled_by_salon') {
      push('cancelled_at', now);
      // Spec §4: salon cancels -> full refund, auto. Razorpay is not wired
      // (build order steps 4-5), so this parks in 'pending' for the refund
      // worker rather than silently claiming the money went back.
      push('refund_status', 'pending');
    }

    await tx.query(`UPDATE bookings SET ${sets.join(', ')} WHERE id = $1 AND salon_id = $2`, params);

    // Spec §4: 3 no-shows in 60 days -> blocked from booking for 30 days.
    if (to === 'no_show') {
      await tx.query(
        `UPDATE users SET no_show_count = no_show_count + 1 WHERE id = $1`,
        [row.customer_id],
      );
      const recent = await tx.query<{ n: number }>(
        `SELECT COUNT(*)::int8 AS n FROM bookings
          WHERE customer_id = $1 AND status = 'no_show'
            AND start_at >= now() - interval '60 days'`,
        [row.customer_id],
      );
      if (Number(recent.rows[0]?.n ?? 0) >= 3) {
        await tx.query(
          `UPDATE users SET blocked_until = greatest(coalesce(blocked_until, now()), now() + interval '30 days')
            WHERE id = $1`,
          [row.customer_id],
        );
      }
    }

    return { id: bookingId, status: to, customerId: row.customer_id };
  });
}

/**
 * Spec §4: [Close for today] cancels + refunds every booking for that day.
 * One statement, so a partial close is impossible.
 */
export async function closeForDay(
  db: Pool,
  salonId: string,
  dayStart: Date,
  dayEnd: Date,
  now: Date = new Date(),
): Promise<{ cancelled: number; customerIds: string[] }> {
  const res = await db.query<{ id: string; customer_id: string }>(
    `UPDATE bookings
        SET status = 'cancelled_by_salon',
            cancelled_at = $4,
            refund_status = 'pending'
      WHERE salon_id = $1
        AND start_at >= $2 AND start_at < $3
        AND status IN ('booked','verified','in_progress')
      RETURNING id, customer_id`,
    [salonId, dayStart, dayEnd, now],
  );
  return {
    cancelled: res.rowCount ?? 0,
    customerIds: [...new Set(res.rows.map((r) => r.customer_id))],
  };
}
