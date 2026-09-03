import type { Pool } from '../db/pool.ts';
import { withTransaction } from '../db/pool.ts';

/**
 * Deleting your own account.
 *
 * The hard part is what a users row is tied to. bookings, payments and reviews
 * all carry customer_id as a NOT NULL foreign key with no ON DELETE action —
 * they are the salon's record of what happened and what was paid, and this
 * codebase already treats that kind of record as one you never erase to tidy up
 * a person. So a deletion keeps the row and strips it of the person rather than
 * removing it: name, email, avatar, phone and the auth_provider_id that linked
 * it to a Google identity are cleared, deleted_at is stamped, and personal data
 * with no retention obligation (favourites, notifications, staged uploads,
 * idempotency keys) is deleted outright.
 *
 * With auth_provider_id and email both NULL the row is unreachable by any future
 * sign-in — resolveSession matches on auth_provider_id and claimByEmail on a
 * verified email against a row that has none — so signing in again mints a fresh
 * customer account and this one lives on only as the anonymous customer_id on
 * records that must add up.
 */

/**
 * A salon owner cannot delete their account from here.
 *
 * The salon carries other people's bookings, a ledger and payouts; unwinding
 * that is not a self-service action, and it is the same reason the panel says a
 * salon is tied to its account and points owners at support to move it. Thrown
 * rather than returned so the route answers 409 and changes nothing.
 */
export class AccountDeletionBlockedError extends Error {
  readonly code = 'OWNS_SALON';
  constructor(message: string) {
    super(message);
    this.name = 'AccountDeletionBlockedError';
  }
}

export async function deleteOwnAccount(db: Pool, userId: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    // Lock the row for the length of the deletion so a concurrent request — or a
    // sign-in racing the same account — cannot interleave with it.
    const user = await tx.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    if (user.rowCount === 0) return; // already gone or anonymised — idempotent.

    const salon = await tx.query(`SELECT 1 FROM salons WHERE owner_id = $1`, [userId]);
    if ((salon.rowCount ?? 0) > 0) {
      throw new AccountDeletionBlockedError(
        'This account manages a salon, so it cannot be deleted here. ' +
          'Contact Hasino support to close or transfer the salon first.',
      );
    }

    // Sever the nullable, non-cascading references first: these keep the *record*
    // (an onboarding, a status change, a photo) while letting go of the person.
    // A plain customer has none of these; an operator account might.
    await tx.query(`UPDATE salons SET onboarded_by = NULL WHERE onboarded_by = $1`, [userId]);
    await tx.query(`UPDATE salons SET approved_by = NULL WHERE approved_by = $1`, [userId]);
    await tx.query(`UPDATE salon_status_events SET actor_id = NULL WHERE actor_id = $1`, [userId]);
    await tx.query(`UPDATE salon_images SET uploaded_by = NULL WHERE uploaded_by = $1`, [userId]);
    await tx.query(`UPDATE salon_photos SET uploaded_by = NULL WHERE uploaded_by = $1`, [userId]);

    // Personal data with no reason to survive the account.
    await tx.query(`DELETE FROM favorites WHERE user_id = $1`, [userId]);
    await tx.query(`DELETE FROM notifications WHERE user_id = $1`, [userId]);
    await tx.query(`DELETE FROM salon_image_uploads WHERE user_id = $1`, [userId]);
    await tx.query(`DELETE FROM idempotency_keys WHERE user_id = $1`, [userId]);

    // Strip the person from the row and unlink the identity.
    await tx.query(
      `UPDATE users
          SET name = NULL, email = NULL, avatar_url = NULL, phone = NULL,
              auth_provider_id = NULL, role = 'customer',
              deleted_at = now(), updated_at = now()
        WHERE id = $1`,
      [userId],
    );
  });
}
