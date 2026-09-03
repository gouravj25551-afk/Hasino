-- 015_user_deleted_at.sql — a marker for an account its owner has deleted.
--
-- Idempotent: safe to re-run. Apply after 014_salon_gallery_uploads.sql.
--
-- Why anonymise rather than DELETE the row
-- ----------------------------------------
-- A customer's bookings, payments and reviews all carry customer_id as a NOT
-- NULL foreign key with no ON DELETE action (db/schema.sql). Those rows are the
-- salon's financial and operational record — what was booked, what was paid,
-- what was refunded — and the rest of this codebase already treats that kind of
-- record as one you never erase to tidy up a person (see salon_status_events,
-- salon_images.uploaded_by: "removing an account must not erase the record of
-- what they did").
--
-- So deleting an account keeps the row and strips it of the person: name, email,
-- avatar, phone and the auth_provider_id that linked it to a Google identity are
-- all cleared, and deleted_at is stamped. With auth_provider_id and email both
-- NULL, no future sign-in can resolve to this row or claim it (see
-- resolveSession / claimByEmail in src/auth/session.ts) — the identity that
-- signs in again gets a brand-new customer account, and this one survives only
-- as the anonymous customer_id on records that must add up.
--
-- Personal data with no such obligation — favourites, notifications, staged
-- image uploads, idempotency keys — is deleted outright by the deletion routine,
-- not kept. deleted_at is only about the users row itself.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMIT;
