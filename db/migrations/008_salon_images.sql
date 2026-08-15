-- 008_salon_images.sql — the salon's own storefront photo, uploaded rather than linked.
--
-- Idempotent: safe to re-run. Apply after 007_salon_applications.sql.
--
-- Why a table rather than a column
-- --------------------------------
-- salons.cover_url already exists and is already what every reader uses — the
-- customer list, the customer detail page, the admin panel. Nothing about that
-- changes: cover_url stays the one pointer to a salon's picture, and this
-- migration does not add a second one. What was missing was somewhere to put
-- the *bytes* when the picture is not a URL somebody else is hosting.
--
-- Until now the only way to give a salon a photo was to paste a link to one
-- hosted elsewhere ("direct uploads are coming" — views/apply.js). That asks a
-- barber to find a public image host, and it means every salon card on Hasino
-- depends on a third party staying up.
--
-- Why Postgres rather than a bucket or a directory
-- ------------------------------------------------
-- There is no object storage in this project and no credentials for one, so a
-- bucket would mean new environment variables on every deployment target
-- before a single salon could upload anything. A directory on disk is worse:
-- fly.toml and render.yaml both run this app in a container with an ephemeral
-- filesystem, so an uploaded photo would survive until the next deploy and
-- then quietly turn into a broken image.
--
-- Postgres is the one durable store this app already has, on every host it
-- runs on, and it is also the only thing the admin panel — a separate process
-- on a separate origin — shares with the public server. A few hundred
-- kilobytes per salon, capped at 2 MB by the upload route, is not a size
-- Postgres finds interesting. If Hasino ever gets a CDN, cover_url points at
-- it instead and this table is dropped without touching a single reader.
--
-- One row per salon: this is the storefront shot, not the gallery.
-- salon_photos is still the gallery.

BEGIN;

CREATE TABLE IF NOT EXISTS salon_images (
  salon_id     uuid PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
  -- Checked against the file's actual magic bytes by the upload route, not
  -- taken from the browser's content-type header.
  content_type text NOT NULL
               CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  bytes        bytea NOT NULL,
  byte_size    integer NOT NULL CHECK (byte_size > 0),
  -- Content hash. It is the ETag, and it is the ?v= on cover_url — so a
  -- replaced photo is a new URL and no cache anywhere serves the old one.
  checksum     text NOT NULL,
  -- Who uploaded it: the owner or the admin who onboarded them. Nullable and
  -- not cascading — removing a staff account must not delete a salon's photo.
  uploaded_by  uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMIT;
