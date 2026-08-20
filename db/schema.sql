-- Hasino — salon booking marketplace
-- Schema per build spec §5.
--
-- Deviations from the spec are marked [DEVIATION] with a reason; see README
-- "Where this deviates from the spec" for the original three plus later ones.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ---------- users ----------
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Optional: sign-in is Google, which carries no phone number. UNIQUE still
  -- holds for rows that have one (Postgres treats NULLs as distinct), because
  -- a present number identifies a salon owner an admin onboarded.
  -- See db/migrations/006_users_phone_optional.sql.
  phone          text UNIQUE,
  -- The identity provider's subject claim (spec §7: "auth only, data in
  -- Postgres"). This is the join between a verified token and the row that
  -- owns bookings. Named for the role it plays, not for the provider — see
  -- db/migrations/005_auth_provider_id.sql.
  auth_provider_id text UNIQUE,
  name           text,
  email          text,
  avatar_url     text,       -- [DEVIATION 5] Google sign-in's `picture` claim
  role           text NOT NULL DEFAULT 'customer'
                 CHECK (role IN ('customer','business','admin')),
  no_show_count  smallint NOT NULL DEFAULT 0,
  blocked_until  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()   -- [DEVIATION 5]
);

-- [DEVIATION 5] users.avatar_url, users.updated_at
--   Google sign-in (build order: Google auth) refreshes name/email/photo on
--   every sign-in so a changed Google profile picture or display name is
--   reflected here, not frozen at first login. avatar_url holds the token's
--   `picture` claim; updated_at records when that last happened. See
--   db/migrations/001_users_profile_fields.sql.

-- ---------- salons ----------
CREATE TABLE IF NOT EXISTS salons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users(id),
  name             text NOT NULL,
  address          text NOT NULL,
  lat              double precision NOT NULL,
  lng              double precision NOT NULL,
  timezone         text NOT NULL DEFAULT 'Asia/Kolkata',  -- [DEVIATION 1]
  -- 'pending' is an application awaiting review — the salon row IS the
  -- application. 'rejected' is a turned-down one, distinct from 'banned':
  -- banned is terminal, rejected can be reopened. See migration 007.
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','active','suspended','banned','rejected')),
  -- Razorpay Partner sub-merchant (build order step 4, gated on the Partner
  -- application). Not the model the payment code runs on today — see
  -- rzp_route_account_id below and README "Where the money goes".
  rzp_account_id   text,
  rzp_access_token text,          -- encrypt at rest
  rzp_kyc_status   text NOT NULL DEFAULT 'pending',

  -- [DEVIATION 9] platform-account model.
  --   Payments are collected into the platform's Razorpay account and the
  --   salon's share is tracked in ledger_entries. Every sale writes a paired
  --   'sale' (+gross) and 'commission' (-cut) entry, so the salon's balance is
  --   always SUM(amount) and never a mutable running total that can drift.
  --   commission_bps is per-salon because launch deals and category pricing are
  --   the norm; the default comes from PLATFORM_COMMISSION_BPS at insert time.
  --   When Razorpay Route is enabled, rzp_route_account_id turns each sale into
  --   a transfer at capture time and the ledger becomes the reconciliation
  --   record rather than the source of truth. Nothing else changes.
  commission_bps   smallint NOT NULL DEFAULT 1500
                   CONSTRAINT salons_commission_bps_check
                   CHECK (commission_bps BETWEEN 0 AND 10000),
  rzp_route_account_id text,
  payout_beneficiary   jsonb,

  strike_count     smallint NOT NULL DEFAULT 0,
  cover_url        text,                                    -- [DEVIATION 6]
  -- What the owner writes about the salon on the application form; the admin
  -- is judging a business, and a name and an address judge nothing.
  description      text,

  -- [DEVIATION 10] operator columns.
  --   lat/lng sort by distance but cannot answer "every salon in Pune", which
  --   is the question the admin panel is built around; parsing a city back out
  --   of a free-text address is a guess. phone/email are the salon's own
  --   contact details, distinct from the owner's on users.
  --   onboarded_by/approved_by/approved_at record who did what, because "why is
  --   this salon live" gets asked six weeks later.
  city             text,
  area             text,
  phone            text,
  email            text,
  onboarded_by     uuid REFERENCES users(id),
  approved_by      uuid REFERENCES users(id),
  approved_at      timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now()
);

