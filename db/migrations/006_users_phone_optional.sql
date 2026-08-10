-- 006_users_phone_optional.sql — users.phone becomes optional.
--
-- Idempotent: safe to re-run. Apply after 005_auth_provider_id.sql.
--
-- Why
-- ---
-- Sign-in is Google through Clerk, and Google carries no phone number. The
-- column was NOT NULL, so a Google account could not exist until the person
-- verified a phone — a second step bolted onto the front of every first
-- sign-in, which the server enforced by answering 428 PHONE_REQUIRED to
-- /api/me until it was done. That step is being removed: an account is now
-- created from the Google identity alone.
--
-- UNIQUE is deliberately kept. Postgres does not consider two NULLs equal, so
-- any number of rows may have no phone while a number that IS present stays
-- exactly as unforgeable as before — which matters, because a present phone
-- still identifies a salon owner onboarded by an admin.
--
-- The join between an admin-created owner row and the Google account that
-- later adopts it moves to the verified email address; see
-- src/auth/session.ts. Existing rows are untouched and keep their numbers.

BEGIN;

ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;

-- The lookup resolveSession now does on every first sign-in. Without it that
-- is a sequential scan of users on a path that runs for every new account.
-- lower() because email case is not significant and the comparison is done
-- case-insensitively; partial because rows with no email can never match.
CREATE INDEX IF NOT EXISTS users_email_lower_idx
    ON users (lower(email))
 WHERE email IS NOT NULL;

COMMIT;
