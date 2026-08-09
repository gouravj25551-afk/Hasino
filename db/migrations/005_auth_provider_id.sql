-- 005_auth_provider_id.sql — rename users.firebase_uid to users.auth_provider_id.
--
-- Idempotent: safe to re-run. Apply after 004_admin_and_locations.sql.
--
-- Why
-- ---
-- The column holds the identity provider's subject claim — the join between a
-- verified token and the row that owns bookings. It never had anything to do
-- with Firebase specifically; the name simply recorded which provider was
-- wired up on the day it was added. Authentication is Clerk now, and a column
-- called firebase_uid would be a lie in every query that touches it.
--
-- Named for the role it plays rather than for Clerk, so swapping provider
-- again is a change to src/auth/verifier.ts and nothing else. The values it
-- holds are opaque to the database either way: Firebase uids, Clerk user_...
-- ids, and the 'dev:' prefixed ones the CI harness uses all coexist here
-- without the schema caring.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'firebase_uid'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'auth_provider_id'
  ) THEN
    ALTER TABLE users RENAME COLUMN firebase_uid TO auth_provider_id;
  END IF;
END $$;

-- Fresh databases get the column from schema.sql under its new name and never
-- enter the block above; this covers them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_auth_provider_id_key'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'users_auth_provider_id_key'
  ) THEN
    -- One provider identity maps to exactly one row. Without this, a second
    -- sign-in could fan out into duplicate accounts holding separate bookings.
    ALTER TABLE users ADD CONSTRAINT users_auth_provider_id_key UNIQUE (auth_provider_id);
  END IF;
END $$;

COMMIT;