-- [DEVIATION 1] salons.timezone
--   salon_hours stores wall-clock `time` values; bookings store `timestamptz`.
--   Converting between them requires a zone. Hardcoding IST in application
--   code makes the second city a rewrite of the availability engine, which is
--   the one module the spec says everything rests on. One column now.

CREATE INDEX IF NOT EXISTS salons_geo_idx ON salons (lat, lng) WHERE status = 'active';

-- [DEVIATION 10] the operator's list is always "pending in Bengaluru", never
--   "every salon ever in Bengaluru", so the index carries status.
CREATE INDEX IF NOT EXISTS salons_city_idx ON salons (city, status);

-- [DEVIATION 10] customer discovery filters on the salon's city, and the two
--   sides of that comparison are typed by different people — an owner's
--   onboarding form and a geocoder. "Jind" and "jind" are one town, so the
--   predicate is lower(trim(city)) and needs its own expression index; the
--   raw-column index above cannot serve it. Equality, never a prefix: a LIKE
--   would start matching a neighbouring town's name, which is precisely the
--   result the filter exists to prevent. See db/migrations/010.
CREATE INDEX IF NOT EXISTS salons_city_norm_idx
  ON salons (lower(regexp_replace(btrim(city), '\s+', ' ', 'g')), status);

-- [DEVIATION 10] one owner, one salon — enforced here rather than only in the
--   route, because salonForOwner() does `WHERE owner_id = $1` and takes
--   rows[0]. A second salon under one owner would not error, it would silently
--   pick one, and which one depends on planner mood. A route check also cannot
--   hold this against a concurrent insert. A chain needs an organisations
--   table, not the removal of this index.
CREATE UNIQUE INDEX IF NOT EXISTS salons_one_per_owner ON salons (owner_id);

-- [DEVIATION 10] why a salon is in the state it is in.
CREATE TABLE IF NOT EXISTS salon_status_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  reason      text,
  -- Nullable, and deliberately not ON DELETE CASCADE: removing an admin
  -- account must not erase the record of what they did.
  actor_id    uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS salon_status_events_salon_idx
  ON salon_status_events (salon_id, created_at DESC);

-- [DEVIATION 6] salons.cover_url, salon_photos, favorites
--   The customer marketplace UI needs salon imagery and a way to save
--   favorites; the spec's schema has neither. cover_url is the card/hero
--   image; salon_photos is the gallery. Seeded only from scripts/seed-demo.ts
--   — never hardcoded in application code — so a salon with no photos
--   renders a placeholder instead of a borrowed stock image.
CREATE TABLE IF NOT EXISTS salon_photos (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  url      text NOT NULL,
  sort     smallint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS salon_photos_salon_idx ON salon_photos (salon_id, sort);

-- [DEVIATION 11] salon_images — the storefront shot, uploaded rather than linked.
--   cover_url is still the only pointer to a salon's picture; this holds the
--   bytes for the case where Hasino hosts it instead of somebody else. In
--   Postgres because there is no object storage here and a container's disk
--   does not survive a deploy. See db/migrations/008_salon_images.sql.
CREATE TABLE IF NOT EXISTS salon_images (
  salon_id     uuid PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
  content_type text NOT NULL
               CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  bytes        bytea NOT NULL,
  byte_size    integer NOT NULL CHECK (byte_size > 0),
  checksum     text NOT NULL,
  uploaded_by  uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_id   uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, salon_id)
);

-- ---------- services ----------
CREATE TABLE IF NOT EXISTS services (      -- global master list, admin-managed
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name     text NOT NULL,
  category text NOT NULL
);

-- [DEVIATION 10] two rows called 'Haircut' would split one service across two
--   menus and two sets of bookings with nothing to say which is canonical. The
--   catalogue seed uses this for ON CONFLICT DO NOTHING, and the admin's
--   create-service route uses it to reject duplicates in the database rather
--   than in a check-then-insert race.
CREATE UNIQUE INDEX IF NOT EXISTS services_name_key ON services (name);

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
                CONSTRAINT bookings_status_check
                CHECK (status IN ('pending_payment',          -- [DEVIATION 7]
                                  'booked','verified','in_progress','completed',
                                  'no_show','rescheduled',
                                  'expired',                 -- [DEVIATION 7]
                                  'cancelled_by_customer',   -- [DEVIATION 2]
                                  'cancelled_by_salon')),
  amount        integer NOT NULL,              -- paise, goes to salon
  rzp_order_id  text,
  rzp_payment_id text,
  verify_code   char(6),
  hold_expires_at     timestamptz,             -- [DEVIATION 7] pending_payment only
  reschedule_deadline timestamptz,             -- no_show / cancel + 36h
  reschedule_count    smallint NOT NULL DEFAULT 0,   -- [DEVIATION 8] §10 Q2, cap of 1
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

