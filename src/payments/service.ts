import type { Pool, PoolClient } from '../db/pool.ts';
import { withTransaction } from '../db/pool.ts';
import type { SnapshotCache } from '../availability/cache.ts';
import { chairConsumingSql } from '../booking/occupancy.ts';
import { BookingError } from '../booking/errors.ts';
import { enqueueNotification } from '../notify/outbox.ts';
import type { PaymentsConfig, RazorpayClient } from './razorpay.ts';
import { RazorpayError, verifyCheckoutSignature } from './razorpay.ts';
import { HttpCashfreeClient } from './cashfree.ts';

type Queryable = Pool | PoolClient;

export class PaymentError extends BookingError {}

export class PaymentNotFoundError extends PaymentError {
  constructor() {
    super('PAYMENT_NOT_FOUND', 'No payment is open for that booking');
    this.name = 'PaymentNotFoundError';
  }
}

export class BadSignatureError extends PaymentError {
  constructor() {
    // Deliberately vague. This fires when someone posts a forged checkout
    // callback; telling them which half was wrong is free help.
    super('BAD_SIGNATURE', 'Payment could not be verified');
    this.name = 'BadSignatureError';
  }
}

export class AmountMismatchError extends PaymentError {
  constructor(expected: number, got: number) {
    super('AMOUNT_MISMATCH', `Expected ${expected} paise, Razorpay reported ${got}`);
    this.name = 'AmountMismatchError';
  }
}

export class PaymentsDisabledError extends PaymentError {
  constructor() {
    super('PAYMENTS_DISABLED', 'Payments are not configured on this server');
    this.name = 'PaymentsDisabledError';
  }
}

// ------------------------------------------------------------------- helpers

/**
 * The platform's cut, in paise.
 *
 * Floored, so a rounding half-paise always lands on the salon's side. Over
 * thousands of bookings this is a few rupees; the alternative is a salon
 * querying an invoice that is one paise light, which costs more in support
 * time than it saves.
 */
export function commissionPaise(amount: number, bps: number): number {
  return Math.floor((amount * bps) / 10_000);
}

async function salonCommissionBps(db: Queryable, salonId: string, fallback: number): Promise<number> {
  const res = await db.query<{ commission_bps: number }>(
    `SELECT commission_bps FROM salons WHERE id = $1`,
    [salonId],
  );
  return res.rows[0]?.commission_bps ?? fallback;
}

interface BookingContext {
  bookingId: string;
  salonId: string;
  customerId: string;
  startAt: Date;
  amount: number;
  timezone: string;
  salonName: string;
  salonAddress: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  ownerEmail: string | null;
  ownerId: string;
  services: string;
}

