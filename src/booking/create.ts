import type { Pool, PoolClient } from '../db/pool.ts';
import { withTransaction } from '../db/pool.ts';
import type { CartItem } from '../types.ts';
import { localDateKey, weekdayOf, zonedTimeToUtc } from '../time/tz.ts';
import { type DayGrid, buildDayGrid } from '../availability/grid.ts';
import { MIN_LEAD_MIN, type BufferPolicy, cartRequiredMin, slotsNeeded } from '../availability/engine.ts';
import { loadCart } from '../availability/repo.ts';
import type { SnapshotCache } from '../availability/cache.ts';
import {
  CustomerBlockedError,
  EmptyCartError,
  InvalidStartError,
  SalonUnavailableError,
  SlotUnavailableError,
} from './errors.ts';
import { reserveVerifyCode } from './status.ts';
import { chairConsumingSql } from './occupancy.ts';

export interface CreateBookingInput {
  salonId: string;
  customerId: string;
  serviceIds: string[];
  startAt: Date;
  rzpOrderId?: string | null;
  rzpPaymentId?: string | null;
  /** set by the reschedule flow — the booking this one replaces */
  rescheduledFrom?: string | null;
  /** carried forward from that booking, so the §10 cap of 1 survives the chain */
  rescheduleCount?: number;
  /**
   * Prices and durations frozen at the time the customer paid. Set by the
   * reschedule flow; when absent the cart is resolved from the salon's current
   * menu, which is what a new booking wants.
   */
  cart?: CartItem[];
}

export interface CreatedBooking {
  id: string;
  salonId: string;
  customerId: string;
  startAt: Date;
  endAt: Date;
  amount: number;
  slots: Date[];
  items: CartItem[];
  status: 'pending_payment' | 'booked';
  /** when the chair is released if payment never lands; null once paid */
  holdExpiresAt: Date | null;
}

export interface CreateBookingOptions {
  now?: Date;
  minLeadMin?: number;
  bufferPolicy?: BufferPolicy;
  /** invalidated on success, per spec §2 */
  cache?: SnapshotCache;
  /**
   * How long the chair is held while the customer pays. Omit — or pass 0 — to
   * create a settled 'booked' row directly, which is what the reschedule flow
   * does: that money already moved.
   */
  holdTtlMs?: number;
}

/**
 * Spec §5: "This is where the app breaks in production if done wrong."
 *
 * Everything that decides whether the booking is legal is re-read inside the
 * transaction, under a per-salon advisory lock. The slot list the customer saw
 * is treated as a hint, never as a fact — it may be 60 seconds stale from the
 * cache plus however long the payment sheet was open.
 */
export async function createBooking(
  db: Pool,
  input: CreateBookingInput,
  opts: CreateBookingOptions = {},
): Promise<CreatedBooking> {
  const booking = await withTransaction(db, (tx) => createBookingTx(tx, input, opts));
  await opts.cache?.invalidate(input.salonId);
  return booking;
}

/**
 * The same thing, on a caller's transaction.
 *
 * The reschedule flow needs to retire the old booking and take the new one
 * atomically: if the two were separate transactions, a failure between them
 * either leaves the customer holding two chairs or none. It must therefore be
 * able to reach inside this lock, which is why the body is exposed rather than
 * duplicated.
 *
 * Cache invalidation is the wrapper's job — it must happen after COMMIT, not
 * inside it, or a concurrent read repopulates the snapshot from a transaction
 * that has not landed yet.
 */
