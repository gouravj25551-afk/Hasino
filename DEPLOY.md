# Deploying

## Status

The API is now deployable. It was not before — it refused to boot with
`DEV_AUTH=true` and returned `501` without it. Firebase Auth is implemented, so
`NODE_ENV=production` boots and serves real authenticated traffic.

Verified locally in production mode:

```
/health                      -> {"ok":true,"auth":"firebase"}
GET /api/salons              -> 200   (browsing stays public)
GET /                        -> 200   (customer app, real Google sign-in)
GET /api/dev/identities      -> 404
x-dev-user: <uuid>           -> 401 NO_TOKEN      (dev header is inert)
Authorization: Bearer junk   -> 401 INVALID_TOKEN (real signature check)
```

The web pages are served in production now — they were dev-only before. They
sign in with real Google auth via Firebase, so they need the four
`FIREBASE_WEB_*` client variables below. Without them browsing still works and
only sign-in fails, with a visible message.

**Payments are still not implemented.** See "What going live still means" below.

## Deploy it

You need three accounts. I cannot create them — do these yourself:

**1. Firebase project** → Authentication → enable Phone (and Google/Apple if you
want them). Project settings → Service accounts → *Generate new private key*.

**2. Managed Postgres** — Railway, Render, Neon, Supabase. Copy the connection
string; make sure it forces SSL.

**3. A host** — Railway, Render, Fly, or Cloud Run. All take the Dockerfile.

Then:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
```

Set these variables on the host:

| Variable | Value |
|---|---|
| `DATABASE_URL` | your Postgres URL, SSL on |
| `NODE_ENV` | `production` |
| `FIREBASE_SERVICE_ACCOUNT` | the whole service-account JSON, inline |
| `FIREBASE_WEB_API_KEY` | client config — Project settings → General → Your apps |
| `FIREBASE_AUTH_DOMAIN` | client config |
| `FIREBASE_PROJECT_ID` | client config |
| `FIREBASE_APP_ID` | client config |
| `PORT` | usually injected by the host |
| `DEV_AUTH` | **leave unset** — the server refuses to start with it |

The four `FIREBASE_WEB_*`/client values are not secret — they ship to the
browser via `GET /api/config`. They are environment variables so a staging and
a production deploy can point at different Firebase projects.

In the Firebase console you must also enable **Google** and **Phone** under
Authentication → Sign-in method, and add your production domain under
Authentication → Settings → Authorized domains. Google sign-in carries no
phone number, so the client walks the `428 PHONE_REQUIRED` phone-link flow
before the account can book.

`GOOGLE_APPLICATION_CREDENTIALS` (a file path) works instead of
`FIREBASE_SERVICE_ACCOUNT` and is what Cloud Run injects for free.

Deploy. `/health` should report `"auth":"firebase"`.

> The Dockerfile **has not been built** — Docker is not installed on this
> machine. It is conventional and should work, but the first `docker build` is
> unverified.

### Making yourself a salon owner

Roles never come from token claims — a new account is always `customer`. To
onboard a salon, insert the row and let the owner sign in with that phone; the
next sign-in adopts it:

```sql
INSERT INTO users (phone, name, role) VALUES ('+919876543210', 'Owner', 'business');
INSERT INTO salons (owner_id, name, address, lat, lng, status)
VALUES ((SELECT id FROM users WHERE phone='+919876543210'),
        'Salon Name', 'Address', 12.97, 77.59, 'active');
```

## What going live still means

**No payments.** `POST /api/bookings` creates an *unpaid* booking that holds a
real chair. Launching now means salons keeping chairs empty for people who
haven't paid. Razorpay is build order steps 4-5, gated on the Partner
application and a registered business entity — weeks, and not code.

**No app.** The customer-facing surface is React Native (step 7). What ships
today is an API plus two dev-only web consoles, disabled in production. A real
launch needs the mobile client, which must send `Authorization: Bearer <Firebase
ID token>`.

**No reminders or no-show sweep.** BullMQ (step 7) is not built, so nothing
sends the 24h/1h/15min reminders or auto-marks no-shows.

**Refunds are recorded, not executed.** Cancels set `refund_status='pending'`.
Nothing drains that queue yet.

**Google/Apple sign-in needs a phone link.** `users.phone` is `NOT NULL UNIQUE`
and a salon has to be able to ring the customer, so a token without a phone gets
`428 PHONE_REQUIRED`. The client must link a phone credential before booking.

## Migrations

`db/schema.sql` is idempotent but will **not** alter an existing table — it is
the fresh-install path only. Schema changes also land in `db/migrations/` as
numbered, idempotent files:

```bash
for m in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$m"; done
```

Applying every migration to a database built from the previous schema was
verified to produce identical columns, types, nullability, defaults and
indexes to a fresh `db/schema.sql` build.

This is still **not a migration system** — nothing records which files have
run, so re-running is safe only because each one is written to be. Before
there are two long-lived environments, add `node-pg-migrate` or Atlas and give
them a version table.

Do **not** run `npm run db:seed` against production; it truncates every table.
It refuses when `NODE_ENV=production` unless `ALLOW_DESTRUCTIVE_SEED=true`.
