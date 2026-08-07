# Hasino

Salon booking marketplace. Build-order steps 2 and 3 (availability engine,
booking create), the schema they run on, and a read-and-book HTTP API over them.

Firebase Auth is implemented, so the API is deployable. **Payments are not** —
bookings hold a real chair without money attached. See [DEPLOY.md](DEPLOY.md).

## Run it

```bash
npm install
createdb hasino_dev && psql -v ON_ERROR_STOP=1 -d hasino_dev -f db/schema.sql
DATABASE_URL=postgres://localhost:5432/hasino_dev npm run db:seed
DATABASE_URL=postgres://localhost:5432/hasino_dev DEV_AUTH=true npm start
```

Two surfaces:

| | |
|---|---|
| `localhost:3000` | **Customer** — browse, pick services, book, my bookings |
| `localhost:3000/business` | **Salon panel** — services, timings, today's bookings, insights |

Both are served only when `DEV_AUTH=true`; with auth off they return a JSON
route listing. There is no login, so each has a dev identity picker in the
top-right — the customer app switches customer, the panel switches salon.

```bash
npm run smoke   # 27 end-to-end checks against a running server
```

These are web surfaces standing in for what the spec plans as React Native
(customer) and Next.js (business). The API underneath is the same either way.

```bash
npm test        # 44 tests
npm run typecheck
```

`npm test` passes `--test-concurrency=1` deliberately: the DB-backed suites
share one database and truncate it, so running the files in parallel makes them
wipe each other's fixtures.

Database-backed tests skip (not fail) without Postgres, so the pure engine tests
run anywhere.

## API

Authenticated routes take `Authorization: Bearer <Firebase ID token>`. Browsing
is public. Under `DEV_AUTH=true` an `x-dev-user` header naming a `firebase_uid`
stands in, so the local consoles work without a Firebase project.

Customer:

| | | |
|---|---|---|
| `GET` | `/api/salons?q=` | browse |
| `GET` | `/api/salons/:id` | services, hours, rating |
| `POST` | `/api/salons/:id/availability` | `{serviceIds}` → 7-day window |
| `POST` | `/api/bookings` | → 201, or **409** `SLOT_UNAVAILABLE` |
| `GET` | `/api/me` | the signed-in user |
| `GET` | `/api/me/bookings` | verify code appears 15 min before the slot |

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
| `GET` | `/api/business/payouts` | §6.6 — stub, blocked on Razorpay |

`node:http`, no framework. The spec picks NestJS, which is decorator-based and
needs a real compile step with `emitDecoratorMetadata` — it cannot run under
Node's type stripping. That is a fine trade later; making it now would mean a
build pipeline before there is an app. The engine is framework-agnostic, so
wrapping it in Nest touches only `src/http/server.ts`.

## Layout

```
db/schema.sql                 spec §5, applied and verified against Postgres 16
src/time/tz.ts                wall-clock <-> instant, DST-correct
src/availability/grid.ts      the bookable slot grid for one day
src/availability/engine.ts    the algorithm — pure, no I/O
src/availability/repo.ts      the 7-day window in 3 queries
src/availability/cache.ts     60s snapshot cache
src/availability/service.ts   7-day orchestration
src/booking/create.ts         advisory-lock booking create
src/auth/verifier.ts          Firebase token verification (swappable)
src/auth/session.ts           token -> users row, roles, provisioning
src/booking/status.ts         §4 state machine + close-for-day
src/salons/repo.ts            browse + detail queries
src/business/repo.ts          the §6 panel's reads and writes
src/http/server.ts            routing
src/http/routes-business.ts   the panel's endpoints
src/http/public/brand.css     design tokens from the logo
src/http/public/index.html    customer
src/http/public/business.html salon panel
```

`engine.ts` is pure and takes a snapshot, so every availability rule is testable
without a database. Only concurrency needs one.

## Spec §8 test coverage

All 9 cases, plus 19 more covering rules the spec states without listing a test.

| # | Case | Where |
|---|---|---|
| 1-8 | empty day, capacity, fragmented gaps, break, closing, holiday | `test/availability.test.ts` |
| 9 | two concurrent inserts, last seat | `test/booking-concurrency.test.ts` |

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

## The thing that needs a decision before payment code is written

The §4 flow is `pay → booking created, slots locked`. Nothing holds the slot
*during* payment. Two customers open the payment sheet on the last chair; both
pay; one gets `SLOT_UNAVAILABLE` after their money has already moved — and under
the Partner sub-merchant model that money is in the salon's account, so the
platform is now issuing a refund against someone else's balance for its own
concurrency bug.

`createBooking` is correct as specified — it never double-books. The gap is that
correctness costs a refund instead of a rejection.

The standard fix is a `pending_payment` status that consumes a chair with a short
TTL, confirmed by the webhook and swept if it expires. That is a real change to
§4, §5, and the BullMQ job list, so it is flagged rather than built:

```sql
-- if you take this route
ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending_payment','booked','verified','in_progress','completed',
                    'no_show','rescheduled','cancelled_by_customer','cancelled_by_salon'));
ALTER TABLE bookings ADD COLUMN hold_expires_at timestamptz;
-- and add 'pending_payment' to the chair-consuming status list in BOTH
-- src/availability/repo.ts and src/booking/create.ts
```

## Still open from §10

1. Revenue model — subscription vs per-booking. Blocks billing code only.
2. Reschedule more than once? (spec recommends cap at 1)
3. Reschedule locked to the same salon? (spec recommends yes)
4. Who absorbs a price change within the 36h reschedule window?
5. Solo or team.

None of these block the next build step.

## Next

Build order 1 (`salon_services` / `salon_hours` CRUD) and 4-8 are untouched.
Step 4 (Razorpay Partner onboarding) is gated on the partner application and the
business entity — §3 is right that those take weeks and should start now.
