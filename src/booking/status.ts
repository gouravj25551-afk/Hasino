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
  // No 'no_show' here, deliberately. 'verified' means the customer read their
  // code out at the counter: they are standing in the salon. Marking them
  // absent after that is not a state this app should be able to reach — it
  // costs the customer their money and a strike toward a 30-day block. A
  // customer who checked in and then left is a 'cancelled_by_salon', which
  // refunds them. The panel never offered the button here either; this closes
  // the API behind it.
  verified: ['in_progress', 'cancelled_by_salon'],
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

/**
 * The statuses in which a booking's code can still be typed in at a counter.
 *
 * Two live bookings at one salon must never share one — see
 * db/migrations/009_unique_verify_codes.sql. A finished booking keeps its code
 * as a record and is deliberately outside this set: history must not use up
 * six-digit numbers for a salon that has been open for years.
 */
export const CODE_LIVE_STATUSES = [
  'pending_payment',
  'booked',
  'verified',
  'in_progress',
] as const;

/**
 * A code no live booking at this salon is already using.
 *
 * Called inside createBookingTx, which holds the per-salon advisory lock, so
 * the check and the insert cannot be interleaved with another booking at the
 * same salon. The unique index is still there underneath: this makes a
 * collision impossible in practice, and the index makes it impossible in fact,
 * including for any future writer that skips this path.
 *
 * Ten attempts against a space of a million, with a few dozen live codes at a
 * busy salon, is far past the point where failure means something is wrong
 * rather than unlucky — so it throws instead of looping forever.
 */
export async function reserveVerifyCode(tx: PoolClient, salonId: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateVerifyCode();
    const taken = await tx.query(
      `SELECT 1 FROM bookings
        WHERE salon_id = $1 AND verify_code = $2
          AND status IN ('pending_payment','booked','verified','in_progress')
        LIMIT 1`,
      [salonId, code],
    );
    if (taken.rowCount === 0) return code;
  }
  throw new BookingError(
    'CODE_EXHAUSTED',
    'Could not allocate a verification code for this salon. This should not happen — please retry.',
  );
}

/** Spec §4: no_show / cancel -> reschedule allowed within 36 hours. */
export const RESCHEDULE_WINDOW_HOURS = 36;

/**
 * How long a customer is allowed to be late before the salon may write them
 * off.
 *
 * A no-show is the most expensive thing a salon can do to a customer: they
 * keep nothing of what they paid (§4 — no refund) and it counts toward the
 * three that block them from booking for 30 days. At the scheduled minute the
 * customer may be parking. Fifteen minutes is the grace period, and it is
 * measured from the scheduled *start*, not the end: a salon should not have to
 * hold a chair for an hour to find out nobody is coming.
 */
export const NO_SHOW_GRACE_MIN = 15;

/** The instant a booking becomes markable as a no-show. */
export function noShowAvailableAt(startAt: Date): Date {
  return new Date(startAt.getTime() + NO_SHOW_GRACE_MIN * 60_000);
}

/**
 * The grace period has not run out yet.
 *
 * `availableAt` rides on the error so a panel that tried anyway can say
 * "available after 10:15" using the server's answer rather than its own clock.
 */
export class NoShowTooEarlyError extends BookingError {
  readonly availableAt: Date;
  constructor(availableAt: Date) {
    super(
      'NO_SHOW_TOO_EARLY',
      `A customer has ${NO_SHOW_GRACE_MIN} minutes' grace. This booking can be marked a no-show from ${availableAt.toISOString()}.`,
    );
    this.name = 'NoShowTooEarlyError';
    this.availableAt = availableAt;
  }
}

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
    const res = await tx.query<{
      status: BookingStatus;
      verify_code: string | null;
      customer_id: string;
      start_at: Date;
    }>(
      `SELECT status, verify_code, customer_id, start_at
         FROM bookings WHERE id = $1 AND salon_id = $2 FOR UPDATE`,
      [bookingId, salonId],
    );
    const row = res.rows[0];
    if (!row) throw new BookingNotFoundError();

    if (!canTransition(row.status, to)) throw new InvalidTransitionError(row.status, to);

    // The grace period, enforced where the write happens rather than where the
    // button is drawn. The panel hides the button until the minute arrives, but
    // that is a courtesy to the barber, not a control: `curl` skips it, a
    // tampered clock on the shop's phone skips it, and an old cached panel
    // skips it. Both times here are the server's — start_at is a timestamptz
    // read inside this transaction, so a salon in any timezone is compared
    // against the same instant the customer was promised, and `now` is this
    // process's clock, never the caller's.
    //
    // FOR UPDATE above makes this hold under a double-tap: the second request
    // waits, then re-reads a status that is no longer 'booked' and is rejected
    // by canTransition — so the counter, the block check and the refund policy
    // below can never run twice for one booking.
    if (to === 'no_show') {
      const availableAt = noShowAvailableAt(row.start_at);
      if (now.getTime() < availableAt.getTime()) throw new NoShowTooEarlyError(availableAt);
    }

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
