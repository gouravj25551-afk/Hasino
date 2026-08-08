-- [DEVIATION 5] users.avatar_url, users.updated_at
-- Google sign-in refreshes name/email/photo on every sign-in so a changed
-- Google profile picture or display name shows up here instead of being
-- frozen at first login. Safe to run against a database that already has
-- these columns (fresh installs get them straight from db/schema.sql).

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMIT;
