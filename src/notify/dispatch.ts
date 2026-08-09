import type { Pool } from '../db/pool.ts';
import { render } from './templates.ts';

/**
 * Drains the outbox.
 *
 * Claim-then-send, with the claim committed before the send starts: if this
 * process dies mid-send the row is left `pending` with its attempt already
 * counted, so the retry is bounded rather than infinite. The alternative —
 * holding a transaction open across an HTTP call to an email provider — parks
 * a Postgres connection on someone else's latency.
 *
 * At-least-once, not exactly-once. A duplicate booking confirmation is a
 * nuisance; a missing one is a customer standing outside a salon. The dedupe
 * key on enqueue removes the common duplicate (a retried request); a genuine
 * crash between send and mark-sent can still double up, and that trade is
 * chosen on purpose.
 */

export interface Channel {
  readonly kind: string;
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Retried later. */
export class TransientSendError extends Error {}
/** Never going to work — a malformed address. Fails the row immediately. */
export class PermanentSendError extends Error {}

export const MAX_ATTEMPTS = 5;

/** 1m, 4m, 9m, 16m — quadratic, so a provider outage is not hammered. */
function backoffMs(attempts: number): number {
  return Math.min(attempts * attempts * 60_000, 6 * 3600_000);
}

// ------------------------------------------------------------------ channels

/** Development, and any environment with no provider configured. */
export class ConsoleChannel implements Channel {
  readonly kind = 'console';
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];
  async send(to: string, subject: string, text: string): Promise<void> {
    this.sent.push({ to, subject, text });
    console.log(`\n--- email to ${to} ---\n${subject}\n\n${text}\n---\n`);
  }
}

/**
 * Resend's HTTP API. Chosen over SMTP because SMTP means either a dependency
 * (nodemailer) or hand-rolling a protocol client, and this repo has two runtime
 * dependencies. Any provider with a JSON send endpoint drops in here.
 */
export class ResendChannel implements Channel {
  readonly kind = 'resend';
  #apiKey: string;
  #from: string;

  constructor(apiKey: string, from: string) {
    this.#apiKey = apiKey;
    this.#from = from;
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ from: this.#from, to: [to], subject, text }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new TransientSendError((e as Error).message);
    }

    if (res.ok) return;
    const body = await res.text().catch(() => '');
    // 422 is a rejected address; retrying it forever just fills the table.
    if (res.status === 422 || res.status === 400) {
      throw new PermanentSendError(`${res.status} ${body.slice(0, 200)}`);
    }
    throw new TransientSendError(`${res.status} ${body.slice(0, 200)}`);
  }
}

export function channelFromEnv(): Channel {
  const key = process.env['RESEND_API_KEY'];
  const from = process.env['EMAIL_FROM'];
  if (key && from) return new ResendChannel(key, from);
  return new ConsoleChannel();
}

// -------------------------------------------------------------------- worker

interface Row {
  id: string;
  channel: string;
  template: string;
  to_address: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface DispatchResult {
  sent: number;
  failed: number;
  retrying: number;
}

export async function dispatchDue(
  db: Pool,
  channel: Channel,
  opts: { now?: Date; limit?: number } = {},
): Promise<DispatchResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 50;

  // Claim: bump attempts and push next_attempt_at out before sending anything.
  // SKIP LOCKED so more than one worker can run without fighting.
  const claimed = await db.query<Row>(
    `UPDATE notifications n
        SET attempts = n.attempts + 1,
            next_attempt_at = $3
      WHERE n.id IN (
        SELECT id FROM notifications
         WHERE status = 'pending' AND next_attempt_at <= $1
         ORDER BY next_attempt_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING n.id, n.channel, n.template, n.to_address, n.payload, n.attempts`,
    // The retry time is computed here rather than in SQL: make_interval's named
    // arguments give Postgres nothing to infer a parameter's type from, and the
    // error only shows up at runtime.
    [now, limit, new Date(now.getTime() + backoffMs(1))],
  );

  let sent = 0;
  let failed = 0;
  let retrying = 0;

  for (const row of claimed.rows) {
    // Only email has a channel today. SMS/WhatsApp rows are parked rather than
    // silently dropped, so switching one on later is a worker change, not a
    // backfill of lost notifications.
    if (row.channel !== 'email') {
      await db.query(
        `UPDATE notifications SET status = 'skipped', last_error = $2 WHERE id = $1`,
        [row.id, `no ${row.channel} channel configured`],
      );
      continue;
    }

    try {
      const { subject, text } = render(row.template, row.payload ?? {});
      await channel.send(row.to_address, subject, text);
      await db.query(
        `UPDATE notifications SET status = 'sent', sent_at = $2, last_error = NULL WHERE id = $1`,
        [row.id, new Date()],
      );
      sent += 1;
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      const permanent =
        err instanceof PermanentSendError ||
        // An unknown template is a code bug; retrying it 5 times changes nothing.
        message.startsWith('unknown notification template');
      const exhausted = row.attempts >= MAX_ATTEMPTS;

      if (permanent || exhausted) {
        await db.query(
          `UPDATE notifications SET status = 'failed', last_error = $2 WHERE id = $1`,
          [row.id, message],
        );
        failed += 1;
      } else {
        await db.query(
          `UPDATE notifications
              SET last_error = $2,
                  next_attempt_at = $3
            WHERE id = $1`,
          [row.id, message, new Date(now.getTime() + backoffMs(row.attempts))],
        );
        retrying += 1;
      }
    }
  }

  return { sent, failed, retrying };
}
