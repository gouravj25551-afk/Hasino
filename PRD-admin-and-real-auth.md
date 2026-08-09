# PRD — Real Google auth, empty database, and the Hasino Admin Panel

Written for Claude Code. Everything below is grounded in the current codebase;
file paths are real. Read `README.md` first for the architecture, then this.

---

## 1. Goal

Today the app is only usable through `DEV_AUTH=true`, which hands out fake
identities (Aarav, Priya) from seeded demo data. Anyone hitting the server can
act as anyone.

After this work:

- The database starts **empty of people and salons**. No demo users, no demo
  salons, no `dev:` identities.
- **Everyone signs in with Google.** Including on localhost.
- There are **two operator surfaces**, not one:
  - **Hasino Admin** (`/admin`) — the platform operator. Onboards salons,
    assigns owners, manages the service catalogue, approves and suspends.
  - **Salon Owner** (`/business`) — one salon's own dashboard. Already exists.
- A salon can also **apply self-serve** ("List your salon"), landing in the
  admin's approval queue rather than going live.

**Non-goal for this PRD:** Razorpay. Payments stay off (see §9).

---

## 2. The one hard constraint

> "Do not hardcode any role changes in the database."

This is the right instinct and it creates a real bootstrap problem: the first
admin cannot be created by an admin.

**Solution: `ADMIN_EMAILS` env var is the single source of truth for who is an
admin.**

```
ADMIN_EMAILS=gouravjain3107@gmail.com
```

On every sign-in, in `resolveSession` (`src/auth/session.ts`):

- token's email is verified **and** in `ADMIN_EMAILS` → role becomes `admin`
- user's stored role is `admin` but the email is **no longer** in the list →
  demote to `customer`

Both directions, every sign-in. A sticky `admin` row in the database that
outlives its env entry is exactly the thing that gets forgotten and then
exploited. The env var is the truth; the column is a cache of it.

**This requires `email_verified` on the token.** `VerifiedToken` in
`src/auth/verifier.ts` does not carry it today. Add it, populate it from
`decoded.email_verified` in `FirebaseVerifier`, and **refuse to elevate without
it**. An unverified email claim is not proof of anything.

Everything else — salon owners, salon approval, service catalogue — is an
authenticated action in the Admin Panel. No SQL, ever.

---

## 3. Roles

| Role | Gets | How they become it |
|---|---|---|
| `customer` | Browse, book, own bookings | Default for every new account. Never anything else. |
| `business` | `/business`, scoped to **their own** salon only | Admin assigns them a salon, **or** their self-serve application is submitted |
| `admin` | `/admin`, all salons | `ADMIN_EMAILS` only |

`users.role`'s CHECK constraint already permits all three. No migration needed
for the role itself.

### 3.1 Fix `requireRole`

`src/auth/session.ts` currently does:

```ts
const ok = session.role === role || (role === 'business' && session.role === 'admin');
```

An admin passing as `business` then hits `salonForOwner()`, which looks for a
salon the admin owns, finds none, and throws `ForbiddenError`. The superset is
a trap.

**Remove it.** Admin gets its own namespace. `requireRole(s, 'admin')` for
`/api/admin/*`, `requireRole(s, 'business')` for `/api/business/*`, and they do
not overlap.

### 3.2 How a salon owner's account gets created

**Do not invent a new mechanism — one already exists and works.**

`resolveSession` links a Google sign-in to an existing `users` row by **phone**,
via `INSERT ... ON CONFLICT (phone) DO UPDATE ... WHERE users.firebase_uid IS
NULL`. Crucially, that `DO UPDATE` sets `firebase_uid`, `name`, `email`,
`avatar_url` — **and does not touch `role`.**

So the flow is:

1. Admin creates a salon and enters the owner's **phone, name, email**.
2. The backend inserts a `users` row: that phone, `role = 'business'`, no
   `firebase_uid`.
3. The owner signs in with Google and links that same phone in the existing
   `428 PHONE_REQUIRED` step.
4. The row is adopted. `role` survives. They land on `/business` owning their
   salon.

Verify this is still true after any change to `resolveSession`. It is the
entire owner-onboarding mechanism and it is one `ON CONFLICT` clause.

---

## 4. What to delete

| Delete | Where | Note |
|---|---|---|
| Demo users + demo salons | `scripts/seed-demo.ts` | Replace, see §4.1 |
| Dev identity picker | `src/http/public/index.html` (`devPicker()`), `business.html` (`initIdentity`) | |
| `GET /api/dev/identities` | `src/http/server.ts` | CI only, see §5 |
| "DEV_AUTH is on" login screen | `src/http/public/views/login.js` | Always show the real Google screen |
| DEV_AUTH banner | `src/http/public/business.html` | |

