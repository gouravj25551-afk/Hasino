-- 003_payments.sql — Razorpay, the payment hold, the money ledger.
--
-- Idempotent: safe to re-run. Apply after 002_marketplace.sql.
--
-- Why the hold exists
-- -------------------
-- §4 is `pay -> booking created, slots locked`. Nothing holds the chair during
-- payment, so two customers can both open checkout on the last chair, both pay,
-- and one gets SLOT_UNAVAILABLE *after* their money moved. createBooking is
-- correct — it never double-books — but correctness was costing a refund
-- instead of a rejection.
--
-- A 'pending_payment' booking consumes a chair with a TTL. Confirmed by the
-- checkout callback or the webhook; swept back to 'expired' if neither lands.
-- Both the availability read (src/availability/repo.ts) and the advisory-lock
-- re-check (src/booking/create.ts) count a hold only while it is unexpired.

BEGIN;

-- ---------- bookings: the hold ----------

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending_payment','booked','verified','in_progress','completed',
                    'no_show','rescheduled','expired',
                    'cancelled_by_customer','cancelled_by_salon'));

-- When a pending_payment hold stops consuming a chair. NULL for every other
-- status — the partial index below depends on that.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz;

-- §10 open question 2: "reschedule more than once?" The spec recommends a cap
-- of 1. Enforcing it needs a counter that survives the chain of rescheduled_from
-- links, because walking that chain on every write is a recursive query on the
-- booking hot path.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reschedule_count smallint NOT NULL DEFAULT 0;

-- The sweeper's only query: expired holds, oldest first. Partial, so it stays
-- tiny no matter how many bookings exist.
CREATE INDEX IF NOT EXISTS bookings_hold_idx
  ON bookings (hold_expires_at)
  WHERE status = 'pending_payment';

-- The refund worker's only query.
CREATE INDEX IF NOT EXISTS bookings_refund_pending_idx
  ON bookings (cancelled_at)
  WHERE refund_status = 'pending';

-- ---------- salons: commission ----------

-- Basis points of the booking amount the platform keeps. Per-salon because
-- launch deals and category pricing are the norm; the default comes from
-- PLATFORM_COMMISSION_BPS at insert time, not from application code reading a
-- constant on every sale.
ALTER TABLE salons ADD COLUMN IF NOT EXISTS commission_bps smallint NOT NULL DEFAULT 1500
  CONSTRAINT salons_commission_bps_check CHECK (commission_bps BETWEEN 0 AND 10000);

-- Where the salon's money is settled to. Razorpay Route linked-account id once
-- Route is enabled; until then payouts are reconciled off the ledger manually.
ALTER TABLE salons ADD COLUMN IF NOT EXISTS rzp_route_account_id text;
ALTER TABLE salons ADD COLUMN IF NOT EXISTS payout_beneficiary jsonb;

-- ---------- payments ----------

CREATE TABLE IF NOT EXISTS payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  salon_id       uuid NOT NULL REFERENCES salons(id),
  customer_id    uuid NOT NULL REFERENCES users(id),

  -- Razorpay's order is created before the customer sees the sheet; the payment
  -- id only exists once they actually pay. Both unique: a webhook replay must
  -- not be able to create a second row for the same money.
  rzp_order_id   text NOT NULL UNIQUE,
  rzp_payment_id text UNIQUE,

  amount         integer NOT NULL CHECK (amount >= 0),   -- paise, gross
  currency       text NOT NULL DEFAULT 'INR',
  status         text NOT NULL DEFAULT 'created'
                 CHECK (status IN ('created','authorized','captured','failed',
                                   'refunded','partially_refunded')),
  method         text,               -- upi / card / netbanking / wallet
  error_code     text,
  error_description text,

  -- Set the first time a captured signal is accepted, from either the checkout
  -- callback or the webhook — whichever wins the race.
  captured_at    timestamptz,
  refunded_amount integer NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (refunded_amount <= amount)
);

CREATE INDEX IF NOT EXISTS payments_booking_idx ON payments (booking_id);
CREATE INDEX IF NOT EXISTS payments_salon_idx   ON payments (salon_id, created_at DESC);