export async function createBookingTx(
  tx: PoolClient,
  input: CreateBookingInput,
  opts: CreateBookingOptions = {},
): Promise<CreatedBooking> {
  const now = opts.now ?? new Date();
  const minLead = opts.minLeadMin ?? MIN_LEAD_MIN;

  {
    // Serialise every write for this salon. Held until COMMIT/ROLLBACK, so
    // there is no path that releases it early.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.salonId]);

    const salon = await tx.query<{ timezone: string; status: string }>(
      `SELECT timezone, status FROM salons WHERE id = $1`,
      [input.salonId],
    );
    const salonRow = salon.rows[0];
    if (!salonRow) throw new SalonUnavailableError('No such salon');
    if (salonRow.status !== 'active') {
      throw new SalonUnavailableError(`Salon is ${salonRow.status}`);
    }
    const timezone = salonRow.timezone;

    const blocked = await tx.query<{ blocked_until: Date | null }>(
      `SELECT blocked_until FROM users WHERE id = $1`,
      [input.customerId],
    );
    const blockedUntil = blocked.rows[0]?.blocked_until;
    if (blockedUntil && blockedUntil.getTime() > now.getTime()) {
      throw new CustomerBlockedError(blockedUntil);
    }

    // A frozen cart comes from the booking being rescheduled: prices and
    // durations as they were when the customer paid, not as the salon lists
    // them today. It also skips the `active` check on purpose — a salon that
    // retired a service after taking money still owes the haircut.
    const cart = input.cart ?? (await loadCart(tx, input.salonId, input.serviceIds));
    if (cart.length === 0 || (!input.cart && cart.length !== new Set(input.serviceIds).size)) {
      throw new EmptyCartError();
    }

    const date = localDateKey(input.startAt, timezone);

    const holiday = await tx.query(
      `SELECT 1 FROM salon_holidays WHERE salon_id = $1 AND date = $2::date`,
      [input.salonId, date],
    );
    if (holiday.rowCount) throw new SalonUnavailableError('Salon is closed that day');

    const hoursRes = await tx.query<{
      open_at: string;
      close_at: string;
      break_start: string | null;
      break_end: string | null;
      online_capacity: number;
      slot_interval_min: number;
    }>(
      `SELECT open_at, close_at, break_start, break_end, online_capacity, slot_interval_min
         FROM salon_hours WHERE salon_id = $1 AND weekday = $2`,
      [input.salonId, weekdayOf(date)],
    );
    const h = hoursRes.rows[0];
    if (!h) throw new SalonUnavailableError('Salon does not work that day');
    if (h.online_capacity <= 0) throw new SalonUnavailableError('No online capacity that day');

    const grid = buildDayGrid(
      {
        weekday: weekdayOf(date),
        openAt: h.open_at,
        closeAt: h.close_at,
        breakStart: h.break_start,
        breakEnd: h.break_end,
        onlineCapacity: h.online_capacity,
        slotIntervalMin: h.slot_interval_min,
      },
      date,
      timezone,
    );

    const requiredMin = cartRequiredMin(cart, opts.bufferPolicy);
    const needed = slotsNeeded(requiredMin, grid.slotIntervalMin);

    if (input.startAt.getTime() < now.getTime() + minLead * 60_000) {
      throw new InvalidStartError(`Start time must be at least ${minLead} minutes from now`);
    }

    // Resolves the grid rules structurally: an off-grid start, a booking that
    // would cross the lunch break, and one that would run past closing all
    // come back null, because the slots are not in a single segment.
    const slots = slotsForStart(grid, input.startAt, needed);
    if (!slots) {
      throw new InvalidStartError('Booking does not fit from that start time');
    }

    // THE re-check. Shares one predicate with the availability query — see
    // booking/occupancy.ts for why that is not duplicated here.
    const occ = await tx.query<{ slot_start_at: Date; booked: number }>(
      `SELECT bs.slot_start_at, COUNT(*)::int8 AS booked
         FROM booking_slots bs
         JOIN bookings b ON b.id = bs.booking_id
        WHERE bs.salon_id = $1
          AND bs.slot_start_at = ANY($2::timestamptz[])
          AND ${chairConsumingSql('$3')}
        GROUP BY bs.slot_start_at`,
      [input.salonId, slots, now],
    );
    for (const row of occ.rows) {
      if (Number(row.booked) >= grid.capacity) throw new SlotUnavailableError();
    }

    const amount = cart.reduce((a, c) => a + c.price, 0);
    // end_at is the customer-facing service window (sum of durations). The
    // slot ledger may extend past it by the buffer — that is chair time, not
    // appointment time, and showing "4:00-5:10 PM" for a 60-minute cart would
    // be wrong on the booking card.
    const endAt = new Date(input.startAt.getTime() + cart.reduce((a, c) => a + c.durationMin, 0) * 60_000);

    // The hold. This row consumes a chair from the moment it is inserted —
    // inside the same advisory lock that just proved the chair was free — so
    // the customer who reaches checkout second is rejected *before* paying
    // rather than refunded after. hold_expires_at bounds the damage from a
    // customer who opens the sheet and walks away; sweep.ts collects them.
    //
    // holdTtlMs = 0 skips the hold and books outright. The reschedule flow uses
    // that: the money moved on the original booking.
    const holdTtlMs = opts.holdTtlMs ?? 0;
    const status = holdTtlMs > 0 ? 'pending_payment' : 'booked';
    const holdExpiresAt = holdTtlMs > 0 ? new Date(now.getTime() + holdTtlMs) : null;

    // Spec §4 has a job generate this 15 minutes before the slot. Generating
    // it at creation and only *revealing* it 15 minutes before is equivalent
    // for the customer and removes a scheduler from the critical path —
    // BullMQ (build order step 7) is not built. The reveal rule lives in the
    // read path, not here.
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO bookings (salon_id, customer_id, start_at, end_at, status,
                             amount, rzp_order_id, rzp_payment_id, verify_code,
                             hold_expires_at, rescheduled_from, reschedule_count)
       VALUES ($1, $2, $3, $4, $9, $5, $6, $7, $8, $10, $11, $12)
       RETURNING id`,
      [
        input.salonId,
        input.customerId,
        input.startAt,
        endAt,
        amount,
        input.rzpOrderId ?? null,
        input.rzpPaymentId ?? null,
        await reserveVerifyCode(tx, input.salonId),
        status,
        holdExpiresAt,
        input.rescheduledFrom ?? null,
        input.rescheduleCount ?? 0,
      ],
    );
    const bookingId = inserted.rows[0]!.id;

    await tx.query(
      `INSERT INTO booking_items (booking_id, service_id, price, duration_min)
       SELECT $1, x.service_id, x.price, x.duration_min
         FROM unnest($2::uuid[], $3::int[], $4::int[]) AS x(service_id, price, duration_min)`,
      [bookingId, cart.map((c) => c.serviceId), cart.map((c) => c.price), cart.map((c) => c.durationMin)],
    );

    await tx.query(
      `INSERT INTO booking_slots (salon_id, slot_start_at, booking_id)
       SELECT $1, s, $2 FROM unnest($3::timestamptz[]) AS s`,
      [input.salonId, bookingId, slots],
    );

    return {
      id: bookingId,
      salonId: input.salonId,
      customerId: input.customerId,
      startAt: input.startAt,
      endAt,
      amount,
      slots,
      items: cart,
      status,
      holdExpiresAt,
    } satisfies CreatedBooking;
  }
}

/**
 * The `needed` consecutive slots starting at `startAt`, or null if that start
 * is off-grid or the run would leave the segment (break / closing time).
 */
export function slotsForStart(grid: DayGrid, startAt: Date, needed: number): Date[] | null {
  const target = startAt.getTime();
  for (const segment of grid.segments) {
    const at = segment.map((m) => zonedTimeToUtc(grid.timezone, grid.date, m));
    const i = at.findIndex((d) => d.getTime() === target);
    if (i === -1) continue;
    if (i + needed > at.length) return null;
    return at.slice(i, i + needed);
  }
  return null;
}

