-- Hasino — salon booking marketplace
-- Schema per build spec §5.
--
-- Deviations from the spec are marked [DEVIATION] with a reason. There are
-- three, all small; see README "Where this deviates from the spec".

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ---------- users ----------
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone          text UNIQUE NOT NULL,
  -- Firebase is the identity provider (spec §7: "auth only, data in Postgres").
  -- This is the join between the token's subject and the row that owns bookings.
  firebase_uid   text UNIQUE,
  name           text,
  email          text,
  role           text NOT NULL DEFAULT 'customer'
                 CHECK (role IN ('customer','business','admin')),
  no_show_count  smallint NOT NULL DEFAULT 0,
  blocked_until  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- salons ----------
CREATE TABLE IF NOT EXISTS salons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users(id),
  name             text NOT NULL,
  address          text NOT NULL,
  lat              double precision NOT NULL,
  lng              double precision NOT NULL,
  timezone         text NOT NULL DEFAULT 'Asia/Kolkata',  -- [DEVIATION 1]
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','active','suspended','banned')),
  -- Razorpay Partner sub-merchant
  rzp_account_id   text,
  rzp_access_token text,          -- encrypt at rest
  rzp_kyc_status   text NOT NULL DEFAULT 'pending',
  strike_count     smallint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- [DEVIATION 1] salons.timezone
--   salon_hours stores wall-clock `time` values; bookings store `timestamptz`.
--   Converting between them requires a zone. Hardcoding IST in application
--   code makes the second city a rewrite of the availability engine, which is
--   the one module the spec says everything rests on. One column now.

CREATE INDEX IF NOT EXISTS salons_geo_idx ON salons (lat, lng) WHERE status = 'active';

-- ---------- services ----------
CREATE TABLE IF NOT EXISTS services (      -- global master list, admin-managed
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name     text NOT NULL,
  category text NOT NULL
);

CREATE TABLE IF NOT EXISTS salon_services (   -- per-salon price AND duration
  salon_id     uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  service_id   uuid NOT NULL REFERENCES services(id),
  price        integer NOT NULL,               -- paise
  duration_min integer NOT NULL CHECK (duration_min > 0),
  buffer_min   integer NOT NULL DEFAULT 10,
  active       boolean NOT NULL DEFAULT true,
  PRIMARY KEY (salon_id, service_id)
);

-- ---------- hours + capacity ----------
CREATE TABLE IF NOT EXISTS salon_hours (
  salon_id          uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  weekday           smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday, matches EXTRACT(DOW) and JS getUTCDay()
  open_at           time NOT NULL,
  close_at          time NOT NULL,
  break_start       time,
  break_end         time,
  online_capacity   smallint NOT NULL CHECK (online_capacity >= 0),
  slot_interval_min smallint NOT NULL DEFAULT 30,
  PRIMARY KEY (salon_id, weekday),
  CHECK (close_at > open_at),
  CHECK ((break_start IS NULL) = (break_end IS NULL)),
  CHECK (break_end IS NULL OR break_end > break_start)
);
-- A weekday with no row is a non-working day.

CREATE TABLE IF NOT EXISTS salon_holidays (
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  date     date NOT NULL,
  reason   text,
  PRIMARY KEY (salon_id, date)
);

-- ---------- bookings ----------
CREATE TABLE IF NOT EXISTS bookings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id      uuid NOT NULL REFERENCES salons(id),
  customer_id   uuid NOT NULL REFERENCES users(id),
  start_at      timestamptz NOT NULL,
  end_at        timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'booked'
                CHECK (status IN ('booked','verified','in_progress','completed',
                                  'no_show','rescheduled',
                                  'cancelled_by_customer',   -- [DEVIATION 2]
                                  'cancelled_by_salon')),
  amount        integer NOT NULL,              -- paise, goes to salon
  rzp_order_id  text,
  rzp_payment_id text,
  verify_code   char(6),
  reschedule_deadline timestamptz,             -- no_show / cancel + 36h
  rescheduled_from    uuid REFERENCES bookings(id),
  customer_confirmed_at timestamptz,
  code_verified_at      timestamptz,
  actual_start          timestamptz,           -- salon pressed "start"
  actual_end            timestamptz,           -- salon pressed "complete"
  cancelled_at   timestamptz,                                -- [DEVIATION 4]
  refund_status  text NOT NULL DEFAULT 'none'                -- [DEVIATION 4]
                 CHECK (refund_status IN ('none','pending','processed','failed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);

-- [DEVIATION 4] cancelled_at + refund_status
--   §4 promises "Full refund, auto" for [Close for today] and for a customer
--   who arrives at a shut shop. The schema has nowhere to record whether that
--   refund was actually issued, so a failed Razorpay refund would be invisible
--   and unretryable — the salon keeps the money and the customer is told they
--   were refunded. A refund is an async external call; it needs a state field.

-- [DEVIATION 2] status 'cancelled_by_customer'
--   §4 defines the rule "Customer cancels -> no refund, reschedule within 36h"
--   but the status list has no state for it. Without this value a customer
--   cancellation is unrepresentable, and — worse — the cancelled booking keeps
--   consuming a chair forever, because the availability query counts
--   'booked'. This is a defect in the spec, not a design choice.

CREATE INDEX IF NOT EXISTS bookings_customer_idx ON bookings (customer_id, start_at DESC);

-- [DEVIATION 3] the business panel's three hottest reads — "today's bookings",
--   the calendar, and [Close for today] — all filter salon + day. The spec has
--   no index for that access path.
CREATE INDEX IF NOT EXISTS bookings_salon_day_idx ON bookings (salon_id, start_at);

CREATE TABLE IF NOT EXISTS booking_items (
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  service_id   uuid NOT NULL REFERENCES services(id),
  price        integer NOT NULL,               -- snapshot at booking time
  duration_min integer NOT NULL,               -- snapshot at booking time
  PRIMARY KEY (booking_id, service_id)
);

-- ---------- the slot ledger ----------
-- One row per slot the booking occupies.
-- A 60-min booking on a 30-min grid writes TWO rows.
--
-- slot_start_at is the source of truth, NOT a slot index. If a salon
-- changes its opening time later, index-based rows would silently
-- change meaning.
CREATE TABLE IF NOT EXISTS booking_slots (
  salon_id      uuid NOT NULL REFERENCES salons(id),
  slot_start_at timestamptz NOT NULL,
  booking_id    uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  PRIMARY KEY (salon_id, slot_start_at, booking_id)
);
CREATE INDEX IF NOT EXISTS booking_slots_lookup ON booking_slots (salon_id, slot_start_at);

-- ---------- reviews, strikes ----------
CREATE TABLE IF NOT EXISTS reviews (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id),
  salon_id   uuid NOT NULL REFERENCES salons(id),
  rating     smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    text,
  reply      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reviews_salon_idx ON reviews (salon_id, created_at DESC);

CREATE TABLE IF NOT EXISTS salon_strikes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id   uuid NOT NULL REFERENCES salons(id),
  booking_id uuid REFERENCES bookings(id),
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