/** Everything the notification templates need, frozen at send time. */
async function bookingContext(db: Queryable, bookingId: string): Promise<BookingContext | null> {
  const res = await db.query<{
    booking_id: string;
    salon_id: string;
    customer_id: string;
    start_at: Date;
    amount: number;
    timezone: string;
    salon_name: string;
    salon_address: string;
    customer_name: string | null;
    customer_email: string | null;
    customer_phone: string | null;
    owner_email: string | null;
    owner_id: string;
    services: string | null;
  }>(
    `SELECT b.id AS booking_id, b.salon_id, b.customer_id, b.start_at, b.amount,
            s.timezone, s.name AS salon_name, s.address AS salon_address,
            c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            o.email AS owner_email, o.id AS owner_id,
            (SELECT string_agg(sv.name, ', ' ORDER BY sv.name)
               FROM booking_items bi JOIN services sv ON sv.id = bi.service_id
              WHERE bi.booking_id = b.id) AS services
       FROM bookings b
       JOIN salons s ON s.id = b.salon_id
       JOIN users  c ON c.id = b.customer_id
       JOIN users  o ON o.id = s.owner_id
      WHERE b.id = $1`,
    [bookingId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    bookingId: r.booking_id,
    salonId: r.salon_id,
    customerId: r.customer_id,
    startAt: r.start_at,
    amount: r.amount,
    timezone: r.timezone,
    salonName: r.salon_name,
    salonAddress: r.salon_address,
    customerName: r.customer_name,
    customerEmail: r.customer_email,
    customerPhone: r.customer_phone,
    ownerEmail: r.owner_email,
    ownerId: r.owner_id,
    services: r.services ?? '',
  };
}

// ------------------------------------------------------------------ checkout

export interface CheckoutSession {
  bookingId: string;
  orderId: string;
  amount: number;
  currency: string;
  /** which SDK the browser should open. */
  provider: 'none' | 'razorpay' | 'cashfree';
  /** Razorpay: the public key the browser needs — never the secret. Empty for Cashfree. */
  keyId: string;
  /** Cashfree: the per-order token the SDK opens checkout with. Not a secret. */
  paymentSessionId?: string;
  /** Cashfree: 'sandbox' or 'production', so the SDK opens the right environment. */
  mode?: 'sandbox' | 'production';
  /** when the chair stops being held, so the UI can count down */
  holdExpiresAt: string | null;
  // All three are hints Razorpay's checkout pre-fills; null simply leaves the
  // field for the customer to type. contact is nullable because a Google
  // sign-in supplies no phone number.
  prefill: { name: string | null; email: string | null; contact: string | null };
  salonName: string;
}

/**
 * Open a Razorpay order against a booking that is already holding its chair.
 *
 * Called immediately after createBooking, inside the same request. If this
 * throws, the hold expires on its own within minutes — no compensating write is
 * needed, which is the whole reason the hold has a TTL rather than a cleanup
 * handler.
 *
 * Re-entrant: a customer who reloads the checkout page gets the same order back
 * rather than a second one. Razorpay would reject the duplicate `receipt`
 * anyway; catching it here means the reload succeeds instead of 500ing.
 */
export async function openCheckout(
  db: Pool,
  cfg: PaymentsConfig,
  bookingId: string,
  customerId: string,
): Promise<CheckoutSession> {
  if (!cfg.enabled) throw new PaymentsDisabledError();

  const ctx = await bookingContext(db, bookingId);
  if (!ctx) throw new PaymentNotFoundError();
  if (ctx.customerId !== customerId) throw new PaymentNotFoundError();

  const hold = await db.query<{ status: string; hold_expires_at: Date | null }>(
    `SELECT status, hold_expires_at FROM bookings WHERE id = $1`,
    [bookingId],
  );
  const row = hold.rows[0];
  if (!row) throw new PaymentNotFoundError();
  if (row.status !== 'pending_payment') {
    throw new PaymentError('NOT_PAYABLE', `This booking is ${row.status}, not awaiting payment`);
  }

  const existing = await db.query<{ rzp_order_id: string; amount: number; currency: string }>(
    `SELECT rzp_order_id, amount, currency
       FROM payments WHERE booking_id = $1 AND status = 'created'
      ORDER BY created_at DESC LIMIT 1`,
    [bookingId],
  );

  let orderId: string;
  let amount: number;
  let currency: string;
  let paymentSessionId: string | undefined;

  const createOrderForBooking = () =>
    cfg.client.createOrder({
      amountPaise: ctx.amount,
      receipt: bookingId,
      notes: { booking_id: bookingId, salon_id: ctx.salonId, customer_id: ctx.customerId },
      customer: { id: ctx.customerId, name: ctx.customerName, email: ctx.customerEmail, phone: ctx.customerPhone },
      ...(row.hold_expires_at ? { expiryIso: row.hold_expires_at.toISOString() } : {}),
    });

  const found = existing.rows[0];
  if (found && cfg.provider !== 'cashfree') {
    // Razorpay reuse: re-creating would hit its duplicate-receipt rejection, so
    // the stored order is returned as-is; the browser needs only key + order id.
    orderId = found.rzp_order_id;
    amount = found.amount;
    currency = found.currency;
  } else if (found) {
    // Cashfree reload: the order already exists, but a payment_session_id is
    // single-use per attempt. Re-creating is idempotent (order id is the key),
    // so it returns the same order with a fresh session to open.
    const order = await createOrderForBooking();
    orderId = order.id;
    amount = found.amount;
    currency = found.currency;
    paymentSessionId = order.paymentSessionId;
  } else {
    const order = await createOrderForBooking();
    await db.query(
      `INSERT INTO payments (booking_id, salon_id, customer_id, rzp_order_id, amount, currency)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (rzp_order_id) DO NOTHING`,
      [bookingId, ctx.salonId, ctx.customerId, order.id, order.amount, order.currency],
    );
    await db.query(`UPDATE bookings SET rzp_order_id = $2 WHERE id = $1`, [bookingId, order.id]);
    orderId = order.id;
    amount = order.amount;
    currency = order.currency;
    paymentSessionId = order.paymentSessionId;
  }

  return {
    bookingId,
    orderId,
    amount,
    currency,
    provider: cfg.provider,
    // The app id is server-side only; Cashfree's browser SDK opens with the
    // payment_session_id, so keyId is deliberately blank on that path.
    keyId: cfg.provider === 'cashfree' ? '' : cfg.keyId,
    ...(paymentSessionId ? { paymentSessionId } : {}),
    ...(cfg.cashfreeMode ? { mode: cfg.cashfreeMode } : {}),
    holdExpiresAt: row.hold_expires_at ? row.hold_expires_at.toISOString() : null,
    prefill: { name: ctx.customerName, email: ctx.customerEmail, contact: ctx.customerPhone },
    salonName: ctx.salonName,
  };
}

// ------------------------------------------------------------------- capture

export type CaptureOutcome =
  /** hold was still good; the booking is now confirmed */
  | 'confirmed'
  /** a previous call already did this — the webhook and the callback raced */
  | 'already_confirmed'
  /** money arrived after the chair was gone; a refund is queued */
  | 'refunding';

export interface CaptureResult {
  outcome: CaptureOutcome;
  bookingId: string;
  salonId: string;
  status: string;
}

export interface CaptureInput {
  orderId: string;
  paymentId: string;
  method?: string | null;
  /** paise, as Razorpay reports it — checked against what we asked for */
  amount?: number;
}

/**
 * Turn a captured payment into a confirmed booking. Idempotent.
 *
 * This is the single place a payment becomes a booking, called from two
 * racing sources: the browser's checkout callback and Razorpay's webhook.
 * Whichever arrives first does the work; the second gets 'already_confirmed'.
 * Both are needed — the callback is fast but a customer can close the tab, the
 * webhook is reliable but can be minutes late.
 *
 * The interesting case is a payment that lands after the hold expired. The
 * chair is re-checked under the salon advisory lock: if it is still free the
 * booking is honoured (the customer paid, and nobody else wanted it), and if it
 * is not, the booking goes terminal and the money is queued for refund. That is
 * the one case where a refund is unavoidable, and it now requires the customer
 * to have been slower than the TTL *and* someone else to have taken the chair
 * in that window — instead of happening on every contested slot.
 */
export async function applyCapture(
  db: Pool,
  cfg: PaymentsConfig,
  input: CaptureInput,
  opts: { now?: Date; cache?: SnapshotCache } = {},
): Promise<CaptureResult> {
  const now = opts.now ?? new Date();

  const result = await withTransaction(db, async (tx) => {
    const paymentRes = await tx.query<{
      id: string;
      booking_id: string;
      salon_id: string;
      customer_id: string;
      amount: number;
      status: string;
    }>(
      `SELECT id, booking_id, salon_id, customer_id, amount, status
         FROM payments WHERE rzp_order_id = $1 FOR UPDATE`,
      [input.orderId],
    );
    const payment = paymentRes.rows[0];
    if (!payment) throw new PaymentNotFoundError();

    if (input.amount !== undefined && input.amount !== payment.amount) {
      // Razorpay says a different number than the order we created. Never
      // reconcile this automatically — it is either a partial capture or
      // tampering, and both need a human.
      throw new AmountMismatchError(payment.amount, input.amount);
    }

    // Serialise against createBooking for this salon, so the "is the chair
    // still free" question below cannot be answered while someone else is
    // taking it.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [payment.salon_id]);

    const bookingRes = await tx.query<{
      status: string;
      hold_expires_at: Date | null;
    }>(`SELECT status, hold_expires_at FROM bookings WHERE id = $1 FOR UPDATE`, [payment.booking_id]);
    const booking = bookingRes.rows[0];
    if (!booking) throw new PaymentNotFoundError();

    const alreadyCaptured = payment.status === 'captured';

    if (!alreadyCaptured) {
      await tx.query(
        `UPDATE payments
            SET status = 'captured', rzp_payment_id = $2, method = coalesce($3, method),
                captured_at = coalesce(captured_at, $4), updated_at = $4,
                error_code = NULL, error_description = NULL
          WHERE id = $1`,
        [payment.id, input.paymentId, input.method ?? null, now],
      );
    }

    // Already a real booking — the other racer won. Fall through to the ledger
    // write, which is idempotent, so a webhook arriving after the callback
    // still cannot double-credit.
    if (booking.status === 'booked' || booking.status === 'verified' ||
        booking.status === 'in_progress' || booking.status === 'completed') {
      await writeSaleLedger(tx, cfg, payment, now);
      return {
        outcome: alreadyCaptured ? ('already_confirmed' as const) : ('confirmed' as const),
        bookingId: payment.booking_id,
        salonId: payment.salon_id,
        status: booking.status,
        notify: !alreadyCaptured,
      };
    }

    if (booking.status !== 'pending_payment' && booking.status !== 'expired') {
      // cancelled_by_customer, cancelled_by_salon, rescheduled. The customer
      // paid for something that no longer exists.
      await queueRefund(tx, payment, `booking is ${booking.status}`, now);
      return {
        outcome: 'refunding' as const,
        bookingId: payment.booking_id,
        salonId: payment.salon_id,
        status: booking.status,
        notify: false,
      };
    }

    const holdValid =
      booking.status === 'pending_payment' &&
      booking.hold_expires_at !== null &&
      booking.hold_expires_at.getTime() > now.getTime();

    // Late money. Honour it only if nobody else took the chair meanwhile.
    if (!holdValid) {
      const free = await chairStillFree(tx, payment.salon_id, payment.booking_id, now);
      if (!free) {
        await tx.query(
          `UPDATE bookings SET status = 'expired' WHERE id = $1 AND status = 'pending_payment'`,
          [payment.booking_id],
        );
        await queueRefund(tx, payment, 'payment arrived after the slot was taken', now);
        return {
          outcome: 'refunding' as const,
          bookingId: payment.booking_id,
          salonId: payment.salon_id,
          status: 'expired',
          notify: false,
        };
      }
    }

    await tx.query(
      `UPDATE bookings
          SET status = 'booked', hold_expires_at = NULL,
              rzp_order_id = $2, rzp_payment_id = $3
        WHERE id = $1`,
      [payment.booking_id, input.orderId, input.paymentId],
    );

    await writeSaleLedger(tx, cfg, payment, now);
    await queueBookingNotifications(tx, payment.booking_id, now);

    return {
      outcome: 'confirmed' as const,
      bookingId: payment.booking_id,
      salonId: payment.salon_id,
      status: 'booked',
      notify: true,
    };
  });

  // The chair moved from held to sold, or from held to free. Either way the
  // cached snapshot's occupancy is now describing the wrong thing.
  await opts.cache?.invalidate(result.salonId);

  return {
    outcome: result.outcome,
    bookingId: result.bookingId,
    salonId: result.salonId,
    status: result.status,
  };
}

/**
 * Is there still room for this booking's slots, ignoring the booking itself?
 *
 * Only asked when a hold has lapsed. Runs under the same advisory lock
 * createBooking uses, and against the same occupancy predicate, so the answer
 * cannot disagree with what a concurrent booking is about to do.
 */
async function chairStillFree(
  tx: PoolClient,
  salonId: string,
  bookingId: string,
  now: Date,
): Promise<boolean> {
  const cap = await tx.query<{ online_capacity: number }>(
    `SELECT sh.online_capacity
       FROM bookings b
       JOIN salons s ON s.id = b.salon_id
       JOIN salon_hours sh
         ON sh.salon_id = b.salon_id
        AND sh.weekday = EXTRACT(DOW FROM (b.start_at AT TIME ZONE s.timezone))::int
      WHERE b.id = $1`,
    [bookingId],
  );
  const capacity = cap.rows[0]?.online_capacity;
  // The salon stopped working that weekday while the customer was paying.
  if (capacity === undefined || capacity <= 0) return false;

  const occ = await tx.query<{ booked: number }>(
    `SELECT COUNT(*)::int8 AS booked
       FROM booking_slots bs
       JOIN bookings b ON b.id = bs.booking_id
      WHERE bs.salon_id = $1
        AND bs.booking_id <> $2
        AND bs.slot_start_at IN (SELECT slot_start_at FROM booking_slots WHERE booking_id = $2)
        AND ${chairConsumingSql('$3')}
      GROUP BY bs.slot_start_at
      ORDER BY booked DESC
      LIMIT 1`,
    [salonId, bookingId, now],
  );
  const busiest = Number(occ.rows[0]?.booked ?? 0);
  return busiest < capacity;
}

/**
 * The sale, as two signed entries.
 *
 * `sale` is the gross the customer paid; `commission` is what Hasino keeps.
 * The salon's balance is the sum, so there is no separate "net" number that can
 * disagree with its own inputs. Both writes are ON CONFLICT DO NOTHING against
 * the partial unique index on (payment_id, kind) — a webhook Razorpay delivers
 * twice therefore credits the salon exactly once.
 */
async function writeSaleLedger(
  tx: PoolClient,
  cfg: PaymentsConfig,
  payment: { id: string; booking_id: string; salon_id: string; amount: number },
  now: Date,
): Promise<void> {
  const bps = await salonCommissionBps(tx, payment.salon_id, cfg.commissionBps);
  const cut = commissionPaise(payment.amount, bps);

  await tx.query(
    `INSERT INTO ledger_entries (salon_id, booking_id, payment_id, kind, amount, note, occurred_at)
     VALUES ($1, $2, $3, 'sale', $4, $5, $6),
            ($1, $2, $3, 'commission', $7, $8, $6)
     ON CONFLICT (payment_id, kind) WHERE payment_id IS NOT NULL DO NOTHING`,
    [
      payment.salon_id,
      payment.booking_id,
      payment.id,
      payment.amount,
      'booking paid',
      now,
      -cut,
      `platform commission @ ${bps}bps`,
    ],
  );
}

async function queueBookingNotifications(
  tx: PoolClient,
  bookingId: string,
  now: Date,
): Promise<void> {
  const ctx = await bookingContext(tx, bookingId);
  if (!ctx) return;

  const payload = {
    salonName: ctx.salonName,
    salonAddress: ctx.salonAddress,
    customerName: ctx.customerName,
    customerPhone: ctx.customerPhone,
    // The salon's fallback way to reach a customer who has no number on file,
    // which is every account created by Google sign-in.
    customerEmail: ctx.customerEmail,
    startAt: ctx.startAt.toISOString(),
    timezone: ctx.timezone,
    amount: ctx.amount,
    services: ctx.services,
  };

  await enqueueNotification(tx, {
    userId: ctx.customerId,
    bookingId,
    channel: 'email',
    template: 'booking_confirmed',
    to: ctx.customerEmail ?? '',
    payload,
    dedupeKey: `booking_confirmed:${bookingId}`,
    now,
  });

  await enqueueNotification(tx, {
    userId: ctx.ownerId,
    bookingId,
    channel: 'email',
    template: 'salon_new_booking',
    to: ctx.ownerEmail ?? '',
    payload,
    dedupeKey: `salon_new_booking:${bookingId}`,
    now,
  });

  // Two hours out. A reminder that would fire in the past — someone booking a
  // slot 30 minutes from now — is pointless, so it is never queued rather than
  // queued and immediately sent.
  const remindAt = new Date(ctx.startAt.getTime() - 2 * 3600_000);
  if (remindAt.getTime() > now.getTime() + 60_000) {
    await enqueueNotification(tx, {
      userId: ctx.customerId,
      bookingId,
      channel: 'email',
      template: 'booking_reminder',
      to: ctx.customerEmail ?? '',
      payload,
      dedupeKey: `booking_reminder:${bookingId}`,
      sendAt: remindAt,
    });
  }
}

// ------------------------------------------------------------------- failure

/** payment.failed from the webhook, or a checkout the customer abandoned. */
export async function applyFailure(
  db: Pool,
  input: { orderId: string; paymentId?: string | null; code?: string | null; description?: string | null },
): Promise<void> {
  // The booking is deliberately left alone. Its hold expires on its own, and a
  // customer who failed on UPI and retries with a card inside the same hold
  // should not have to start over.
  await db.query(
    `UPDATE payments
        SET status = CASE WHEN status = 'captured' THEN status ELSE 'failed' END,
            rzp_payment_id = coalesce(rzp_payment_id, $2),
            error_code = $3, error_description = $4, updated_at = now()
      WHERE rzp_order_id = $1`,
    [input.orderId, input.paymentId ?? null, input.code ?? null, input.description ?? null],
  );
}

// ------------------------------------------------------------------- confirm

/**
 * The browser's success callback.
 *
 * The signature is checked before anything else and before any database write,
 * because without it this endpoint is "type a payment id, get a free booking".
 * A valid signature proves Razorpay produced this (order_id, payment_id) pair;
 * the capture path then proves, independently, that the money is real.
 */
export async function confirmCheckout(
  db: Pool,
  cfg: PaymentsConfig,
  input: { bookingId: string; customerId: string; orderId: string; paymentId: string; signature: string },
  opts: { now?: Date; cache?: SnapshotCache } = {},
): Promise<CaptureResult> {
  if (!cfg.enabled) throw new PaymentsDisabledError();

  // Cashfree has no browser-signed callback: the client just tells us which
  // order to check, and we ask Cashfree what really happened.
  if (cfg.provider === 'cashfree') return confirmCashfree(db, cfg, input, opts);

  if (!verifyCheckoutSignature(input, cfg.keySecret)) throw new BadSignatureError();

  const owns = await db.query<{ id: string }>(
    `SELECT p.id FROM payments p
      WHERE p.rzp_order_id = $1 AND p.booking_id = $2 AND p.customer_id = $3`,
    [input.orderId, input.bookingId, input.customerId],
  );
  if (owns.rowCount === 0) throw new PaymentNotFoundError();

  // Ask Razorpay what actually happened rather than trusting the callback's
  // account of it. The signature proves provenance, not that the payment was
  // captured for the right amount — a valid signature is issued for an
  // authorized-but-uncaptured payment too.
  let method: string | null = null;
  let amount: number | undefined;
  try {
    const payment = await cfg.client.fetchPayment(input.paymentId);
    method = payment.method;
    amount = payment.amount;
    if (payment.status !== 'captured' && payment.status !== 'refunded') {
      throw new PaymentError('NOT_CAPTURED', `Razorpay reports this payment as ${payment.status}`);
    }
  } catch (err) {
    if (err instanceof PaymentError) throw err;
    if (err instanceof RazorpayError && !err.retryable) {
      throw new PaymentError('RAZORPAY_REJECTED', err.message);
    }
    // Razorpay is unreachable. Do not guess — the webhook is the backstop and
    // will confirm this booking within its own retry window.
    throw new PaymentError(
      'VERIFY_UNAVAILABLE',
      'Could not reach Razorpay to verify. Your booking will confirm shortly.',
    );
  }

  return applyCapture(db, cfg, { orderId: input.orderId, paymentId: input.paymentId, method, amount }, opts);
}

/**
 * Confirm a Cashfree booking by verifying the ORDER server-side.
 *
 * The browser is not trusted at all here — it only names the order. We ask
 * Cashfree whether that order is PAID and pull the settling payment out of it.
 * SUCCESS captures (idempotent, shared with the webhook); a dropped/declined
 * payment is recorded and surfaced; a still-processing one is left for the
 * webhook to finish so the customer is never told "failed" prematurely.
 */
async function confirmCashfree(
  db: Pool,
  cfg: PaymentsConfig,
  input: { bookingId: string; customerId: string; orderId: string },
  opts: { now?: Date; cache?: SnapshotCache },
): Promise<CaptureResult> {
  const owns = await db.query<{ id: string }>(
    `SELECT p.id FROM payments p
      WHERE p.rzp_order_id = $1 AND p.booking_id = $2 AND p.customer_id = $3`,
    [input.orderId, input.bookingId, input.customerId],
  );
  if (owns.rowCount === 0) throw new PaymentNotFoundError();

  const client = cfg.client;
  if (!(client instanceof HttpCashfreeClient)) {
    throw new PaymentError('PROVIDER_MISMATCH', 'Cashfree confirm reached a non-Cashfree client');
  }

  let verification;
  try {
    verification = await client.verifyOrder(input.orderId);
  } catch (err) {
    if (err instanceof RazorpayError && !err.retryable) {
      throw new PaymentError('CASHFREE_REJECTED', err.message);
    }
    throw new PaymentError(
      'VERIFY_UNAVAILABLE',
      'Could not reach Cashfree to verify. Your booking will confirm shortly.',
    );
  }

  if (verification.outcome === 'failed') {
    await applyFailure(db, {
      orderId: input.orderId,
      paymentId: verification.paymentId,
      code: 'CASHFREE_FAILED',
      description: 'Payment failed or was dropped',
    });
    throw new PaymentError('PAYMENT_FAILED', 'Your payment did not go through. Please try again.');
  }
  if (verification.outcome === 'pending' || verification.outcome === 'unknown') {
    throw new PaymentError(
      'PAYMENT_PENDING',
      'Your payment is still processing. Your booking will confirm shortly.',
    );
  }

  return applyCapture(
    db,
    cfg,
    {
      orderId: input.orderId,
      paymentId: verification.paymentId ?? input.orderId,
      method: verification.method,
      amount: verification.amountPaise,
    },
    opts,
  );
}

// ------------------------------------------------------------------- refunds

/**
 * Queue a refund. Never calls Razorpay — that is the worker's job.
 *
 * Doing the refund inline would mean an HTTP call to Razorpay inside the
 * transaction that cancels the booking: if it times out, the caller sees a
 * failure and retries, and the customer is refunded twice. A row plus a worker
 * makes the retry safe by construction.
 */
export async function queueRefund(
  tx: Queryable,
  payment: { id: string; booking_id: string; amount: number },
  reason: string,
  now: Date,
  amount = payment.amount,
): Promise<void> {
  await tx.query(
    `INSERT INTO refunds (payment_id, booking_id, amount, reason, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (booking_id) WHERE status <> 'failed' DO NOTHING`,
    [payment.id, payment.booking_id, amount, reason, now],
  );
  await tx.query(
    `UPDATE bookings SET refund_status = 'pending' WHERE id = $1 AND refund_status = 'none'`,
    [payment.booking_id],
  );
}

/**
 * Queue a refund for a booking, looking up its captured payment.
 *
 * Used by the §4 paths — [Close for today], salon cancellation — which know a
 * booking id and nothing about payments. A booking with no captured payment
 * (created before Razorpay was wired, or a reschedule carrying its parent's
 * money) resolves to 'none' rather than sitting in 'pending' forever waiting
 * for a refund that has nothing to refund.
 */
export async function queueRefundForBooking(
  db: Queryable,
  bookingId: string,
  reason: string,
  now: Date = new Date(),
): Promise<'queued' | 'nothing_to_refund' | 'already_queued'> {
  const res = await db.query<{ id: string; booking_id: string; amount: number; refunded_amount: number }>(
    `SELECT id, booking_id, amount, refunded_amount
       FROM payments
      WHERE booking_id = $1 AND status IN ('captured','partially_refunded')
      ORDER BY captured_at DESC LIMIT 1`,
    [bookingId],
  );
  const payment = res.rows[0];
  if (!payment) {
    await db.query(
      `UPDATE bookings SET refund_status = 'none' WHERE id = $1 AND refund_status = 'pending'`,
      [bookingId],
    );
    return 'nothing_to_refund';
  }

  const outstanding = payment.amount - payment.refunded_amount;
  if (outstanding <= 0) return 'already_queued';

  const before = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int8 AS n FROM refunds WHERE booking_id = $1 AND status <> 'failed'`,
    [bookingId],
  );
  await queueRefund(db, payment, reason, now, outstanding);
  return Number(before.rows[0]?.n ?? 0) > 0 ? 'already_queued' : 'queued';
}

export interface RefundRunResult {
  processed: number;
  failed: number;
  retrying: number;
}

/**
 * Drain the refund queue.
 *
 * Claim, call Razorpay, record. The claim commits first, so a crash mid-call
 * leaves the row in 'processing' with its attempt counted — and the client's
 * duplicate check (notes.hasino_refund_id) makes the retry safe even if the
 * call that "failed" had actually gone through.
 */
export async function processDueRefunds(
  db: Pool,
  client: RazorpayClient,
  opts: { now?: Date; limit?: number; maxAttempts?: number } = {},
): Promise<RefundRunResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 25;
  const maxAttempts = opts.maxAttempts ?? 6;

  const claimed = await db.query<{
    id: string;
    payment_id: string;
    booking_id: string;
    amount: number;
    reason: string;
    attempts: number;
    rzp_payment_id: string | null;
    rzp_order_id: string | null;
    salon_id: string;
  }>(
    `UPDATE refunds r
        SET status = 'processing', attempts = r.attempts + 1,
            next_attempt_at = $1::timestamptz + interval '10 minutes'
      FROM payments p
      WHERE r.payment_id = p.id
        AND r.id IN (
          SELECT id FROM refunds
           WHERE status IN ('pending','processing') AND next_attempt_at <= $1
           ORDER BY next_attempt_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
      RETURNING r.id, r.payment_id, r.booking_id, r.amount, r.reason, r.attempts,
                p.rzp_payment_id, p.rzp_order_id, p.salon_id`,
    [now, limit],
  );

  let processed = 0;
  let failed = 0;
  let retrying = 0;

  for (const row of claimed.rows) {
    if (!row.rzp_payment_id) {
      await db.query(
        `UPDATE refunds SET status = 'failed', last_error = $2 WHERE id = $1`,
        [row.id, 'payment has no Razorpay payment id'],
      );
      await db.query(`UPDATE bookings SET refund_status = 'failed' WHERE id = $1`, [row.booking_id]);
      failed += 1;
      continue;
    }

    try {
      const refund = await client.createRefund({
        paymentId: row.rzp_payment_id,
        amountPaise: row.amount,
        refundId: row.id,
        reason: row.reason,
        // Cashfree refunds are keyed by order; Razorpay ignores this.
        ...(row.rzp_order_id ? { orderId: row.rzp_order_id } : {}),
      });

      // Razorpay's 'pending' means it accepted the refund but the bank has not
      // finished. That is a success for us — the money is committed and the
      // refund.processed webhook closes the loop. Re-calling would duplicate it.
      await withTransaction(db, async (tx) => {
        await tx.query(
          `UPDATE refunds
              SET status = 'processed', rzp_refund_id = $2, processed_at = $3, last_error = NULL
            WHERE id = $1`,
          [row.id, refund.id, now],
        );
        await tx.query(
          `UPDATE payments
              SET refunded_amount = least(amount, refunded_amount + $2),
                  status = CASE WHEN refunded_amount + $2 >= amount
                                THEN 'refunded' ELSE 'partially_refunded' END,
                  updated_at = $3
            WHERE id = $1`,
          [row.payment_id, row.amount, now],
        );
        await tx.query(
          `UPDATE bookings SET refund_status = 'processed' WHERE id = $1`,
          [row.booking_id],
        );
        await writeRefundLedger(tx, row.salon_id, row.booking_id, row.payment_id, row.id, row.amount, now);
        await queueRefundNotification(tx, row.booking_id, row.amount, now);
      });
      processed += 1;
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      const permanent = err instanceof RazorpayError && !err.retryable;
      if (permanent || row.attempts >= maxAttempts) {
        // Give up automatically, but loudly: refund_status='failed' is what the
        // ops dashboard queries. A customer owed money must never end up in a
        // silent terminal state.
        await db.query(`UPDATE refunds SET status = 'failed', last_error = $2 WHERE id = $1`, [
          row.id,
          message,
        ]);
        await db.query(`UPDATE bookings SET refund_status = 'failed' WHERE id = $1`, [row.booking_id]);
        failed += 1;
      } else {
        await db.query(
          `UPDATE refunds SET status = 'pending', last_error = $2, next_attempt_at = $3 WHERE id = $1`,
          [row.id, message, new Date(now.getTime() + Math.min(row.attempts ** 2 * 60_000, 6 * 3600_000))],
        );
        retrying += 1;
      }
    }
  }

  return { processed, failed, retrying };
}

/**
 * The refund, and the commission that comes back with it.
 *
 * The reversal is derived from the commission entry that was actually written
 * for this payment, scaled by how much of it is being refunded — not
 * recomputed from the salon's current rate. A salon whose commission changed
 * between the sale and the refund must not have the difference silently
 * pocketed or paid out.
 */
async function writeRefundLedger(
  tx: PoolClient,
  salonId: string,
  bookingId: string,
  paymentId: string,
  refundId: string,
  amount: number,
  now: Date,
): Promise<void> {
  const orig = await tx.query<{ sale: number; commission: number }>(
    `SELECT
       coalesce(max(amount) FILTER (WHERE kind = 'sale'), 0)::int       AS sale,
       coalesce(min(amount) FILTER (WHERE kind = 'commission'), 0)::int AS commission
     FROM ledger_entries WHERE payment_id = $1`,
    [paymentId],
  );
  const sale = orig.rows[0]?.sale ?? 0;
  const commission = orig.rows[0]?.commission ?? 0; // negative
  const reversal = sale > 0 ? Math.round((-commission * amount) / sale) : 0;

  await tx.query(
    `INSERT INTO ledger_entries (salon_id, booking_id, payment_id, refund_id, kind, amount, note, occurred_at)
     VALUES ($1, $2, $3, $4, 'refund', $5, 'refund to customer', $7),
            ($1, $2, $3, $4, 'commission_reversal', $6, 'commission returned with refund', $7)
     ON CONFLICT (refund_id, kind) WHERE refund_id IS NOT NULL DO NOTHING`,
    [salonId, bookingId, paymentId, refundId, -amount, reversal, now],
  );
}

async function queueRefundNotification(
  tx: PoolClient,
  bookingId: string,
  amount: number,
  now: Date,
): Promise<void> {
  const ctx = await bookingContext(tx, bookingId);
  if (!ctx) return;
  await enqueueNotification(tx, {
    userId: ctx.customerId,
    bookingId,
    channel: 'email',
    template: 'refund_processed',
    to: ctx.customerEmail ?? '',
    payload: {
      salonName: ctx.salonName,
      customerName: ctx.customerName,
      startAt: ctx.startAt.toISOString(),
      timezone: ctx.timezone,
      amount,
    },
    dedupeKey: `refund_processed:${bookingId}`,
    now,
  });
}