### 4.1 Seed becomes a catalogue, not a cast

**Do not simply delete `seed-demo.ts`.** The `services` table is the
**global, admin-managed master list** (`services.name`, `services.category`)
that every `salon_services` row references. With it empty, an admin onboarding
their first salon has nothing to add to the menu, and the app is unusable.

Replace `scripts/seed-demo.ts` with `scripts/seed-catalog.ts`:

- Inserts **only** `services` rows — a sensible Indian salon catalogue:
  Haircut, Beard Trim, Shave, Hair Colour, Head Massage, Facial, Threading,
  Waxing, Manicure, Pedicure, Hair Spa, Bridal Makeup. Categories:
  `hair`, `beard`, `skin`, `nails`, `spa`, `bridal`.
- Inserts **zero** users, **zero** salons.
- `ON CONFLICT DO NOTHING` on name — safe to re-run, and it must **not**
  `TRUNCATE` anything. The current seed truncates every table in the database;
  that behaviour must not survive into something a person might run against
  real data.
- Admin can add more categories/services later (§6.4).

Update `package.json` (`db:seed`), `scripts/dev.sh`, and `.github/workflows/ci.yml`
accordingly.

---

## 5. DEV_AUTH becomes CI-only

Keep the mechanism, make it impossible to reach by accident.

In `src/http/server.ts`:

```ts
const DEV_AUTH = process.env['DEV_AUTH'] === 'true' && process.env['CI_SMOKE'] === 'true';
```

