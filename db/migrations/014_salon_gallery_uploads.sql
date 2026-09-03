-- 014_salon_gallery_uploads.sql — the salon's gallery photos, uploaded rather than linked.
--
-- Idempotent: safe to re-run. Apply after 013_cron_heartbeat.sql.
--
-- Why this table already existed, and what was missing
-- ---------------------------------------------------
-- salon_photos is the gallery — many rows per salon, ordered by `sort`, read by
-- the customer app's carousel (src/salons/repo.ts loadPresentationData, surfaced
-- as `photos[]`). It has always held a `url` and nothing else, which meant the
-- only way to give a salon more than its one storefront shot was to seed a link
-- from scripts/seed-demo.ts. There was no upload path, so in practice a live
-- salon had exactly one picture: its cover.
--
-- This adds the bytes, exactly as 008 added them for the single storefront shot
-- in salon_images. The two stay separate on purpose — salon_images is keyed
-- one-row-per-salon (the cover, pointed at by salons.cover_url); salon_photos is
-- the many-row gallery. A salon owner uploads gallery photos in the panel; each
-- becomes a row here and appears in the customer carousel.
--
-- Bytes in Postgres for the same reasons as 008 and 012: there is no object
-- storage in this project and a container's filesystem does not survive a
-- deploy. A few hundred kilobytes per photo, capped at 2 MB by the upload route.
--
-- url stays, and stays nullable: a row is EITHER an uploaded photo (bytes set,
-- url null) OR a seeded/linked one (url set, bytes null). The customer query
-- coalesces the two into one served URL, so nothing downstream has to know
-- which kind a given photo is.

BEGIN;

-- A linked (seeded) photo has no bytes; an uploaded one has no url. Either is a
-- valid row, so url can no longer be mandatory.
ALTER TABLE salon_photos ALTER COLUMN url DROP NOT NULL;

-- Checked against the file's actual magic bytes by the upload route, never taken
-- from the browser's content-type header. Same allowed list as salon_images.
-- Nullable, because a linked row has no stored bytes; NULL passes the IN check.
ALTER TABLE salon_photos ADD COLUMN IF NOT EXISTS content_type text
  CHECK (content_type IN ('image/jpeg','image/png','image/webp'));
ALTER TABLE salon_photos ADD COLUMN IF NOT EXISTS bytes bytea;
ALTER TABLE salon_photos ADD COLUMN IF NOT EXISTS byte_size integer;
-- Content hash. It is the ETag and the ?v= on the served URL — so nothing
-- anywhere caches one photo's bytes under another's URL — and it is what makes
-- a re-upload of the same file a no-op rather than a duplicate row.
ALTER TABLE salon_photos ADD COLUMN IF NOT EXISTS checksum text;
-- Who uploaded it. Nullable and not cascading, exactly like salon_images:
-- removing the account that uploaded a photo must not delete the photo.
ALTER TABLE salon_photos ADD COLUMN IF NOT EXISTS uploaded_by uuid REFERENCES users(id);
ALTER TABLE salon_photos ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- A row is meaningless without something to render: either a link or bytes.
DO $$
BEGIN
  ALTER TABLE salon_photos
    ADD CONSTRAINT salon_photos_url_or_bytes
    CHECK (url IS NOT NULL OR bytes IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The same picture uploaded twice is one gallery photo, not two. Scoped to the
-- salon so two salons uploading the same stock shot do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS salon_photos_checksum_uniq
  ON salon_photos (salon_id, checksum) WHERE checksum IS NOT NULL;

COMMIT;
