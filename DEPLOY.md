# Deploying

## Status

Deployable, and now takes money. Firebase Auth and Razorpay are both
implemented, and `NODE_ENV=production` refuses to boot without either — a server
that serves bookings it cannot authenticate, or takes bookings it cannot charge
for, should not start at all.

Verified locally in production mode:

```
/healthz                     -> {"ok":true}          (no DB call, by design)
/readyz                      -> {"ok":true,"auth":"firebase","payments":"razorpay"}
GET /api/salons              -> 200   (browsing stays public)
GET /                        -> 200   (customer app, real Google sign-in)
GET /api/dev/identities      -> 404
POST /api/dev/pay            -> 404   (stub-only, and only under DEV_AUTH)
x-dev-user: <uuid>           -> 401 NO_TOKEN      (dev header is inert)
Authorization: Bearer junk   -> 401 INVALID_TOKEN (real signature check)
POST /api/webhooks/razorpay  -> 400 BAD_SIGNATURE (unsigned body refused)
```

## Deploy it

You need four accounts. I cannot create them — do these yourself:

**1. Firebase project** → Authentication → enable Phone and Google. Project
settings → Service accounts → *Generate new private key*.

**2. Razorpay account** → Dashboard → Account & Settings → API Keys. Test keys
(`rzp_test_*`) work end to end against Razorpay's sandbox; live keys need the
account activated, which needs a registered business entity and a current
account. Start that early — it is the long pole.

**3. Managed Postgres** — Railway, Render, Neon, Supabase. Copy the connection
string; make sure it forces SSL.

**4. A host** — Railway, Render, Fly, or Cloud Run. All take the Dockerfile.

Then:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql   # fresh database
# or, for one that already has data:
DATABASE_URL=... node scripts/migrate.ts
```

Set these on the host:

| Variable | Value |
|---|---|
| `DATABASE_URL` | your Postgres URL, SSL on |
| `NODE_ENV` | `production` |
| `FIREBASE_SERVICE_ACCOUNT` | the whole service-account JSON, inline |
| `FIREBASE_WEB_API_KEY` | client config — Project settings → General → Your apps |
| `FIREBASE_AUTH_DOMAIN` | client config |
| `FIREBASE_PROJECT_ID` | client config |
| `FIREBASE_APP_ID` | client config |
| `RAZORPAY_KEY_ID` | Dashboard → API Keys |
| `RAZORPAY_KEY_SECRET` | shown once, at creation |
| `RAZORPAY_WEBHOOK_SECRET` | a **different** secret — set when you create the webhook |
| `PLATFORM_COMMISSION_BPS` | optional, default `1500` (15%) |
| `TRUST_PROXY` | `true` only if something in front appends `X-Forwarded-For` |
| `RESEND_API_KEY` + `EMAIL_FROM` | optional; without them emails print to stdout |
| `ADMIN_EMAILS` | comma-separated Google addresses that get `/admin` |
| `PORT` | usually injected by the host |
| `DEV_AUTH` | **leave unset** — the server refuses to start with it |
| `CI_SMOKE` | **leave unset** — same |
| `ALLOW_UNPAID_BOOKINGS` | **leave unset** — same |

The four `FIREBASE_WEB_*` values are not secret — they ship to the browser via
`GET /api/config`, alongside `RAZORPAY_KEY_ID`. They are environment variables so
staging and production can point at different projects. The two **secrets**
(`RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`) never leave the server.

In the Firebase console also enable **Google** and **Phone** under
Authentication → Sign-in method, and add your production domain under
Authentication → Settings → Authorized domains. Google sign-in carries no phone
number, so the client walks the `428 PHONE_REQUIRED` phone-link flow before the
account can book.

`GOOGLE_APPLICATION_CREDENTIALS` (a file path) works instead of
`FIREBASE_SERVICE_ACCOUNT` and is what Cloud Run injects for free.

Deploy. `/readyz` should report `"auth":"firebase"` and `"payments":"razorpay"`.

## The webhook is not optional

Razorpay Dashboard → Settings → Webhooks → Add New Webhook:

```
URL     https://<your-host>/api/webhooks/razorpay
Secret  the value of RAZORPAY_WEBHOOK_SECRET
Events  payment.captured   payment.failed   order.paid
        refund.processed   refund.failed
