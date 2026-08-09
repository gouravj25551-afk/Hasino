import type { Pool } from '../db/pool.ts';
import { withTransaction } from '../db/pool.ts';
import type { CartItem } from '../types.ts';
import type { SnapshotCache } from '../availability/cache.ts';
import { enqueueNotification, cancelPending } from '../notify/outbox.ts';
import { BookingError } from './errors.ts';
import { createBookingTx, type CreatedBooking } from './create.ts';
import { BookingNotFoundError, type BookingStatus } from './status.ts';

/**
 * Spec §4: a no-show or a cancellation may be moved to a new slot within 36
 * hours, at no extra charge.
 *
 * The whole operation is one transaction. Retiring the old booking and taking
 * the new one separately has two failure modes and both are bad: the customer
 * ends up holding two chairs, or none. createBookingTx exists so this can
 * happen inside the same advisory lock that decides the new slot is free.
 *
 * §10 leaves four questions open here. What the code does, and why:
 *
 *   Q2 "reschedule more than once?"  — capped at one, the spec's own
 *      recommendation. reschedule_count carries forward down the chain so the
 *      cap cannot be walked around by rescheduling the reschedule.
 *
 *   Q3 "same salon?"  — yes, also the spec's recommendation. The money sits
 *      against this salon in the ledger; moving the booking elsewhere would
 *      mean a refund and a fresh sale, which is a different feature.
 *
 *   Q4 "who absorbs a price change?"  — nobody. The cart is carried forward
 *      frozen from booking_items, so the customer pays what they paid and the
 *      salon receives what it was owed. Charging the difference would mean a
 *      second payment flow on a slot the customer already holds; refunding it
 *      would mean a partial refund on a booking that is going ahead. Both cost
 *      more than the few rupees at stake.
 */

export class RescheduleWindowError extends BookingError {
  constructor(deadline: Date | null) {
    super(
      'RESCHEDULE_EXPIRED',
      deadline
        ? `The 36-hour reschedule window closed at ${deadline.toISOString()}`
        : 'This booking cannot be rescheduled',
    );
    this.name = 'RescheduleWindowError';
  }
}

export class RescheduleLimitError extends BookingError {
  constructor() {
    super('RESCHEDULE_LIMIT', 'A booking can only be moved once. Book a new slot instead.');
    this.name = 'RescheduleLimitError';
  }
}

export class NotReschedulableError extends BookingError {
  constructor(status: BookingStatus) {
    super('NOT_RESCHEDULABLE', `A ${status} booking cannot be moved`);
    this.name = 'NotReschedulableError';
  }
}

/** §4 lists no-show and cancellation. 'booked' is included so a customer can move a live booking. */
const RESCHEDULABLE: BookingStatus[] = ['booked', 'no_show', 'cancelled_by_customer', 'cancelled_by_salon'];

export const MAX_RESCHEDULES = 1;

export interface RescheduleResult {
  booking: CreatedBooking;
  previousBookingId: string;
  previousStartAt: Date;
}