-- [DEVIATION 7] status 'pending_payment' + 'expired', bookings.hold_expires_at
--   §4 is `pay -> booking created, slots locked`, which holds nothing during
--   payment. Two customers open checkout on the last chair, both pay, and one
--   gets SLOT_UNAVAILABLE after their money has already moved. createBooking is
--   correct — it never double-books — but correctness was costing a refund
--   instead of a rejection.
--
--   A 'pending_payment' booking consumes a chair with a TTL. It is confirmed by
--   the checkout callback or the webhook, whichever arrives first, and swept to
--   'expired' if neither does. Both the availability read
--   (src/availability/repo.ts) and the advisory-lock re-check
--   (src/booking/create.ts) count a hold only while hold_expires_at > now().
--   'expired' is a distinct terminal state rather than a delete, so a customer
--   whose payment landed one second late has an audit trail.

-- [DEVIATION 8] bookings.reschedule_count
--   §10 open question 2 recommends capping reschedules at 1. The chain of
--   rescheduled_from links already records history, but walking it recursively
--   on every booking write is a self-join on the hot path. One counter, carried
--   forward from the booking being replaced.

CREATE INDEX IF NOT EXISTS bookings_customer_idx ON bookings (customer_id, start_at DESC);

-- [DEVIATION 12] one live code per salon.
--   The code is what a barber types to check somebody in, so two live bookings
--   at one salon sharing six digits would let the wrong customer be verified.
--   Partial: history keeps its codes, and a finished booking must not reserve
--   a number forever. See db/migrations/009_unique_verify_codes.sql.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_live_verify_code_idx
  ON bookings (salon_id, verify_code)
  WHERE verify_code IS NOT NULL
    AND status IN ('pending_payment','booked','verified','in_progress');

-- The hold sweeper's only query. Partial, so it stays tiny regardless of how
-- many bookings exist.
CREATE INDEX IF NOT EXISTS bookings_hold_idx
  ON bookings (hold_expires_at) WHERE status = 'pending_payment';

-- The refund worker's only query.
CREATE INDEX IF NOT EXISTS bookings_refund_pending_idx
  ON bookings (cancelled_at) WHERE refund_status = 'pending';

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

-- ---------- money ----------
--
-- Mirrors db/migrations/003_payments.sql, which carries the same tables to a
-- database that already has data. Read that file for the reasoning; this one is
-- kept terse so the whole schema still fits in one read.

CREATE TABLE IF NOT EXISTS payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  salon_id       uuid NOT NULL REFERENCES salons(id),
  customer_id    uuid NOT NULL REFERENCES users(id),
  -- The order exists before the customer sees the sheet; the payment id only
  -- once they pay. Both UNIQUE — a webhook replay must not create a second row
  -- for the same money.
  rzp_order_id   text NOT NULL UNIQUE,
  rzp_payment_id text UNIQUE,
  amount         integer NOT NULL CHECK (amount >= 0),   -- paise, gross
  currency       text NOT NULL DEFAULT 'INR',
  status         text NOT NULL DEFAULT 'created'
                 CHECK (status IN ('created','authorized','captured','failed',
                                   'refunded','partially_refunded')),
  method         text,                                   -- upi / card / netbanking
  error_code     text,
  error_description text,
  -- Set once, by whichever of the checkout callback and the webhook wins.
  captured_at    timestamptz,
  refunded_amount integer NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (refunded_amount <= amount)
);
CREATE INDEX IF NOT EXISTS payments_booking_idx ON payments (booking_id);
CREATE INDEX IF NOT EXISTS payments_salon_idx   ON payments (salon_id, created_at DESC);

