# Hasino

Salon booking marketplace. The availability engine, booking create, Razorpay
payments, the money ledger, and two web surfaces over them.

Clerk (Google sign-in, one step, no phone number) and Razorpay
are both implemented. A booking now holds a chair while the customer pays and
only becomes real once the money is verified — see
[the payment hold](#the-payment-hold) for why that ordering matters.

## Run it

```bash
npm run dev
```

Creates the database, applies the schema and migrations, loads the service
catalogue, and starts on :3000 with file watching. It checks Node, Postgres and
your Clerk config first, and stops with the exact console steps if anything
is missing.

**The database starts empty of people and salons.** There is no demo data and
no identity dropdown: local development signs in with Google exactly the way
production does, so a sign-in bug is found here rather than on the first
deploy. You need a Clerk application and a `.env` — `npm run dev` prints the
steps. Set `ADMIN_EMAILS` to your own Google address, then `npm run admin` for
the private panel on `127.0.0.1:4000`,
where you onboard the first salon.

The long way, if you prefer it:

```bash
npm install
createdb hasino_dev
DATABASE_URL=postgres://localhost:5432/hasino_dev npm run db:migrate         # schema + migrations
DATABASE_URL=postgres://localhost:5432/hasino_dev npm run db:seed   # catalogue only
DATABASE_URL=postgres://localhost:5432/hasino_dev npm start
```

`db:seed` loads the twelve-service global catalogue and nothing else. It
creates no users and no salons, truncates nothing, and is safe to re-run.

**No payment provider is configured yet, and that is a supported state.**
`PAYMENTS_PROVIDER` is `razorpay` when `RAZORPAY_KEY_ID` and
`RAZORPAY_KEY_SECRET` are set, and `none` otherwise; setting it to `none`
explicitly stops payments without deleting a credential.

With `none`, a booking is created `booked` and `paid: false`, holding a real
chair with no money attached, and both the response and the UI say so — the
customer is told online payment is coming and to pay at the salon. The
completion OTP still gates service and the ledger still records what a salon is
owed. Nothing pretends a payment succeeded, and no card details are collected
or stored.

Adding Razorpay, Cashfree or anyone else is a new `RazorpayClient`
implementation plus a value in `PaymentProvider` — the rest of the system asks
`payments.provider`, never a key.

`db/schema.sql` is the whole schema — the baseline. The numbered files in
`db/migrations/` are deltas on top of it, so `001` starts with `ALTER TABLE
users` and needs the baseline to exist first. One command covers both cases:

```bash
npm run db:migrate           # schema.sql if the database is empty, then outstanding migrations
npm run db:migrate:status    # show what would run, change nothing
```

Each migration is idempotent, runs in a transaction, and is recorded in
`schema_migrations` with a checksum — editing one that has already run is
refused rather than silently producing two different schemas.

Three surfaces:

| | |
|---|---|
| `localhost:3000` | **Customer** — browse, pick services, book, my bookings |
| `localhost:3000/business` | **Salon owner** — one salon's services, timings, today, money |
| `127.0.0.1:4000` | **Hasino admin** — a *separate process* (`npm run admin`), never deployed. Approve or reject applications, manage salons and the catalogue. The public app has no admin route, asset or API. |

All three sign in with Google. The two public pages are served to anyone; every byte of
data behind it is authorised server-side, so the panels never rely on a hidden
nav link.

**Who is an admin is `ADMIN_EMAILS`, and only `ADMIN_EMAILS`.** It is re-derived
on every sign-in in both directions: a verified address in the list is promoted,
a stored admin without that proof is demoted. The column is a cache of the env
var, not a second source of truth — a sticky `admin` row that outlives its entry
is exactly the thing that gets forgotten and then exploited. Elevation needs a
*verified* email; an unverified claim is a string the person signing up chose.

Roles do not nest. An admin cannot use `/api/business/*` and an owner cannot use
`/api/admin/*`. An admin acts on a salon through `/api/admin/salons/:id`, where
the salon is named explicitly.

### How a salon gets onto Hasino

No SQL, either way:

1. **Admin onboards it** — the private admin panel → Onboard. Creates the salon plus a `users`
   row with `role='business'` and no `auth_provider_id`. The owner then signs in
   with Google using the email address the admin recorded, and the row is
   adopted with its role intact. `claimByEmail()` in `resolveSession` is the
   whole mechanism — which is why owner email is required at onboarding, and
   must be their actual Google address.
2. **The salon applies** — a signed-in customer uses "List your salon". Lands as
   `pending`, invisible to customers, and emails `ADMIN_EMAILS`. They can set up
   their menu and hours while they wait.

`DEV_AUTH` no longer works on a laptop. It requires `CI_SMOKE=true` alongside
it and exists for the smoke harness, which has no browser to sign in with. Set
alone it is ignored and the server says so.

```bash
npm run smoke   # end-to-end checks against a running server, payments included
```

These are web surfaces standing in for what the spec plans as React Native
(customer) and Next.js (business). The API underneath is the same either way.

```bash
npm test        # 97 tests
npm run typecheck
```

`npm test` passes `--test-concurrency=1` deliberately: the DB-backed suites
share one database and truncate it, so running the files in parallel makes them
wipe each other's fixtures.

Database-backed tests skip (not fail) without Postgres, so the pure engine tests
run anywhere.

## API

Authenticated routes take `Authorization: Bearer <Clerk session token>`. Browsing
is public. Under `DEV_AUTH=true` an `x-dev-user` header naming a `auth_provider_id`
stands in, so the local consoles work without a Clerk application.

`GET /api/config` serves the client Clerk config (apiKey, authDomain,
projectId, appId) from server env — not secret, but not hardcoded either.

Customer:

| | | |
|---|---|---|
| `GET` | `/api/salons?q=&lat=&lng=&category=` | browse — `lat`/`lng` sort by distance, `category` filters by service category |
| `GET` | `/api/salons/:id` | services, hours, rating, `openNow`/`closesAt` |
| `POST` | `/api/salons/:id/availability` | `{serviceIds}` → 7-day window |
| `POST` | `/api/bookings` | **holds a chair** and opens a Razorpay order → 201, or **409** `SLOT_UNAVAILABLE`. Honours `Idempotency-Key`. |
| `POST` | `/api/bookings/:id/checkout` | re-open checkout for a hold that is still live |
| `POST` | `/api/bookings/:id/confirm` | the signed checkout callback → 200 booked, or **202** paid-too-late (refund queued) |
| `POST` | `/api/me/bookings/:id/cancel` | customer-owned cancel, reuses the §4 state machine |
| `POST` | `/api/me/bookings/:id/reschedule` | §4's 36-hour move, no extra charge |
| `GET` | `/api/me` | the signed-in user |
| `GET` | `/api/me/bookings` | verify code appears 15 min before the slot |
| `GET/POST/DELETE` | `/api/me/favorites[/:salonId]` | saved salons |

Unauthenticated, and not for humans:

| | | |
|---|---|---|
| `POST` | `/api/webhooks/razorpay` | signature-verified over the raw body, idempotent on the event id |
| `GET` | `/healthz` | liveness — no database call, on purpose |
| `GET` | `/readyz` | readiness — checks Postgres |

Self-serve:

| | | |
|---|---|---|
| `POST` | `/api/salons/apply` | list your salon — lands `pending`, notifies `ADMIN_EMAILS` |

Admin — `requireRole(s, 'admin')` on every route, checked before the body is
parsed. The salon is named in the URL, unlike the owner panel:

| | | |
|---|---|---|
| `GET` | `/api/admin/overview` | the inbox: pending, live, unset-up, GMV |
| `GET` | `/api/admin/salons?status=&city=&q=` | every status, pending first |
| `GET` | `/api/admin/cities` | for the filter |
| `POST` | `/api/admin/salons` | onboard: salon + owner + 7 days of hours |
| `GET/PUT` | `/api/admin/salons/:id` | detail: owner, menu, hours, ledger, history |
| `POST` | `/api/admin/salons/:id/status` | the state machine, + `cancelFutureBookings` |
| `GET/PUT/DELETE` | `/api/admin/salons/:id/{services,hours}[/:id]` | reuses the owner panel's writes |
| `GET/POST/DELETE` | `/api/admin/services[/:id]` | the global catalogue |

A salon's status machine: `pending → active | banned`, `active → suspended |
banned`, `suspended → active | banned`, and **`banned` is terminal**. Anything
else is a 409. Deactivating does not touch bookings already promised unless
asked — `createBooking` refuses a non-active salon so no *new* ones follow, but
suspending a salon with fourteen bookings tomorrow otherwise leaves fourteen
customers turning up at a shop the platform switched off.

Salon panel — every route resolves the salon from the signed-in owner, so a
`salonId` is never accepted from the client:

| | | Spec |
|---|---|---|
| `GET/PUT/DELETE` | `/api/business/services[/:id]` | §6.1 |
| `GET/PUT` | `/api/business/hours[/:weekday]` | §6.2 |
| `GET/POST/DELETE` | `/api/business/holidays[/:date]` | §6.2 |
| `GET` | `/api/business/bookings?date=` | §6.3, §6.4 |
| `POST` | `/api/business/bookings/:id/{verify,start,complete,no-show,cancel}` | §4 states |
| `POST` | `/api/business/close-today` | §6.5 |
| `GET` | `/api/business/{stats,reviews}` | §6.7 |
| `GET` | `/api/business/payouts` | §6.6 — balance, settlements and statement, all summed from the ledger |
| `GET` | `/api/business/earnings?days=` | daily net, in the salon's own timezone |

`node:http`, no framework. The spec picks NestJS, which is decorator-based and
needs a real compile step with `emitDecoratorMetadata` — it cannot run under
Node's type stripping. That is a fine trade later; making it now would mean a
build pipeline before there is an app. The engine is framework-agnostic, so
wrapping it in Nest touches only `src/http/server.ts`.

## Layout

```
db/schema.sql                 spec §5, applied and verified against Postgres 16
db/migrations/                idempotent ALTERs for an existing database
src/time/tz.ts                wall-clock <-> instant, DST-correct
src/availability/grid.ts      the bookable slot grid for one day
src/availability/engine.ts    the algorithm — pure, no I/O
src/availability/repo.ts      the 7-day window in 3 queries
src/availability/cache.ts     60s snapshot cache
src/availability/service.ts   7-day orchestration
src/booking/create.ts         advisory-lock booking create (+ the hold)
src/booking/occupancy.ts      the ONE definition of "holding a chair"
src/booking/sweep.ts          expired holds -> terminal
src/booking/reschedule.ts     §4's 36-hour move, atomically
src/payments/razorpay.ts      Razorpay over fetch, signatures, in-memory stub
src/payments/service.ts       checkout, capture, refunds — the money path
src/payments/webhook.ts       signature-verified, idempotent event inbox
src/payments/ledger.ts        balances, statement, payouts
src/notify/outbox.ts          transactional outbox
src/notify/dispatch.ts        the worker that drains it
src/notify/templates.ts       the six emails
src/workers/runner.ts         three loops over Postgres, advisory-locked
src/obs/logger.ts             structured logs, request ids, error reporter seam
src/auth/verifier.ts          Clerk token verification (swappable)
src/auth/session.ts           token -> users row, roles, provisioning
src/booking/status.ts         §4 state machine + close-for-day
src/salons/repo.ts            browse + detail, openNow, distance, favorites
src/admin/repo.ts             onboarding, status machine, catalogue, apply
src/business/repo.ts          the §6 panel's reads and writes
src/http/server.ts            routing
src/http/middleware.ts        security headers, CORS, rate limits, raw bodies
src/http/routes-business.ts   the owner panel's endpoints
src/http/routes-admin.ts      the operator's endpoints
src/http/public/views/checkout.js  the payment screen
src/http/public/brand.css     design tokens + component styles
src/http/public/app.css       layout glue between views
src/http/public/index.html    customer shell — chrome, boot, route table
src/http/public/lib/          api, auth, router, format, dom, payments
src/http/public/components/   render-only pieces, no fetch
src/http/public/views/        home, explore, salon, bookings, profile, login
src/http/public/business.html salon owner panel (one inline file)
src/http/public/admin.html    operator panel (one inline file)
```

The customer app is vanilla ES modules loaded natively by the browser — no
bundler, matching the no-build-step choice the rest of the repo makes. Rule:
components render, `lib/` talks to the network, views compose.

`engine.ts` is pure and takes a snapshot, so every availability rule is testable
without a database. Only concurrency needs one.

## Spec §8 test coverage

All 9 cases, plus 19 more covering rules the spec states without listing a test.

| # | Case | Where |
|---|---|---|
| 1-8 | empty day, capacity, fragmented gaps, break, closing, holiday | `test/availability.test.ts` |
| 9 | two concurrent inserts, last seat | `test/booking-concurrency.test.ts` |

Plus the payment path, which the spec does not cover at all:

| | |
|---|---|
| `test/payments.test.ts` | signature forgery, commission rounding, refund idempotency, rate limits — no database needed |
| `test/payment-flow.test.ts` | the hold, the sweeper, late payments, webhook replay, refunds, ledger arithmetic |
| `test/reschedule.test.ts` | the 36h window, the cap of one, frozen prices, rollback on a taken slot |

The signature tests are written against forgery rather than the happy path: a
valid signature is the only thing between `POST /api/bookings/:id/confirm` and
"type a payment id, get a free booking". They cover a signature made with the
wrong secret, one lifted from a cheaper payment, a payment id swapped under a
valid order signature, and non-hex garbage that must fail closed rather than
throw.

**Case 9 as the spec writes it does not work.** A two-way race passes with the
advisory lock deleted — verified by removing the lock and rerunning: case 9 still
went green. Two concurrent transactions are simply not enough contention to
reliably interleave between the `SELECT` and the `INSERT`. Case **9b** fires 16
attempts at 3 chairs and fails immediately without the lock. Keep 9b; 9 alone is
a test that cannot fail.

## Where this deviates from the spec

Three schema changes and two implementation choices. Everything else follows §5
and §2 as written.

**1. `salons.timezone` column (new).** `salon_hours` stores wall-clock `time`;
`bookings` stores `timestamptz`. Converting needs a zone. Hardcoding IST in the
engine makes the second city a rewrite of the one module the spec says everything
rests on.

**2. `bookings.status` gains `cancelled_by_customer`.** §4 defines the rule
("Customer cancels → no refund, reschedule within 36h") but the status list has
no state for it. Without the value a customer cancellation is unrepresentable
*and* the cancelled booking keeps consuming a chair forever, because the
availability query counts `booked`. This is a defect, not a design choice.

**3. Index on `bookings (salon_id, start_at)` (new).** Today's bookings, the
calendar, and `[Close for today]` all filter salon + day. The spec indexes only
`(customer_id, start_at)`.

**3c. `users.avatar_url` + `users.updated_at` (new).** Google sign-in carries a
`picture` claim and a display name that can change. Without these the profile
is frozen at first login and there is nowhere to put the photo. Sign-in now
refreshes name/email/avatar every time. `db/migrations/001_users_profile_fields.sql`.

**3d. `salons.cover_url`, `salon_photos`, `favorites` (new).** The marketplace UI
needs imagery and saved salons; the spec's schema has neither. Photos are
seeded from `scripts/ci-fixture.ts` or entered by an admin — a salon with none renders a branded
gradient placeholder rather than a borrowed stock image.
`db/migrations/002_marketplace.sql`.

**3b. `cancelled_at` + `refund_status` (new).** §4 promises "Full refund, auto"
for `[Close for today]` and for a customer who arrives at a shut shop, but the
schema has nowhere to record whether the refund actually happened. A failed
Razorpay refund would be invisible and unretryable — the salon keeps the money
and the customer is told they were refunded. Cancels now park at
`refund_status='pending'` for a worker to pick up.

**4. The cache holds the snapshot, not the slot list.** §2 says cache under
`avail:{salon_id}` for 60s. That key has no cart in it, so the cached value must
not depend on the cart. Caching a computed slot list there serves the 30-minute
haircut's start times to the next customer's 90-minute cart — they tap one, and
get rejected by the advisory-lock re-check *after paying*. So the cached unit is
hours + holidays + occupancy, and the per-cart computation (a few hundred integer
comparisons) runs on every request. Test: "the cached snapshot is cart-independent".

**5. The lunch break and closing time are structural, not filters.** The grid is
built as *segments* — open→break, break→close — and a booking must fit inside one
segment. The spec's four exclusion rules become two: holiday and the 15-minute
lead time. The other two cannot be forgotten at a call site because the slots
simply do not exist.

Minor: the engine does one backward pass instead of the spec's forward rescan
(O(n) vs O(n²) — irrelevant at 30 slots/day, but no harder to read).

## Decisions the spec leaves open that the code had to make

**Buffer policy — needs a real answer before launch.** §2 gives two rules that
disagree:

```
formula:      ceil((sum of durations + buffer) / interval)   <- one buffer
partial-fit:  s.duration + s.buffer <= freeMin               <- per service
```

`engine.ts` implements `'max'` — one turnaround per booking, sized by the messiest
service in the cart. `'sum'` is one line away. On a 3-service cart the difference
is 20 minutes of chair, which on a 30-min grid is a whole slot the salon cannot
sell. Ask the salons, then set `BUFFER_POLICY`.

**Off-grid break times.** A break ending 13:15 on a 30-min grid would produce
13:15/13:45 slots, so "2/4 booked" would refer to two different grids depending on
time of day. The post-break segment is snapped up to the next grid point measured
from opening. Cost: up to one interval of bookable time lost after lunch.

**`end_at` is the service window, not chair time.** Sum of durations, buffer
excluded — a 60-minute cart should not show "4:00–5:10 PM" on the booking card.
The slot ledger extends past `end_at` by the buffer.

**The verify code is generated at booking time, not 15 minutes before.** §4 has
a job create it late; the read path withholds it until 15 minutes before
instead. Same customer experience, one fewer scheduler on the critical path —
and BullMQ (step 7) is not built. If a code ever needs rotating, move it back.

## The payment hold

§4 orders this `pay → booking created, slots locked`. Nothing holds the slot
*during* payment, so two customers open the sheet on the last chair, both pay,
and one gets `SLOT_UNAVAILABLE` after their money has already moved.
`createBooking` is correct as specified — it never double-books — but the
correctness was costing a refund instead of a rejection.

The order is now `hold → pay → confirm`:

```
POST /api/bookings              takes the chair, status = pending_payment,
                                hold_expires_at = now + 8 min, opens an order
[Razorpay sheet]
POST /api/bookings/:id/confirm  verifies the signature, asks Razorpay what
                                really happened, flips the row to 'booked'
```

Four things make it hold up:

**The chair is taken inside the same advisory lock that proved it was free.**
The second customer is rejected at step one, before Razorpay is ever opened.

**Which statuses consume a chair is defined once**, in `src/booking/occupancy.ts`,
because the availability read and the commit-time re-check must never disagree.
One counts a hold only while `hold_expires_at > now`.

**Correctness lives in the predicate, not in the sweeper.** An expired hold
stops consuming a chair by the clock, so a dead worker cannot oversell — it can
only leave a stale row. `sweep.ts` tidies those up; nothing depends on it having
run.

**The webhook is the backstop, and it races the callback on purpose.** Whichever
lands first confirms; the second gets `already_confirmed`. Without the webhook,
every customer who closes the tab on the UPI screen is debited with no booking.

The one case a refund is still unavoidable is money that arrives after the hold
lapsed *and* after someone else took the chair. `applyCapture` re-checks under
the lock, honours the payment if the chair is still free, and only queues a
refund when it genuinely cannot be honoured — returning **202**, not 200, so the
app never shows a confirmation for a booking that does not exist.

## Where the money goes

Payments are collected into the **platform's** Razorpay account, not per-salon
sub-merchants. The spec assumes the Partner model, which is gated on an
application that takes weeks; this ships today and Route transfers slot in later
without touching the checkout flow (`salons.rzp_route_account_id` is where they
attach).

That means the platform holds the salon's money for a while, so it has to be
accounted for properly rather than inferred. Every movement is a signed row in
`ledger_entries`:

```
sale                + gross the customer paid
commission          − the platform's cut (salons.commission_bps, default 1500)
refund              − returned to the customer
commission_reversal + the cut given back with that refund
payout              − actually sent to the salon
adjustment          ± manual, and a note is required
```

A salon's balance is `SUM(amount)`. There is no stored running total, because
one that drifts cannot be repaired without an audit while a ledger can always be
re-summed. The commission reversal is scaled from the commission entry that was
actually written, not recomputed at today's rate — a salon whose rate changed
between the sale and the refund must not have the difference quietly pocketed.

Both ledger writes are `ON CONFLICT DO NOTHING` against partial unique indexes on
`(payment_id, kind)` and `(refund_id, kind)`, so a webhook Razorpay delivers
twice credits a salon exactly once.

Refunds are a queue, never an inline call. Calling Razorpay inside the
transaction that cancels a booking means a timeout leaves the caller retrying a
cancel that already refunded.

## Answers to §10, and what they cost

1. **Revenue model** — per-booking commission, `salons.commission_bps`, default
   15%. Per-salon because launch deals are the norm. Still open as a *business*
   question; the code no longer blocks on it.
2. **Reschedule more than once?** No — the spec's own recommendation.
   `reschedule_count` carries forward down the chain, so rescheduling the
   reschedule is not a way around the cap.
3. **Same salon?** Yes. The money sits against this salon in the ledger; moving
   it elsewhere is a refund plus a fresh sale, which is a different feature.
4. **Who absorbs a price change in the 36h window?** Nobody. The cart is carried
   forward frozen from `booking_items`. Charging the difference means a second
   payment flow on a slot the customer already holds; refunding it means a
   partial refund on a booking that is going ahead. Both cost more than the few
   rupees involved.
5. **Solo or team** — still open, still blocks nothing.

## Operational shape

- **Workers** are three loops over Postgres (`src/workers/runner.ts`), not
  BullMQ. Every job is "find due rows, act, mark them", which is what Postgres
  is for; a queue would add Redis and a second durability story. Each tick takes
  a `pg_try_advisory_lock`, so N instances do not run N sweepers. Set
  `RUN_WORKERS=false` to split them onto their own dyno.
- **Logs** are one JSON object per line with a request id carried in
  `AsyncLocalStorage`, and a redaction list that covers signatures, tokens,
  phone and email. `setErrorReporter()` is the Sentry seam.
- **Rate limits** are in-memory token buckets — per-instance, which is the
  honest trade for keeping Redis off the request path. `X-Forwarded-For` is only
  trusted when `TRUST_PROXY` is set, because with no proxy in front it lets any
  caller forge a fresh identity per request.
- **Liveness and readiness are separate.** `/healthz` never touches Postgres: a
  liveness probe that does turns a database blip into a rolling restart of every
  instance.
- **Assets** get ETags at boot. The customer app is ~40 natively-loaded ES
  modules; without conditional requests that is 40 full downloads per
  navigation.

## Next

Build order 1 (`salon_services` / `salon_hours` CRUD) and 6-8 remain. The two
things worth doing before real traffic:

1. **Reconciliation.** Nothing yet compares our `payments` table against
   Razorpay's settlement report. Until it does, a payment Razorpay recorded and
   we did not is invisible.
2. **Redis for the snapshot cache.** In-process is correct for one instance and
   merely wasteful for several.
