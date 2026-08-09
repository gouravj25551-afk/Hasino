import type { Pool } from '../db/pool.ts';
import type { SnapshotCache } from '../availability/cache.ts';
import type { PaymentsConfig } from './razorpay.ts';
import { verifyWebhookSignature } from './razorpay.ts';
import { applyCapture, applyFailure } from './service.ts';

/**
 * Razorpay's webhook.
 *
 * This is the backstop, not the fast path. The browser's checkout callback
 * confirms most bookings in under a second; the webhook exists for the customer
 * who closed the tab on the UPI screen, the phone that lost signal on the
 * redirect back, and every case where the callback simply never runs. Without
 * it those customers are debited and have no booking.
 *
 * Three rules, all of them the difference between working and subtly broken:
 *
 * 1. Verify against the RAW bytes. Parsing and re-serialising the JSON changes
 *    key order and whitespace, and the HMAC stops matching.
 * 2. Verify BEFORE parsing. An unsigned body is attacker-controlled input and
 *    should get nowhere near the handler.
 * 3. Return 2xx for anything successfully recorded, including a duplicate.
 *    Razorpay retries on non-2xx for 24 hours; a handler that 500s on an event
 *    it has already processed turns one payment into a retry storm.
 */

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'failed';

export interface WebhookResult {
  outcome: WebhookOutcome;
  event: string;
  /** what the caller should return to Razorpay */
  status: number;
  detail?: string;
}

export class WebhookSignatureError extends Error {
  constructor() {
    super('Invalid webhook signature');
    this.name = 'WebhookSignatureError';
  }
}

interface RazorpayEvent {
  event: string;
  payload?: {
    payment?: { entity?: Record<string, unknown> };
    order?: { entity?: Record<string, unknown> };
    refund?: { entity?: Record<string, unknown> };
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export async function handleWebhook(
  db: Pool,
  cfg: PaymentsConfig,
  rawBody: Buffer,
  headers: { signature?: string | undefined; eventId?: string | undefined },
  opts: { now?: Date; cache?: SnapshotCache } = {},
): Promise<WebhookResult> {
  if (!verifyWebhookSignature(rawBody, headers.signature, cfg.webhookSecret)) {
    throw new WebhookSignatureError();
  }

  let event: RazorpayEvent;
  try {
    event = JSON.parse(rawBody.toString('utf8')) as RazorpayEvent;
  } catch {
    return { outcome: 'failed', event: 'unparseable', status: 400, detail: 'body is not JSON' };
  }

  // Razorpay sends x-razorpay-event-id and will re-send the same id on retry.
  // Falling back to a content hash keeps the table honest if that header ever
  // goes missing, rather than processing the same event twice.
  const eventId =
    headers.eventId ??
    `sha:${(await import('node:crypto')).createHash('sha256').update(rawBody).digest('hex')}`;

  const claim = await db.query(
    `INSERT INTO webhook_events (id, event, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [eventId, event.event ?? 'unknown', rawBody.toString('utf8')],
  );

  if (claim.rowCount === 0) {
    // Seen before. Whether it succeeded or is still being retried by our own
    // worker, telling Razorpay "got it" is correct — the record is durable.
    return { outcome: 'duplicate', event: event.event ?? 'unknown', status: 200 };
  }

  try {
    const detail = await dispatch(db, cfg, event, opts);
    await db.query(
      `UPDATE webhook_events
          SET status = $2, processed_at = now(), attempts = attempts + 1
        WHERE id = $1`,
      [eventId, detail === null ? 'ignored' : 'processed'],
    );
    return {
      outcome: detail === null ? 'ignored' : 'processed',
      event: event.event ?? 'unknown',
      status: 200,
      ...(detail ? { detail } : {}),
    };
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);
    await db.query(
      `UPDATE webhook_events SET status = 'failed', error = $2, attempts = attempts + 1 WHERE id = $1`,
      [eventId, message],
    );
    // 500 so Razorpay retries. The row is already durable, so the retry hits
    // the duplicate branch above — which is why the failed row is also picked
    // up by the reconciliation worker rather than left to Razorpay alone.
    return { outcome: 'failed', event: event.event ?? 'unknown', status: 500, detail: message };
  }
}

/** Returns a description, or null for an event we deliberately do not act on. */
async function dispatch(
  db: Pool,
  cfg: PaymentsConfig,
  event: RazorpayEvent,
  opts: { now?: Date; cache?: SnapshotCache },
): Promise<string | null> {
  const payment = event.payload?.payment?.entity;
  const refund = event.payload?.refund?.entity;

  switch (event.event) {
    // Both mean the same thing to us. Razorpay sends payment.captured always
    // and order.paid when the order is fully paid; handling both, idempotently,
    // means an account with either subscription configured works.
    case 'payment.captured':
    case 'order.paid': {
      const orderId = str(payment?.['order_id']);
      const paymentId = str(payment?.['id']);
      if (!orderId || !paymentId) return null;
      const result = await applyCapture(
        db,
        cfg,
        {
          orderId,
          paymentId,
          method: str(payment?.['method']),
          amount: num(payment?.['amount']),
        },
        opts,
      );
      return `${result.outcome} ${result.bookingId}`;
    }

    case 'payment.failed': {
      const orderId = str(payment?.['order_id']);
      if (!orderId) return null;
      await applyFailure(db, {
        orderId,
        paymentId: str(payment?.['id']),
        code: str(payment?.['error_code']),
        description: str(payment?.['error_description']),
      });
      return `failed ${orderId}`;
    }

    // The refund worker already marks a refund 'processed' when Razorpay
    // accepts it. These events are the bank confirming or rejecting afterwards,
    // which is the only signal that a refund we believe succeeded actually did.
    case 'refund.processed': {
      const refundId = str(refund?.['id']);
      if (!refundId) return null;
      await db.query(
        `UPDATE refunds SET status = 'processed', processed_at = coalesce(processed_at, now())
          WHERE rzp_refund_id = $1`,
        [refundId],
      );
      await db.query(
        `UPDATE bookings b SET refund_status = 'processed'
           FROM refunds r WHERE r.booking_id = b.id AND r.rzp_refund_id = $1`,
        [refundId],
      );
      return `refund ${refundId}`;
    }

    case 'refund.failed': {
      const refundId = str(refund?.['id']);
      if (!refundId) return null;
      // Back to 'pending' rather than 'failed': a bank rejection is usually
      // transient, and the worker's attempt cap is what eventually gives up.
      await db.query(
        `UPDATE refunds
            SET status = 'pending', last_error = 'refund.failed webhook',
                next_attempt_at = now() + interval '30 minutes'
          WHERE rzp_refund_id = $1`,
        [refundId],
      );
      await db.query(
        `UPDATE bookings b SET refund_status = 'pending'
           FROM refunds r WHERE r.booking_id = b.id AND r.rzp_refund_id = $1`,
        [refundId],
      );
      return `refund retry ${refundId}`;
    }

    default:
      // Recorded in webhook_events, acted on by nobody. Razorpay lets you
      // subscribe to 40-odd events and the list grows; unknown ones must be a
      // no-op rather than an error, or enabling one in their dashboard breaks
      // production.
      return null;
  }
}
