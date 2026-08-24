-- 012_salon_image_uploads.sql — a storefront photo uploaded before the salon exists.
--
-- Idempotent: safe to re-run. Apply after 011_salon_submitted_at.sql.
--
-- Why a staging table
-- -------------------
-- salon_images is keyed by salon_id, and during onboarding there is no salon
-- id: the salons row is created by the submission itself. So an applicant had
-- nowhere to put bytes and the form asked them to "paste image links for now"
-- — which means finding an image host before you can apply, and a photo the
-- admin is judging that depends on a third party staying up.
--
-- The alternative to this table was to let people submit first and upload
-- afterwards. That fails the actual requirement: the photo is the strongest
-- signal an admin has that a real shop exists, so it has to be part of the
-- request they are reviewing, not something that arrives later.
--
-- One row per user, not one per upload
-- ------------------------------------
-- The applicant is staging *the* storefront photo, and uploading a second one
-- means "no, this one instead". A primary key on user_id makes replacement the
-- only possible behaviour and puts a hard ceiling on what a signed-in account
-- can park here: one row, capped at 2 MB by the upload route. An id-per-upload
-- table would need its own quota logic to say the same thing.
--
-- The row is temporary by design. applyForSalon moves it into salon_images in
-- the same transaction that creates the salon and then deletes it, so a
-- submitted application owns its bytes and nothing is left behind. What is
-- left behind is the other case — uploaded, never submitted — which the
-- sweep-staged-images job clears out; see src/workers/runner.ts.
--
-- Bytes in Postgres for the same reasons as 008: there is no object storage in
-- this project, and a container's filesystem does not survive a deploy.

BEGIN;

CREATE TABLE IF NOT EXISTS salon_image_uploads (
  -- The applicant. ON DELETE CASCADE because a staged photo is meaningless
  -- without the account that staged it.
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Checked against the file's actual magic bytes by the upload route, never
  -- taken from the browser's content-type header. Same list as salon_images.
  content_type text NOT NULL
               CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  bytes        bytea NOT NULL,
  byte_size    integer NOT NULL CHECK (byte_size > 0),
  -- Content hash, carried across to salon_images on claim so the served URL
  -- is the same shape as every other salon photo's.
  checksum     text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The sweep looks for rows older than its cutoff and nothing else.
CREATE INDEX IF NOT EXISTS salon_image_uploads_stale_idx
    ON salon_image_uploads (updated_at);

COMMIT;