export async function rescheduleBooking(
  db: Pool,
  input: { bookingId: string; customerId: string; startAt: Date },
  opts: { now?: Date; cache?: SnapshotCache } = {},
): Promise<RescheduleResult> {
  const now = opts.now ?? new Date();

  const result = await withTransaction(db, async (tx) => {
    const res = await tx.query<{
      id: string;
      salon_id: string;
      customer_id: string;
      status: BookingStatus;
      start_at: Date;
      amount: number;
      reschedule_deadline: Date | null;
      reschedule_count: number;
      rzp_order_id: string | null;
      rzp_payment_id: string | null;
    }>(
      `SELECT id, salon_id, customer_id, status, start_at, amount,
              reschedule_deadline, reschedule_count, rzp_order_id, rzp_payment_id
         FROM bookings
        WHERE id = $1 AND customer_id = $2
        FOR UPDATE`,
      [input.bookingId, input.customerId],
    );
    const old = res.rows[0];
    if (!old) throw new BookingNotFoundError();

    if (!RESCHEDULABLE.includes(old.status)) throw new NotReschedulableError(old.status);
    if (old.reschedule_count >= MAX_RESCHEDULES) throw new RescheduleLimitError();

    // A live booking has no deadline set — the deadline exists to bound the
    // window *after* something went wrong. Moving a booking that is still going
    // ahead is allowed right up until the 15-minute lead time, which
    // createBookingTx enforces on the new slot.
    if (old.status !== 'booked') {
      if (!old.reschedule_deadline || old.reschedule_deadline.getTime() < now.getTime()) {
        throw new RescheduleWindowError(old.reschedule_deadline);
      }
    }

    // The cart as it was when the money moved, not as the salon prices it now.
    const itemsRes = await tx.query<{
      service_id: string;
      name: string;
      price: number;
      duration_min: number;
      buffer_min: number;
    }>(
      `SELECT bi.service_id, s.name, bi.price, bi.duration_min,
              coalesce(ss.buffer_min, 10) AS buffer_min
         FROM booking_items bi
         JOIN services s ON s.id = bi.service_id
         LEFT JOIN salon_services ss
           ON ss.salon_id = $2 AND ss.service_id = bi.service_id
        WHERE bi.booking_id = $1`,
      [old.id, old.salon_id],
    );
    const cart: CartItem[] = itemsRes.rows.map((r) => ({
      serviceId: r.service_id,
      name: r.name,
      price: r.price,
      durationMin: r.duration_min,
      bufferMin: r.buffer_min,
    }));
    if (cart.length === 0) throw new BookingNotFoundError();

    // Retire the old row first. It has to stop consuming a chair before the new
    // one asks whether the chair is free — otherwise moving a booking by 30
    // minutes on a single-chair salon fails against itself.
    await tx.query(
      `UPDATE bookings SET status = 'rescheduled' WHERE id = $1`,
      [old.id],
    );

    const created = await createBookingTx(
      tx,
      {
        salonId: old.salon_id,
        customerId: old.customer_id,
        serviceIds: cart.map((c) => c.serviceId),
        startAt: input.startAt,
        cart,
        rescheduledFrom: old.id,
        rescheduleCount: old.reschedule_count + 1,
        rzpOrderId: old.rzp_order_id,
        rzpPaymentId: old.rzp_payment_id,
      },
      // holdTtlMs omitted: no payment step. That money already moved, and the
      // ledger entries stay attached to the original payment, so the salon's
      // balance does not change when a booking is moved.
      { now },
    );

    // A reminder for a slot that no longer exists would be sent otherwise.
    await cancelPending(tx, old.id, ['booking_reminder']);

    const ctx = await tx.query<{
      salon_name: string;
      timezone: string;
      customer_name: string | null;
      customer_email: string | null;
    }>(
      `SELECT s.name AS salon_name, s.timezone, u.name AS customer_name, u.email AS customer_email
         FROM salons s, users u WHERE s.id = $1 AND u.id = $2`,
      [old.salon_id, old.customer_id],
    );
    const c = ctx.rows[0];
    if (c) {
      const payload = {
        salonName: c.salon_name,
        timezone: c.timezone,
        customerName: c.customer_name,
        startAt: created.startAt.toISOString(),
        previousStartAt: old.start_at.toISOString(),
        amount: created.amount,
      };
      await enqueueNotification(tx, {
        userId: old.customer_id,
        bookingId: created.id,
        channel: 'email',
        template: 'booking_rescheduled',
        to: c.customer_email ?? '',
        payload,
        dedupeKey: `booking_rescheduled:${created.id}`,
      });
      const remindAt = new Date(created.startAt.getTime() - 2 * 3600_000);
      if (remindAt.getTime() > now.getTime() + 60_000) {
        await enqueueNotification(tx, {
          userId: old.customer_id,
          bookingId: created.id,
          channel: 'email',
          template: 'booking_reminder',
          to: c.customer_email ?? '',
          payload,
          dedupeKey: `booking_reminder:${created.id}`,
          sendAt: remindAt,
        });
      }
    }

    return { booking: created, previousBookingId: old.id, previousStartAt: old.start_at };
  });

  await opts.cache?.invalidate(result.booking.salonId);
  return result;
}