```

Skip this and every customer who closes the tab on the UPI screen is debited
with no booking. The browser callback confirms most payments in under a second,
but it only runs if the browser is still there; the webhook is what covers the
ones where it isn't.

Verify the secret matches by watching for `webhook … outcome=processed` in the
logs after a test payment. A mismatch shows up as `400 BAD_SIGNATURE` on every
delivery — loudly, which is the intent.

### Testing it before launch

With test keys, Razorpay's sandbox accepts UPI id `success@razorpay` and the
card `4111 1111 1111 1111` with any future expiry and any CVV. Run one booking
through, then check the salon's **Money** screen: a `sale` and a `commission`
entry should appear, and the balance should equal gross minus the cut.

## Making yourself a salon owner

Roles never come from token claims — a new account is always `customer`. To
onboard a salon, insert the row and let the owner sign in with that phone; the
next sign-in adopts it:

```sql
INSERT INTO users (phone, name, role) VALUES ('+919876543210', 'Owner', 'business');
INSERT INTO salons (owner_id, name, address, lat, lng, status, commission_bps)
VALUES ((SELECT id FROM users WHERE phone='+919876543210'),
        'Salon Name', 'Address', 12.97, 77.59, 'active', 1500);
```

`commission_bps` is per-salon, so a launch deal is a column, not a code change.

## What going live still means

**Money sits with you, not the salon.** Payments land in the platform's Razorpay
account and each salon's share is tracked in `ledger_entries`. That is a real
obligation: you are holding their money between the booking and the payout.
Two consequences worth being deliberate about —

- **Payouts are recorded, not sent.** `createPayoutForPeriod` writes the payout
  and the matching ledger entry so the salon's screen and your books agree, but
  the actual transfer is a manual RazorpayX or bank action today. Nothing will
  chase you if you forget.
- **Check whether you need an aggregator licence.** Holding customer funds on
  behalf of merchants is what RBI's PA/PG rules govern. Razorpay Route exists
  specifically so platforms can split payments without becoming an aggregator —
  `salons.rzp_route_account_id` is where linked accounts attach when you enable
  it. Get this looked at by someone qualified before scale, not after.

**No reconciliation.** Nothing compares our `payments` table against Razorpay's
settlement report. A payment Razorpay recorded and we did not is currently
invisible. This is the first thing to build after launch.

**No mobile app.** The customer surface the spec plans is React Native (step 7).
What ships is the API plus two web surfaces, which are real and usable but are
not an app-store presence. A native client sends the same
`Authorization: Bearer <Firebase ID token>`.

**Reminders are email only.** The outbox supports `sms`, `whatsapp` and `push`
channels and parks those rows as `skipped` rather than dropping them — switching
one on is a worker change, not a backfill. For salon bookings in India, WhatsApp
is probably what customers actually read.

**Google/Apple sign-in needs a phone link.** `users.phone` is `NOT NULL UNIQUE`
and a salon has to be able to ring the customer, so a token without a phone gets
`428 PHONE_REQUIRED`.

## Workers

The three background jobs (hold sweep, refunds, notifications) run in the web
process by default, which is right for one box. Each tick takes a
`pg_try_advisory_lock`, so scaling to N instances does not run N sweepers.

To split them out, run the same image twice:

```
web     RUN_WORKERS=false
worker  RUN_WORKERS=true   (and no inbound traffic)
```

Nothing about correctness depends on the workers running. An expired hold stops
consuming a chair by the clock, not by being swept — a dead worker leaves stale
rows and unsent email, never an oversold slot.

## Migrations

`db/schema.sql` is the fresh-install path and will not alter an existing table.
For a database with data, `scripts/migrate.ts` applies `db/migrations/*.sql` in
order, once each, recording filename + checksum + duration in
`schema_migrations`.

```bash
npm run db:migrate:status   # what would run
npm run db:migrate          # run it
```

Each file runs in a transaction (Postgres has transactional DDL, so a failure
leaves the schema untouched) and the whole run holds an advisory lock, so two
containers booting together cannot interleave. Editing a migration that has
already run is **refused** — the checksum will not match, and the fix is a new
file rather than a schema that differs per environment.

CI asserts that `schema.sql` and the migrations have not drifted: it builds a
database from `schema.sql`, then runs every migration against it. A migration
that is not re-runnable fails there rather than against production on a Friday.

Do **not** run `npm run db:seed` against production; it truncates every table.
It refuses when `NODE_ENV=production` unless `ALLOW_DESTRUCTIVE_SEED=true`.

## Rollback

The schema changes in `003_payments.sql` are additive — new tables, new columns,
a widened `CHECK` constraint. An older build will run against the new schema
with one caveat: it does not know about `pending_payment`, so live holds become
invisible to its availability query and those chairs are sellable twice for as
long as the rollback lasts. If you must roll back, expire the holds first:

```sql
UPDATE bookings SET status = 'expired'
 WHERE status = 'pending_payment';
```

Anyone mid-payment is then refunded by the normal late-capture path.