CREATE TABLE IF NOT EXISTS refunds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id     uuid NOT NULL REFERENCES payments(id),
  booking_id     uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  rzp_refund_id  text UNIQUE,
  amount         integer NOT NULL CHECK (amount > 0),
  reason         text NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','processing','processed','failed')),
  attempts       smallint NOT NULL DEFAULT 0,
  last_error     text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- One open refund per booking: a double-tap on [Close for today], or a webhook
-- replay, must not refund the customer twice.
CREATE UNIQUE INDEX IF NOT EXISTS refunds_one_open_per_booking
  ON refunds (booking_id) WHERE status <> 'failed';
CREATE INDEX IF NOT EXISTS refunds_due_idx
  ON refunds (next_attempt_at) WHERE status IN ('pending','processing');

-- Every movement of money, signed from the salon's point of view. Balance is
-- SUM(amount) — never a stored running total, because a total that drifts is
-- unrecoverable while a ledger can always be re-summed.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    uuid NOT NULL REFERENCES salons(id),
  booking_id  uuid REFERENCES bookings(id) ON DELETE SET NULL,
  payment_id  uuid REFERENCES payments(id),
  refund_id   uuid REFERENCES refunds(id),
  payout_id   uuid,                       -- FK added after payouts, below
  kind        text NOT NULL
              CHECK (kind IN ('sale','commission','refund','commission_reversal',
                              'payout','adjustment')),
  amount      integer NOT NULL,           -- signed paise
  currency    text NOT NULL DEFAULT 'INR',
  note        text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'adjustment' OR note IS NOT NULL)
);
-- Idempotency: the ledger write is the last step of a handler Razorpay may
-- deliver twice. These make the second delivery a no-op, not a double credit.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_payment_kind_idx
  ON ledger_entries (payment_id, kind) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_refund_kind_idx
  ON ledger_entries (refund_id, kind) WHERE refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_salon_idx ON ledger_entries (salon_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS payouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id     uuid NOT NULL REFERENCES salons(id),
  period_start date NOT NULL,
  period_end   date NOT NULL,            -- exclusive
  amount       integer NOT NULL CHECK (amount > 0),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','processing','paid','failed')),
  rzp_payout_id text UNIQUE,
  reference    text,
  failure_reason text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz,
  -- Re-running the payout job for a period must not cut a second cheque.
  UNIQUE (salon_id, period_start, period_end),
  CHECK (period_end > period_start)
);

DO $$ BEGIN
  ALTER TABLE ledger_entries
    ADD CONSTRAINT ledger_entries_payout_id_fkey
    FOREIGN KEY (payout_id) REFERENCES payouts(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Razorpay retries until it gets a 2xx and will re-deliver on its own. The
-- event id is the primary key, so the second delivery collides rather than
-- paying anyone twice. The raw payload is kept because reconciling a disputed
-- payment six weeks later without it is guesswork.
CREATE TABLE IF NOT EXISTS webhook_events (
  id           text PRIMARY KEY,          -- x-razorpay-event-id
  provider     text NOT NULL DEFAULT 'razorpay',
  event        text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'received'
               CHECK (status IN ('received','processed','failed','ignored')),
  attempts     smallint NOT NULL DEFAULT 0,
  error        text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS webhook_events_unprocessed_idx
  ON webhook_events (received_at) WHERE status IN ('received','failed');

-- Transactional outbox. Written in the same transaction as the booking it
-- describes, so there is no state where a booking exists and its confirmation
-- was never queued.
CREATE TABLE IF NOT EXISTS notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  booking_id   uuid REFERENCES bookings(id) ON DELETE CASCADE,
  channel      text NOT NULL CHECK (channel IN ('email','sms','whatsapp','push')),
  template     text NOT NULL,
  to_address   text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','sent','failed','skipped')),
  attempts     smallint NOT NULL DEFAULT 0,
  last_error   text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  dedupe_key   text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_due_idx
  ON notifications (next_attempt_at) WHERE status = 'pending';

-- POST /api/bookings on a flaky phone connection gets retried by the client.
-- The key makes the retry replay the first response instead of taking a second
-- chair and opening a second Razorpay order.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          text NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     text NOT NULL,
  request_hash text NOT NULL,
  status_code  smallint,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);

CREATE TABLE IF NOT EXISTS salon_strikes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id   uuid NOT NULL REFERENCES salons(id),
  booking_id uuid REFERENCES bookings(id),
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
