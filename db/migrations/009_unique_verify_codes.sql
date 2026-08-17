-- 009_unique_verify_codes.sql — one live code, one booking.
--
-- Idempotent: safe to re-run. Apply after 008_salon_images.sql.
--
-- Why
-- ---
-- verify_code is generated per booking and has always been stored on the
-- booking row (see the INSERT in src/booking/create.ts) — nothing writes a code
-- at customer level and nothing shares one between bookings. What was missing
-- was a guarantee that two *live* bookings at the same salon cannot end up
-- holding the same six digits by chance.
--
-- randomInt(0, 1_000_000) collides about once in a million draws per pair. A
-- salon with a busy Saturday has a few dozen live codes, so this is rare; it
-- is also exactly the case where the failure is worst. The barber types six
-- digits, the panel resolves them against the booking in front of it, and if
-- two bookings share a code the wrong customer can be checked in — a bug that
-- appears once and is unreproducible.
--
-- Scope: per salon, and only over the statuses where a code can still be used.
-- Not global, because two salons on opposite sides of the country sharing six
-- digits means nothing — each verification already names its salon. Not over
-- history either: a completed booking from March keeps its code for the record
-- and must not consume the number forever.
--
-- src/booking/create.ts picks a code that is free for the salon before it
-- inserts, under the same advisory lock that serialises the salon's writes.
-- This index is the backstop for anything that ever writes a booking without
-- going through it.

BEGIN;

-- Existing rows first: the index cannot be created while a clash exists, and
-- an operator meeting that error on a live database has no obvious next step.
-- Anything already duplicated among live bookings is re-rolled here. Codes on
-- finished bookings are left exactly as they are — they are history.
DO $$
DECLARE
  clash record;
BEGIN
  FOR clash IN
    SELECT id
      FROM (
        SELECT id,
               row_number() OVER (
                 PARTITION BY salon_id, verify_code ORDER BY created_at
               ) AS n
          FROM bookings
         WHERE verify_code IS NOT NULL
           AND status IN ('pending_payment','booked','verified','in_progress')
      ) ranked
     WHERE n > 1
  LOOP
    -- The oldest booking keeps the code; the later ones are re-issued. A
    -- customer whose code changes before their slot is shown the new one by
    -- the app, which reads the row rather than remembering anything.
    UPDATE bookings
       SET verify_code = lpad((floor(random() * 1000000))::int::text, 6, '0')
     WHERE id = clash.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS bookings_live_verify_code_idx
  ON bookings (salon_id, verify_code)
  WHERE verify_code IS NOT NULL
    AND status IN ('pending_payment','booked','verified','in_progress');

COMMIT;
