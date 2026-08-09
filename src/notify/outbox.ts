import type { Pool, PoolClient } from '../db/pool.ts';

type Queryable = Pool | PoolClient;

/**
 * Transactional outbox.
 *
 * A notification is written in the same transaction as the thing it describes.
 * The alternative — send the email after COMMIT — has two failure modes that
 * both show up in support tickets: the process dies between the commit and the
 * send (booking exists, customer never told), or the send succeeds and the
 * transaction then rolls back (customer told about a booking that does not
 * exist). Neither is possible if the queue row is part of the same commit.
 *
 * The cost is a worker to drain it. dispatch.ts is that worker.
 */

export type NotificationChannel = 'email' | 'sms' | 'whatsapp' | 'push';

export interface EnqueueInput {
  userId: string | null;
  bookingId?: string | null;
  channel: NotificationChannel;
  /** template name — see notify/templates.ts */
  template: string;
  /** email address / phone number, resolved by the caller */
  to: string;
  payload?: Record<string, unknown>;
  /**
   * Makes the enqueue idempotent. A retried request, or a webhook Razorpay
   * delivers twice, must not send a second email. Convention:
   * `<template>:<bookingId>`.
   */
  dedupeKey: string;
  /** for reminders — the row is invisible to the worker until then */
  sendAt?: Date;
}

export async function enqueueNotification(db: Queryable, input: EnqueueInput): Promise<void> {
  // A missing address is not an error worth failing a booking over — a customer
  // who signed in with a phone credential has no email. Skipped, not dropped,
  // so it is countable.
  const status = input.to ? 'pending' : 'skipped';

  await db.query(
    `INSERT INTO notifications
       (user_id, booking_id, channel, template, to_address, payload, status,
        next_attempt_at, dedupe_key, last_error)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      input.userId,
      input.bookingId ?? null,
      input.channel,
      input.template,
      input.to || 'unknown',
      JSON.stringify(input.payload ?? {}),
      status,
      input.sendAt ?? new Date(),
      input.dedupeKey,
      input.to ? null : 'no address on file for this user',
    ],
  );
}

/** Cancel a queued-but-unsent notification — a reminder for a cancelled booking. */
export async function cancelPending(
  db: Queryable,
  bookingId: string,
  templates: string[],
): Promise<number> {
  const res = await db.query(
    `UPDATE notifications
        SET status = 'skipped', last_error = 'superseded'
      WHERE booking_id = $1 AND status = 'pending' AND template = ANY($2::text[])`,
    [bookingId, templates],
  );
  return res.rowCount ?? 0;
}