- `DEV_AUTH=true` alone (a developer's laptop) → **ignored**, with a loud
  `log.warn` saying it now needs `CI_SMOKE=true` and that local development
  uses real Google sign-in.
- Production already refuses to boot on `DEV_AUTH`. Extend that check to
  `CI_SMOKE` too — neither may ever be set with `NODE_ENV=production`.
- `/api/dev/identities` and `/api/dev/pay` stay gated behind the combined flag.

### 5.1 CI needs fixtures now that seed is empty

`scripts/smoke.ts` currently depends on seeded salons and dev identities. With
an empty database it has nothing to run against.

Add `scripts/ci-fixture.ts`, run only in CI, before the smoke test:

- Inserts one admin user, one owner user, one active salon with hours and
  services — directly via SQL, in the style of `test/db.ts`'s `seed()`.
- Uses `dev:` firebase_uids so `x-dev-user` works.
- Refuses to run unless `CI_SMOKE=true`, and hard-refuses if `NODE_ENV=production`.

This keeps test scaffolding out of the product. Nothing in `src/` should know
it exists.

### 5.2 Local dev now needs Firebase config

`scripts/dev.sh` must load `.env` (Node 22 supports `--env-file=.env`) and, if
`FIREBASE_WEB_API_KEY` is missing, print the exact Firebase console steps and
stop rather than starting a server where sign-in silently fails.

Also update the script's closing message: no more "pick an identity from the
dropdown".

---

## 6. The Admin Panel

New surface at `/admin`, served like the others from
`src/http/public/admin.html`. Follow the existing conventions: single inline
file like `business.html`, hash routing, the same `brand.css` tokens.

All endpoints under `/api/admin/*`, all behind `requireRole(s, 'admin')`, all
in a new `src/http/routes-admin.ts` mirroring `routes-business.ts`. Reads and
writes in a new `src/admin/repo.ts`.

### 6.1 Salons — list and filter

`GET /api/admin/salons?status=&city=&q=&limit=`

Returns every salon regardless of status (unlike the public `listSalons`, which
filters `status = 'active'`). Each row: id, name, city, area, address, status,
owner name/phone/email, whether the owner has signed in yet
(`firebase_uid IS NOT NULL`), service count, booking count, `commission_bps`,
`created_at`, `approved_at`.

`GET /api/admin/cities` → distinct cities with counts, for the filter dropdown.

**Screen:** a table with status tabs (Pending / Active / Suspended / All), a
city dropdown, and a search box. Pending count badge in the nav — it is the
admin's actual inbox.

### 6.2 Onboard a salon

`POST /api/admin/salons`

```jsonc
{
  "name": "Sharma Hair Studio",
  "address": "12 MG Road, Indiranagar",
  "city": "Bengaluru",
  "area": "Indiranagar",
  "lat": 12.97, "lng": 77.59,
  "timezone": "Asia/Kolkata",     // default
  "commissionBps": 1500,           // default from PLATFORM_COMMISSION_BPS
  "status": "pending",             // or "active" to go live immediately
  "owner": {
    "phone": "+919876543210",      // required, E.164
    "name": "Rahul Sharma",
    "email": "rahul@example.com"
  }
}
```

One transaction:

1. Upsert the owner `users` row **by phone**. If the phone already exists and
   belongs to a `customer` with no salon, promote to `business`. If it already
   owns a different salon, **reject with 409** — one owner, one salon, until
   there is a reason otherwise.
2. Insert the salon with `owner_id`, `onboarded_by = admin.userId`.
3. Insert seven `salon_hours` rows with sensible defaults
   (10:00–20:00, `online_capacity` 1, `slot_interval_min` 30) so the salon is
   never in the broken state of "active with no hours", which renders as
   permanently closed with no explanation.

**Validation that matters:** phone must be E.164 (`^\+[1-9]\d{7,14}$`), lat in
[-90, 90], lng in [-180, 180], timezone must be a real IANA zone — reject with
400 rather than storing a value that makes `zonedTimeToUtc` throw on every
availability request.

`PUT /api/admin/salons/:id` — edit the same fields. Changing hours or services
must `cache.invalidate(salonId)`, same as `routes-business.ts` does.

### 6.3 Approve / activate / deactivate

`POST /api/admin/salons/:id/status` → `{ "status": "active", "reason": "..." }`

Legal transitions:

```
pending    → active | banned
active     → suspended | banned
suspended  → active | banned
banned     → (terminal)
```

Reject anything else with 409, the way `booking/status.ts` does — a state
machine written down beats four `if`s scattered across a route file.

**Two things that must happen on deactivation, and are easy to miss:**

1. `createBooking` already rejects a non-`active` salon
   (`SalonUnavailableError`), so no new bookings. Good.
2. **Existing future bookings are not touched.** Suspending a salon with
   fourteen bookings tomorrow leaves fourteen customers turning up at a salon
   the platform has switched off. The endpoint must take
   `cancelFutureBookings: boolean` and, when true, reuse
   `closeForDay`-style logic to cancel them as `cancelled_by_salon` with
   refunds queued. Default `false`, but the UI must ask, showing the count.

Every transition writes a `salon_status_events` row (§7). "Why is this salon
suspended" is a question that gets asked six weeks later.

### 6.4 Service catalogue

The global `services` list is admin-managed and shared by every salon.

- `GET /api/admin/services` — catalogue with per-service usage count
- `POST /api/admin/services` — `{ name, category }`, unique on name
- `DELETE /api/admin/services/:id` — **only if no `salon_services` reference
  it**; otherwise 409. A hard delete here would cascade into `booking_items`
  and rewrite history.

### 6.5 A salon's menu, from the admin side

`GET/PUT/DELETE /api/admin/salons/:id/services[/:serviceId]`

Same shape as `/api/business/services`, but the salon comes from the URL rather
than from `salonForOwner`. Reuse `upsertService` / `deactivateService` /
`listServiceSetup` in `src/business/repo.ts` — they already take a `salonId`
argument and have no notion of who is calling. Do not fork them.

Same for hours: `GET/PUT /api/admin/salons/:id/hours[/:weekday]` over
`saveHours`.

### 6.6 Salon detail

`GET /api/admin/salons/:id` — everything on one screen: profile, owner and
whether they have signed in, services, hours, last 20 bookings, ledger balance
(`salonBalance` from `src/payments/ledger.ts`), status history.

### 6.7 Overview

`GET /api/admin/overview` — pending applications, active salons, salons with no
services (onboarded but not set up — the ones that need chasing), bookings
today, GMV this month, owners who have not signed in yet.

---

## 7. Migration `004_admin_and_locations.sql`

Follow the conventions in `003_payments.sql`: idempotent, `BEGIN`/`COMMIT`,
`IF NOT EXISTS` everywhere, comments explaining *why*. Also mirror the changes
into `db/schema.sql` — CI asserts the two have not drifted.

```sql
-- Location. The spec's schema has lat/lng and a free-text address, which is
-- enough to sort by distance and useless for "show me every salon in Pune".
-- City and area are what an operator filters by; lat/lng stay the source of
-- truth for distance.
ALTER TABLE salons ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE salons ADD COLUMN IF NOT EXISTS area text;
ALTER TABLE salons ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE salons ADD COLUMN IF NOT EXISTS email text;

CREATE INDEX IF NOT EXISTS salons_city_idx ON salons (city, status);

-- Audit. Who onboarded this salon, who approved it, when.
ALTER TABLE salons ADD COLUMN IF NOT EXISTS onboarded_by uuid REFERENCES users(id);
ALTER TABLE salons ADD COLUMN IF NOT EXISTS approved_by  uuid REFERENCES users(id);
ALTER TABLE salons ADD COLUMN IF NOT EXISTS approved_at  timestamptz;

-- One owner, one salon. Enforced in the database rather than only in the
-- route, because salonForOwner() does `WHERE owner_id = $1` and takes
-- rows[0] — a second salon under one owner would not error, it would
-- silently pick one of them, and which one depends on planner mood.
CREATE UNIQUE INDEX IF NOT EXISTS salons_one_per_owner ON salons (owner_id);

-- Why a salon is in the state it is in.
CREATE TABLE IF NOT EXISTS salon_status_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id   uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  reason      text,
  actor_id    uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS salon_status_events_salon_idx
  ON salon_status_events (salon_id, created_at DESC);
```

> **Check `salons_one_per_owner` against existing data before adding it.** If
> any environment already has two salons under one owner the index will fail to
> build. On an empty database this is free.

---

## 8. Self-serve "List your salon"

Reachable from the customer app for any signed-in user with no salon.

`POST /api/salons/apply` — same body as §6.2 minus the `owner` block (the
applicant is the owner) and minus `status` (always `pending`).

- Creates the salon as `pending` and sets the applicant's role to `business`.
- **This is safe**: `business` only ever grants access to
  `salonForOwner(ownerId)`, which is their own pending salon. They can set up
  their menu and hours while they wait. `listSalons` filters
  `status = 'active'`, so nothing is publicly visible until an admin approves.
- Rejects with 409 if they already own a salon.
- Enqueues a notification to `ADMIN_EMAILS` via the existing outbox
  (`src/notify/outbox.ts` + a new `salon_application` template). An approval
  queue nobody is told about is a queue nobody empties.

`/business` must render a clear pending state — "Your salon is under review" —
rather than an empty Today screen that looks broken.

---

## 9. Payments stay off

`paymentsConfigFromEnv` currently ties `enabled` to `devAuth`. With DEV_AUTH
gone locally, that silently disables payments — the right outcome, reached by
accident, which will be re-broken the moment someone edits that line.

Make it explicit:

```ts
enabled: Boolean(keyId && keySecret)
```

and add `ALLOW_UNPAID_BOOKINGS=true` for local use. Then:

- Keys present → hold + Razorpay, unchanged.
- No keys + `ALLOW_UNPAID_BOOKINGS=true` → `POST /api/bookings` creates a
  `booked` row directly (`holdTtlMs: 0`), response carries
  `paid: false` and the existing warning string.
- No keys, no flag → `503 PAYMENTS_DISABLED`. Silently free bookings are worse
  than a clear error.
- `NODE_ENV=production` with `ALLOW_UNPAID_BOOKINGS=true` → **refuse to boot**,
  alongside the existing Razorpay checks in `start()`.

The customer UI must not show a Pay button when `/api/config` reports
`razorpay.enabled === false` — it should book directly and say payment is not
enabled on this deployment.

---

## 10. Security requirements

These are the ones that will actually bite.

1. **`/api/admin/*` is `requireRole(s, 'admin')` on every route**, checked
   before the body is parsed — the same ordering `POST /api/bookings` already
   uses.
2. **`GET /admin` (the HTML) is public; the data is not.** Serving the shell to
   anyone is fine and matches `/business`. Every byte of data behind it must be
   authorised server-side. Do not rely on the page hiding a nav link.
3. **Never accept a role from the client.** Not in a body, not in a header, not
   in a token claim. `ADMIN_EMAILS` and admin-authenticated actions only.
4. **Admin actions are audited.** `salon_status_events.actor_id`,
   `salons.onboarded_by`, `salons.approved_by`.
5. **Rate-limit `/api/salons/apply`** — it creates rows for any signed-in user.
   Reuse the `limits.booking` bucket pattern in `src/http/server.ts`.
6. **`ADMIN_EMAILS` is compared lowercased and trimmed**, and only against a
   `email_verified` token.
7. `.env` must be in `.gitignore` — it is; keep it that way when adding
   `ADMIN_EMAILS`.

---

## 11. Testing

**Required new tests.** Follow the existing pattern: pure tests run anywhere,
DB tests skip without Postgres.

`test/admin.test.ts`

- A customer cannot reach any `/api/admin/*` route → 403
- A business owner cannot reach any `/api/admin/*` route → 403
- An admin **cannot** reach `/api/business/*` (the superset is gone)
- Email in `ADMIN_EMAILS` → role `admin` on sign-in
- Email removed from `ADMIN_EMAILS` → demoted back to `customer` on next sign-in
- Email in `ADMIN_EMAILS` but `email_verified === false` → **not** elevated
- Onboarding a salon creates the owner row with `role = 'business'` and no
  `firebase_uid`
- That owner then signing in with Google **adopts the row and keeps
  `business`** — this is the whole mechanism, test it directly
- A second salon for the same owner → 409
- Illegal status transition (`banned → active`) → 409
- Suspending with `cancelFutureBookings: true` cancels them and queues refunds
- A pending salon does **not** appear in `listSalons`
- Approving it does

`test/apply.test.ts`

- Applying creates a `pending` salon and promotes the applicant to `business`
- Applying twice → 409
- The applicant can edit their pending salon's services but nothing else's

**Update:** `scripts/smoke.ts` and `.github/workflows/ci.yml` for
`ci-fixture.ts` and the catalogue seed. `npm test` and `npm run typecheck` must
stay green.

---

## 12. Acceptance criteria

Done when all of these are true on a **fresh, empty database**:

1. `npm run dev` starts with real Google auth. There is no identity dropdown
   anywhere.
2. `DEV_AUTH=true npm run dev` (without `CI_SMOKE`) starts with auth **on** and
   logs a warning explaining why.
3. Signing in with the `ADMIN_EMAILS` Google account lands on a working
   `/admin`. Signing in with any other Google account does not — 403.
4. From `/admin`, onboarding a salon with a name, address, city, lat/lng and an
   owner phone produces a salon with seven default hour rows and a
   `business` user who has never signed in.
5. Signing in with that owner's Google account (linking that phone) lands on
   `/business` owning that salon, with no SQL run at any point.
6. A `pending` salon is invisible in the customer app; approving it makes it
   appear; suspending it makes it disappear.
7. Admin can add a service to the global catalogue and then to a salon's menu,
   and it appears in that salon's customer-facing page.
8. Filtering `/admin` by city returns only that city's salons.
9. A customer can book end-to-end. With no Razorpay keys and
   `ALLOW_UNPAID_BOOKINGS=true` the booking is created `booked` and marked
   unpaid; there is no Pay button.
10. `npm test`, `npm run typecheck` and CI are green.
11. `grep -ri "aarav\|priya\|Sharma Hair" src/ scripts/ db/` returns nothing.

---

## 13. Out of scope — and why

**Staff / stylist management.** The salon owner dashboard cannot show "staff"
without a staff model, and adding one is not a screen — it is a rewrite of the
availability engine. `salon_hours.online_capacity` is a count of chairs, and
`src/availability/engine.ts` treats every chair as interchangeable: a slot is
free if `booked < capacity`. Named staff means per-person calendars, per-person
service menus, "book with Ravi specifically", and a booking that must hold *a
named person's* time rather than one of N slots. That touches `engine.ts`,
`repo.ts`, `create.ts`, the slot ledger, and the whole booking UI. It is its own
PRD. Ship operator onboarding first.

**Razorpay live keys, KYC, payouts.** Covered in `DEPLOY.md`. Unblocked by
business-entity paperwork, not by code.

**Multi-salon owners / chains.** `salons_one_per_owner` deliberately forbids it.
When a chain shows up, the answer is an `organisations` table, not dropping the
index.

**Admin editing bookings or refunding manually.** Read-only booking view for
now. A manual refund button that bypasses the §4 state machine is how a ledger
stops reconciling.

---

## 14. Suggested build order

Each step leaves the app working and testable.

1. Migration 004 + mirror into `schema.sql`
2. `ADMIN_EMAILS` elevation + `email_verified` on the token + `requireRole` fix,
   with tests
3. DEV_AUTH → `CI_SMOKE`; `ci-fixture.ts`; CI green again
4. `seed-catalog.ts`; delete demo data; `dev.sh` loads `.env`
5. `src/admin/repo.ts` + `src/http/routes-admin.ts` — salons list, onboard,
   status
6. `admin.html` — overview, salon list with filters, onboard form, salon detail
7. Service catalogue + per-salon menu/hours from admin
8. Self-serve apply + the `/business` pending state
9. Payments `enabled` flag + `ALLOW_UNPAID_BOOKINGS` guard + UI
10. Update `README.md` and `DEPLOY.md`
