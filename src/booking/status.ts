import { randomInt } from 'node:crypto';

import type { Pool, PoolClient } from '../db/pool.ts';
import { withTransaction } from '../db/pool.ts';
import { cancelPending, enqueueNotification } from '../notify/outbox.ts';
import { queueRefundForBooking } from '../payments/service.ts';
import { BookingError } from './errors.ts';

export type BookingStatus =
  | 'pending_payment'
  | 'booked'
  | 'verified'
  | 'in_progress'
  | 'completed'
  | 'no_show'
  | 'rescheduled'
  | 'expired'
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
  // The hold. Confirmed by the checkout callback or the webhook, abandoned by
  // the customer, or collected by the sweeper. It cannot go straight to
  // 'verified' — a barber must not be able to check in an unpaid booking.
  pending_payment: ['booked', 'expired', 'cancelled_by_customer'],
  booked: ['verified', 'no_show', 'cancelled_by_customer', 'cancelled_by_salon', 'rescheduled'],
  verified: ['in_progress', 'no_show', 'cancelled_by_salon'],
  in_progress: ['completed', 'cancelled_by_salon'],
  completed: [],
  no_show: ['rescheduled'],
  rescheduled: [],
  // Terminal. A payment that lands after the sweep is refunded rather than
  // resurrected — the chair may already belong to someone else by then.
  expired: [],
  cancelled_by_customer: ['rescheduled'],
  cancelled_by_salon: [],
};

/**
 * Statuses a salon's panel may act on. The §6.3 action buttons all resolve
 * through here, so an unpaid hold is invisible to the barber's queue.
 */
export const SALON_ACTIONABLE: BookingStatus[] = ['booked', 'verified', 'in_progress'];

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

/**
 * Spec §4: 6 digits. Uniform over 000000-999999, no modulo bias.
 *
 * randomInt, not Math.random: this code is the only thing standing between a
 * booking and "service delivered", and it will gate settlement. Math.random is
 * seeded predictably enough that observing a few codes narrows the next ones —
 * cheap to get right, and not worth arguing about later.
 */
export function generateVerifyCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
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
      // Spec §4: salon cancels -> full refund, auto. The row is queued here and
      // the money is moved by the refund worker; calling Razorpay inside this
      // transaction would mean a timeout leaves the caller retrying a cancel
      // that already refunded.
      push('refund_status', 'pending');
    }

    await tx.query(`UPDATE bookings SET ${sets.join(', ')} WHERE id = $1 AND salon_id = $2`, params);

    if (to === 'cancelled_by_salon') {
      await queueRefundForBooking(tx, bookingId, 'cancelled by salon', now);
      await cancelPending(tx, bookingId, ['booking_reminder']);
      await notifyCancellation(tx, bookingId, 'booking_cancelled_by_salon', now);
    }

    if (to === 'cancelled_by_customer') {
      // §4: no refund. The customer gets 36 hours to move the booking instead,
      // which is what the email says.
      await cancelPending(tx, bookingId, ['booking_reminder']);
      await notifyCancellation(tx, bookingId, 'booking_cancelled_by_customer', now);
    }

    if (to === 'no_show' || to === 'completed') {
      await cancelPending(tx, bookingId, ['booking_reminder']);
    }

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
 * The customer-facing side of a cancellation. Best-effort by design: a booking
 * whose customer has no email on file enqueues a 'skipped' row rather than
 * failing the cancellation, because the cancellation itself is what the salon
 * pressed a button for.
 */
async function notifyCancellation(
  tx: Pool | PoolClient,
  bookingId: string,
  template: 'booking_cancelled_by_salon' | 'booking_cancelled_by_customer',
  now: Date,
): Promise<void> {
  const res = await tx.query<{
    customer_id: string;
    email: string | null;
    name: string | null;
    start_at: Date;
    amount: number;
    reschedule_deadline: Date | null;
    salon_name: string;
    timezone: string;
  }>(
    `SELECT b.customer_id, u.email, u.name, b.start_at, b.amount, b.reschedule_deadline,
            s.name AS salon_name, s.timezone
       FROM bookings b
       JOIN users u  ON u.id = b.customer_id
       JOIN salons s ON s.id = b.salon_id
      WHERE b.id = $1`,
    [bookingId],
  );
  const r = res.rows[0];
  if (!r) return;

  await enqueueNotification(tx, {
    userId: r.customer_id,
    bookingId,
    channel: 'email',
    template,
    to: r.email ?? '',
    payload: {
      salonName: r.salon_name,
      timezone: r.timezone,
      customerName: r.name,
      startAt: r.start_at.toISOString(),
      amount: r.amount,
      rescheduleDeadline: r.reschedule_deadline ? r.reschedule_deadline.toISOString() : null,
    },
    dedupeKey: `${template}:${bookingId}`,
    now,
  });
}

/**
 * Spec §4: [Close for today] cancels + refunds every booking for that day.
 *
 * The cancellation is one statement, so a partial close is impossible. The
 * refunds and emails that follow are per-booking and run in the same
 * transaction — a close that reports "12 cancelled" and refunds 9 of them would
 * be worse than one that fails and can be retried.
 */
export async function closeForDay(
  db: Pool,
  salonId: string,
  dayStart: Date,
  dayEnd: Date,
  now: Date = new Date(),
): Promise<{ cancelled: number; customerIds: string[]; refundsQueued: number }> {
  return withTransaction(db, async (tx) => {
    const res = await tx.query<{ id: string; customer_id: string }>(
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

    let refundsQueued = 0;
    for (const row of res.rows) {
      const outcome = await queueRefundForBooking(tx, row.id, 'salon closed for the day', now);
      if (outcome === 'queued') refundsQueued += 1;
      await cancelPending(tx, row.id, ['booking_reminder']);
      await notifyCancellation(tx, row.id, 'booking_cancelled_by_salon', now);
    }

    return {
      cancelled: res.rowCount ?? 0,
      customerIds: [...new Set(res.rows.map((r) => r.customer_id))],
      refundsQueued,
    };
  });
}

export async function customerCancelBooking(
  db: Pool,
  customerId: string,
  bookingId: string,
  now: Date = new Date(),
): Promise<{ id: string; status: BookingStatus; salonId: string }> {
  return withTransaction(db, async (tx) => {
    const res = await tx.query<{ salon_id: string; status: BookingStatus }>(
      `SELECT salon_id, status FROM bookings WHERE id = $1 AND customer_id = $2 FOR UPDATE`,
      [bookingId, customerId],
    );
    const row = res.rows[0];
    if (!row) throw new BookingNotFoundError();
    if (!canTransition(row.status, 'cancelled_by_customer')) {
      throw new InvalidTransitionError(row.status, 'cancelled_by_customer');
    }
    await tx.query(
      `UPDATE bookings
          SET status = 'cancelled_by_customer',
              cancelled_at = $3,
              reschedule_deadline = $4
        WHERE id = $1 AND customer_id = $2`,
      [bookingId, customerId, now, new Date(now.getTime() + RESCHEDULE_WINDOW_HOURS * 3600_000)],
    );

    // §4: customer cancels -> no refund, 36 hours to reschedule. No refund row
    // is queued, deliberately; the email explains the window instead.
    await cancelPending(tx, bookingId, ['booking_reminder']);
    await notifyCancellation(tx, bookingId, 'booking_cancelled_by_customer', now);

    return { id: bookingId, status: 'cancelled_by_customer', salonId: row.salon_id };
  });
}