-- ---------- refunds ----------
--
-- §4 promises "Full refund, auto" for [Close for today] and for a customer who
-- arrives at a shut shop. A refund is an async external call that can fail, so
-- it needs its own row with attempts and a backoff — not a boolean on bookings.

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

-- One open refund per booking. A double-tap on [Close for today] or a webhook
-- replay must not refund the customer twice.
CREATE UNIQUE INDEX IF NOT EXISTS refunds_one_open_per_booking
  ON refunds (booking_id) WHERE status <> 'failed';

CREATE INDEX IF NOT EXISTS refunds_due_idx
  ON refunds (next_attempt_at) WHERE status IN ('pending','processing');

-- ---------- the ledger ----------
--
-- Every movement of money, signed from the salon's point of view. The salon's
-- balance is SUM(amount) — never a mutable running total, because a running
-- total that drifts is unrecoverable while a ledger can always be re-summed.
--
--   sale        + booking amount        (customer paid)
--   commission  - platform's cut        (what Hasino keeps)
--   refund      - amount returned
--   commission_reversal + cut given back on that refund
--   payout      - money actually sent to the salon
--   adjustment  ± manual correction, always with a note

CREATE TABLE IF NOT EXISTS ledger_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    uuid NOT NULL REFERENCES salons(id),
  booking_id  uuid REFERENCES bookings(id) ON DELETE SET NULL,
  payment_id  uuid REFERENCES payments(id),
  refund_id   uuid REFERENCES refunds(id),
  payout_id   uuid,
  kind        text NOT NULL
              CHECK (kind IN ('sale','commission','refund','commission_reversal',
                              'payout','adjustment')),
  amount      integer NOT NULL,        -- signed paise
  currency    text NOT NULL DEFAULT 'INR',
  note        text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'adjustment' OR note IS NOT NULL)
);

-- Idempotency. Writing the ledger is the last step of a webhook handler that
-- Razorpay may deliver more than once; these indexes make the second delivery
-- a no-op instead of double-crediting a salon.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_payment_kind_idx
  ON ledger_entries (payment_id, kind) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_refund_kind_idx
  ON ledger_entries (refund_id, kind) WHERE refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_salon_idx ON ledger_entries (salon_id, occurred_at DESC);

-- ---------- payouts ----------

CREATE TABLE IF NOT EXISTS payouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id     uuid NOT NULL REFERENCES salons(id),
  period_start date NOT NULL,
  period_end   date NOT NULL,          -- exclusive
  amount       integer NOT NULL CHECK (amount > 0),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','processing','paid','failed')),
  rzp_payout_id text UNIQUE,
  reference    text,
  failure_reason text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz,
  -- Re-running the payout job for a period must not create a second payout.
  UNIQUE (salon_id, period_start, period_end),
  CHECK (period_end > period_start)
);

ALTER TABLE ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_payout_id_fkey;
ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_payout_id_fkey
  FOREIGN KEY (payout_id) REFERENCES payouts(id);

-- ---------- webhook inbox ----------
--
-- Razorpay retries a webhook until it gets a 2xx, and will happily deliver the
-- same event twice on its own. The event id is the primary key, so the second
-- delivery collides instead of paying anyone twice. The raw payload is kept
-- because reconciling a disputed payment six weeks later without it is guesswork.

CREATE TABLE IF NOT EXISTS webhook_events (
  id           text PRIMARY KEY,       -- x-razorpay-event-id
  provider     text NOT NULL DEFAULT 'razorpay',
  event        text NOT NULL,          -- payment.captured, refund.processed, ...
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

-- ---------- notification outbox ----------
--
-- Written in the same transaction as the booking it describes, so there is no
-- state where a booking exists and its confirmation was never queued. A worker
-- drains it. dedupe_key stops a retried request from sending a second email.

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

-- ---------- idempotency ----------
--
-- POST /api/bookings on a flaky phone connection is retried by the client. The
-- key makes the retry return the first response instead of taking a second
-- chair and opening a second Razorpay order.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         text NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL,
  request_hash text NOT NULL,
  status_code smallint,
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint, key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);

COMMIT;
