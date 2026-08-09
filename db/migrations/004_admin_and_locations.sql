-- 004_admin_and_locations.sql — operator surface: location, audit, one-per-owner.
--
-- Idempotent: safe to re-run. Apply after 003_payments.sql.
--
-- Why location columns
-- --------------------
-- The spec's schema has lat/lng and a free-text address. That is enough to sort
-- by distance and useless for "show me every salon in Pune" — the question an
-- operator actually asks. Parsing a city back out of an address string is a
-- guess that fails on the first "Shop 4, Above Dominos, Baner". City and area
-- are what the admin filters by; lat/lng stay the source of truth for distance.
--
-- Why one salon per owner, in the database
-- ----------------------------------------
-- salonForOwner() does `WHERE owner_id = $1` and takes rows[0]. A second salon
-- under one owner would not error — it would silently pick one, and which one
-- depends on planner mood. A route-level check cannot hold that invariant
-- against a concurrent insert; a unique index can. When a chain shows up the
-- answer is an organisations table, not dropping this index.

BEGIN;

-- ---------- location ----------
ALTER TABLE salons ADD COLUMN IF NOT EXISTS city  text;
ALTER TABLE salons ADD COLUMN IF NOT EXISTS area  text;
ALTER TABLE salons ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE salons ADD COLUMN IF NOT EXISTS email text;

-- Partial on status because every operator list is "pending in Bengaluru",
-- never "every salon ever in Bengaluru".
CREATE INDEX IF NOT EXISTS salons_city_idx ON salons (city, status);

-- ---------- audit ----------
-- Who onboarded this salon, who approved it, when. "Why is this live" is a
-- question that gets asked six weeks later, by someone who was not there.
ALTER TABLE salons ADD COLUMN IF NOT EXISTS onboarded_by uuid REFERENCES users(id);
ALTER TABLE salons ADD COLUMN IF NOT EXISTS approved_by  uuid REFERENCES users(id);
ALTER TABLE salons ADD COLUMN IF NOT EXISTS approved_at  timestamptz;

-- ---------- one owner, one salon ----------
-- Guarded: on a database that already has two salons under one owner, creating
-- this index would abort the whole migration with a constraint violation and no
-- explanation. Fail loudly with the offending owner instead.
DO $$
DECLARE
  dupes text;
BEGIN
  SELECT string_agg(owner_id::text, ', ') INTO dupes
    FROM (SELECT owner_id FROM salons GROUP BY owner_id HAVING count(*) > 1) d;

  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot add salons_one_per_owner: these owners already have more than one salon: %. '
      'Reassign the extra salons to their own owner rows first.', dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS salons_one_per_owner ON salons (owner_id);

-- ---------- why a salon is in the state it is in ----------
CREATE TABLE IF NOT EXISTS salon_status_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  reason      text,
  -- Nullable and ON DELETE unset rather than cascade: an admin account being
  -- removed must not erase the record of what they did.
  actor_id    uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS salon_status_events_salon_idx
  ON salon_status_events (salon_id, created_at DESC);

COMMIT;
