-- [DEVIATION 6] salons.cover_url, salon_photos, favorites
-- The customer marketplace UI needs salon imagery and a way to save
-- favorites; the spec's schema has neither. Safe to run against a database
-- that already has these (fresh installs get them from db/schema.sql).

BEGIN;

ALTER TABLE salons ADD COLUMN IF NOT EXISTS cover_url text;

CREATE TABLE IF NOT EXISTS salon_photos (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  url      text NOT NULL,
  sort     smallint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS salon_photos_salon_idx ON salon_photos (salon_id, sort);

CREATE TABLE IF NOT EXISTS favorites (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_id   uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, salon_id)
);

COMMIT;
