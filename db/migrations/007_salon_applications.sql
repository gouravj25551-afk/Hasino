-- 007_salon_applications.sql — self-serve salon applications and rejection.
--
-- Idempotent: safe to re-run. Apply after 006_users_phone_optional.sql.
--
-- Why
-- ---
-- A salon is no longer created by an admin; the owner applies for one and an
-- admin approves it. Two things were missing for that.
--
-- 'rejected' as a status. The machine had pending/active/suspended/banned,
-- which meant a turned-down application could only be 'banned' — a word that
-- belongs to a salon that defrauded customers, not to one whose photos were
-- too blurry. They also differ in what happens next: banned is terminal,
-- rejected can be reopened for review.
--
-- description, because the admin is being asked to judge a business from a
-- form and a name plus an address is not enough to judge anything.
--
-- The application is not a separate table. The salon row IS the application:
-- it holds every field the admin reviews, its status is the application's
-- status, and salon_status_events already records who decided what and why.
-- A second table would be the same data twice, joined on approval, with two
-- places for the answer to "is this salon live".

BEGIN;

ALTER TABLE salons ADD COLUMN IF NOT EXISTS description text;

DO $$
BEGIN
  -- The CHECK is replaced rather than added to; Postgres has no "extend a
  -- constraint". Dropping first keeps this re-runnable.
  ALTER TABLE salons DROP CONSTRAINT IF EXISTS salons_status_check;
  ALTER TABLE salons ADD CONSTRAINT salons_status_check
    CHECK (status IN ('pending','active','suspended','banned','rejected'));
END $$;

-- The admin panel opens on pending applications, and that list is the whole
-- point of the screen. Partial because the other statuses are browsed by city
-- or name, never by "give me every banned salon".
CREATE INDEX IF NOT EXISTS salons_pending_idx
    ON salons (created_at DESC)
 WHERE status = 'pending';

COMMIT;
