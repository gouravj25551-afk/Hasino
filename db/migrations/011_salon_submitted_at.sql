-- 011_salon_submitted_at.sql — when this application was last submitted.
--
-- Idempotent: safe to re-run. Apply after 010_salon_city_normalized.sql.
--
-- Why
-- ---
-- The salon row is the application (see 007), and "when was this submitted"
-- was being answered with created_at. That is right exactly once. A rejected
-- application can be fixed and sent back — applyForSalon UPDATEs the row it
-- was rejected on rather than replacing it, deliberately, so the rejection
-- stays in salon_status_events where the next reviewer will see it — and
-- after that update created_at still says when the *first* attempt was made.
--
-- So an admin looking at a queue of pending requests saw a resubmission dated
-- three weeks ago sitting above one sent this morning, and the applicant's own
-- "Submitted <date>" told them a date they would not recognise. Neither is a
-- cosmetic problem: the queue is worked oldest-first.
--
-- created_at keeps its meaning — when this salon first existed on Hasino — and
-- is what "Onboarded" reads from in the admin panel. submitted_at is when the
-- current request was made, and moves every time one is.
--
-- Backfilled from created_at, which is the correct answer for every row that
-- has never been resubmitted, and the best available one for any that has.

BEGIN;

ALTER TABLE salons ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

UPDATE salons SET submitted_at = created_at WHERE submitted_at IS NULL;

ALTER TABLE salons ALTER COLUMN submitted_at SET DEFAULT now();

DO $$
BEGIN
  -- Set NOT NULL only once every row has a value. Separate from the backfill
  -- so a re-run on an already-migrated database is a no-op rather than an
  -- error.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'salons' AND column_name = 'submitted_at' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE salons ALTER COLUMN submitted_at SET NOT NULL;
  END IF;
END $$;

-- The pending queue is worked oldest-submitted-first, which is now a
-- different order from oldest-created. Replaces the created_at ordering in
-- salons_pending_idx (007) for that one screen; the old index is left alone
-- because nothing else changed about it.
CREATE INDEX IF NOT EXISTS salons_pending_submitted_idx
    ON salons (submitted_at DESC)
 WHERE status = 'pending';

COMMIT;
