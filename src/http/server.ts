import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

import { getPool, type Pool } from '../db/pool.ts';
import { MemorySnapshotCache } from '../availability/cache.ts';
import { getAvailability } from '../availability/service.ts';
import { loadCart } from '../availability/repo.ts';
import { createBooking } from '../booking/create.ts';
import { customerCancelBooking } from '../booking/status.ts';
import { rescheduleBooking } from '../booking/reschedule.ts';
import { BookingError, SlotUnavailableError } from '../booking/errors.ts';
import { ForbiddenError, listCustomerBookings } from '../business/repo.ts';
import { addFavorite, getBooking, getSalon, listFavorites, listSalons, removeFavorite } from '../salons/repo.ts';
import { businessRoutes } from './routes-business.ts';
import {
  HttpError,
  json,
  loadAssets,
  readJson,
  sendAsset,
  stringArray,
  uuid,
} from './respond.ts';
import {
  RateLimitError,
  RateLimiter,
  applyCors,
  clientKey,
  originsFromEnv,
  readRawBody,
  securityHeaders,
} from './middleware.ts';
import { AuthError, verifierFromEnv } from '../auth/verifier.ts';
import { type Session, authenticate, requireRole } from '../auth/session.ts';
import { StubRazorpayClient, paymentsConfigFromEnv } from '../payments/razorpay.ts';
import { PaymentError, confirmCheckout, openCheckout } from '../payments/service.ts';
import { WebhookSignatureError, handleWebhook } from '../payments/webhook.ts';
import { channelFromEnv } from '../notify/dispatch.ts';
import { startWorkers, type RunningWorkers } from '../workers/runner.ts';
import { annotate, log, newRequestId, reportError, withRequestContext } from '../obs/logger.ts';

/**
 * DEV_AUTH swaps Firebase token verification for a header naming the user
 * directly — anyone can act as anyone.
 *
 * It now requires CI_SMOKE as well, because "local development" and "a smoke
 * test harness" are different needs that were sharing one switch. Local
 * development uses real Google sign-in like production does; only the CI smoke
 * run, which has no browser to sign in with, gets the bypass. A developer who
 * sets DEV_AUTH out of habit gets a working server with auth ON and a warning
 * saying why, rather than a server that silently trusts a header.
 *
 * start() refuses to boot with either flag in production.
 */
const DEV_AUTH_REQUESTED = process.env['DEV_AUTH'] === 'true';
const CI_SMOKE = process.env['CI_SMOKE'] === 'true';
const DEV_AUTH = DEV_AUTH_REQUESTED && CI_SMOKE;
const IS_PROD = process.env['NODE_ENV'] === 'production';
const TRUST_PROXY = process.env['TRUST_PROXY'] === 'true';

const verifier = verifierFromEnv(DEV_AUTH);
const payments = paymentsConfigFromEnv(DEV_AUTH);
const cache = new MemorySnapshotCache();
const allowedOrigins = originsFromEnv();

/**
 * Three budgets, because the endpoints are not equally expensive to abuse.
 * Browsing is cheap and gets a wide limit; taking a chair costs someone else a
 * slot, so it gets a narrow one keyed to the user rather than the IP — an
 * office behind one NAT is many customers.
 */
const limits = {
  global: new RateLimiter(Number(process.env['RATE_LIMIT_PER_MIN'] ?? 300)),
  booking: new RateLimiter(10, 5),
  auth: new RateLimiter(60),
};

const assets = loadAssets(new URL('./public/', import.meta.url), [
  'index.html',
  'business.html',
  'brand.css',
  'app.css',
  'lib/api.js',
  'lib/auth.js',
  'lib/dom.js',
  'lib/format.js',
  'lib/payments.js',
  'lib/router.js',
  'components/Avatar.js',
  'components/Badge.js',
  'components/BookingCard.js',
  'components/BottomNav.js',
  'components/BottomSheet.js',
  'components/Button.js',
  'components/EmptyState.js',
  'components/Input.js',
  'components/Modal.js',
  'components/Rating.js',
  'components/SalonCard.js',
  'components/SearchBar.js',
  'components/ServiceCard.js',
  'components/Skeleton.js',
  'components/TopBar.js',
  'views/home.js',
  'views/explore.js',
  'views/salon.js',
  'views/checkout.js',
  'views/bookings.js',
  'views/profile.js',
  'views/login.js',
]);

const PAGES: Record<string, string> = {
  '/': 'index.html',
  '/business': 'business.html',
};

function requireDevAuth(): void {
  if (!DEV_AUTH) throw new HttpError(404, 'Not found');
}

/**
 * The single authentication entry point.
 *
 * Production: Firebase ID token in `Authorization: Bearer <token>`.
 * DEV_AUTH:   an `x-dev-user` header naming a users.firebase_uid, so the local
 *             console can switch identity without a Firebase project.
 */
async function session(db: Pool, req: IncomingMessage): Promise<Session> {
  if (DEV_AUTH) {
    const dev = req.headers['x-dev-user'];
    if (typeof dev === 'string' && dev.length > 0) {
      const s = await authenticate(db, verifier, `Bearer ${dev}`);
      annotate({ userId: s.userId });
      return s;
    }
  }
  const s = await authenticate(db, verifier, req.headers.authorization);
  annotate({ userId: s.userId });
  return s;
}

/**
 * Replay a retried request instead of doing it twice.
 *
 * A phone on a bad connection retries POST /api/bookings, and without this the
 * second attempt takes a second chair and opens a second Razorpay order. The
 * request body is hashed into the key so a client reusing a key for a
 * *different* request gets an error rather than someone else's response.
 *
 * Without an Idempotency-Key header this is a straight pass-through — the
 * header is opt-in for clients that can generate one, not a requirement.
 */
async function withIdempotency<T>(
  db: Pool,
  req: IncomingMessage,
  userId: string,
  endpoint: string,
  body: unknown,
  fn: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T }> {
  const raw = req.headers['idempotency-key'];
  const key = (Array.isArray(raw) ? raw[0] : raw)?.slice(0, 200);
  if (!key) return fn();

  const hash = createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');

  const claim = await db.query<{ request_hash: string; status_code: number | null; response: T | null }>(
    `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, endpoint, key) DO NOTHING
     RETURNING request_hash, status_code, response`,
    [key, userId, endpoint, hash],
  );

  if (claim.rowCount === 0) {
    const seen = await db.query<{ request_hash: string; status_code: number | null; response: T | null }>(
      `SELECT request_hash, status_code, response FROM idempotency_keys
        WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
      [userId, endpoint, key],
    );
    const row = seen.rows[0]!;
    if (row.request_hash !== hash) {
      throw new HttpError(422, 'This Idempotency-Key was already used for a different request');
    }
    if (row.status_code !== null && row.response !== null) {
      return { status: row.status_code, body: row.response };
    }
    // The first attempt is still in flight. 409 is honest: retrying in a
    // moment will replay the stored response.
    throw new HttpError(409, 'That request is still being processed');
  }

  const result = await fn();
  await db.query(
    `UPDATE idempotency_keys SET status_code = $4, response = $5::jsonb
      WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
    [userId, endpoint, key, result.status, JSON.stringify(result.body)],
  );
  return result;
}

/** What POST /api/bookings answers with — and what gets stored for a replay. */
interface BookingResponse {
  id: string;
  salonId: string;
  startAt: string;
  endAt: string;
  amount: number;
  status: string;
  paid: boolean;
  holdExpiresAt?: string | null;
  checkout?: unknown;
  warning?: string;
}

async function route(db: Pool, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  const seg = path.split('/').filter(Boolean);

  // HEAD is a GET without a body, and Node drops the body for us. Matching only
  // GET makes every asset 404 for uptime checks, CDNs and proxies that HEAD
  // before they fetch — which looks like the app being down.
  const read = method === 'GET' || method === 'HEAD';

  // ---------- liveness / readiness ----------
  // Split on purpose. Kubernetes restarts a container that fails liveness and
  // only removes it from the load balancer when it fails readiness. A liveness
  // probe that touches Postgres therefore turns a database blip into a rolling
  // restart of every instance, which is how a brief outage becomes a long one.
  if (read && path === '/healthz') {
    return json(res, 200, { ok: true });
  }

  if (read && (path === '/readyz' || path === '/health')) {
    try {
      await db.query('SELECT 1');
    } catch (err) {
      return json(res, 503, { ok: false, db: 'unreachable', error: (err as Error).message });
    }
    return json(res, 200, {
      ok: true,
      auth: DEV_AUTH ? 'DEV_AUTH (insecure)' : verifier.kind,
      payments: payments.enabled ? payments.client.kind : 'disabled',
    });
  }

  // ---------- Razorpay webhook ----------
  // Before the asset and auth branches: it is unauthenticated by design (the
  // signature is the authentication) and it must read the raw body, so nothing
  // may parse it first.
  if (method === 'POST' && path === '/api/webhooks/razorpay') {
    const raw = await readRawBody(req);
    const sig = req.headers['x-razorpay-signature'];
    const eventId = req.headers['x-razorpay-event-id'];
    const result = await handleWebhook(
      db,
      payments,
      raw,
      {
        signature: Array.isArray(sig) ? sig[0] : sig,
        eventId: Array.isArray(eventId) ? eventId[0] : eventId,
      },
      { cache },
    );
    log.info('webhook', { event: result.event, outcome: result.outcome });
    return json(res, result.status, { received: true, outcome: result.outcome });
  }

  // ---------- pages + assets ----------
  // Pages are served either way — production users sign in with real Google
  // auth. Only the x-dev-user bypass and /api/dev/identities (below) are
  // DEV_AUTH-only.
  const page = PAGES[path];
  if (read && page) {
    return sendAsset(res, assets.get(page)!, req);
  }

  if (read && assets.has(path.slice(1))) {
    return sendAsset(res, assets.get(path.slice(1))!, req);
  }

  if (read && path === '/favicon.ico') {
    res.writeHead(204);
    return void res.end();
  }

  // The client Firebase config is not secret, but it's still environment-
  // specific — served from env so it's not hardcoded into a checked-in file.
  if (read && path === '/api/config') {
    return json(res, 200, {
      firebase: {
        apiKey: process.env['FIREBASE_WEB_API_KEY'] ?? null,
        authDomain: process.env['FIREBASE_AUTH_DOMAIN'] ?? null,
        projectId: process.env['FIREBASE_PROJECT_ID'] ?? null,
        appId: process.env['FIREBASE_APP_ID'] ?? null,
      },
      // The public key id only. The secret signs, and never leaves the server.
      razorpay: { keyId: payments.enabled ? payments.keyId : null, enabled: payments.enabled },
      devAuth: DEV_AUTH,
    });
  }

  // ---------- dev identity ----------
  // There is no login, so the panels need a way to pick who they are acting as.
  if (method === 'GET' && path === '/api/dev/identities') {
    requireDevAuth();
    // devToken is what x-dev-user expects: the part of firebase_uid after "dev:".
    const [customers, owners] = await Promise.all([
      db.query(
        `SELECT id, name, phone, replace(firebase_uid, 'dev:', '') AS dev_token
           FROM users WHERE role = 'customer' AND firebase_uid LIKE 'dev:%'
          ORDER BY created_at LIMIT 20`,
      ),
      db.query(
        `SELECT u.id, u.name, s.name AS salon_name,
                replace(u.firebase_uid, 'dev:', '') AS dev_token
           FROM users u JOIN salons s ON s.owner_id = u.id
          WHERE u.role = 'business' AND u.firebase_uid LIKE 'dev:%'
          ORDER BY s.name`,
      ),
    ]);
    return json(res, 200, { customers: customers.rows, owners: owners.rows });
  }

  /**
   * Stand in for the customer tapping "Pay" in the Razorpay sheet.
   *
   * Razorpay's checkout cannot be driven without real keys, which would
   * otherwise leave the most important path in the app — hold, pay, confirm —
   * untested locally and unexercised by the smoke suite. This asks the stub
   * client to mint a payment and sign it exactly as Razorpay would, so the
   * response goes through the real signature check on the way back in.
   *
   * Two locks: DEV_AUTH only, and only when the payment client is the stub. On
   * a server holding live keys this route does not exist.
   */
  if (method === 'POST' && path === '/api/dev/pay') {
    requireDevAuth();
    if (!(payments.client instanceof StubRazorpayClient)) {
      throw new HttpError(404, 'Not found');
    }
    const body = await readJson(req);
    const orderId = String(body['orderId'] ?? '');
    if (!orderId) throw new HttpError(400, 'orderId is required');
    if (body['fail'] === true) {
      const failed = payments.client.fail(orderId);
      return json(res, 200, { paid: false, paymentId: failed.id, error: failed.error_code });
    }
    return json(res, 200, { paid: true, ...payments.client.pay(orderId, String(body['method'] ?? 'upi')) });
  }

  // ---------- business panel ----------
  if (seg[0] === 'api' && seg[1] === 'business') {
    const s = await session(db, req);
    requireRole(s, 'business');
    const handled = await businessRoutes(db, req, res, { seg, method, url, ownerId: s.userId, cache });
    if (handled) return;
    throw new HttpError(404, `No route for ${method} ${path}`);
  }

  // ---------- customer ----------
  if (method === 'GET' && path === '/api/salons') {
    const q = url.searchParams.get('q') ?? undefined;
    const latRaw = url.searchParams.get('lat');
    const lngRaw = url.searchParams.get('lng');
    const lat = latRaw === null ? undefined : Number(latRaw);
    const lng = lngRaw === null ? undefined : Number(lngRaw);
    if ((lat !== undefined && Number.isNaN(lat)) || (lng !== undefined && Number.isNaN(lng))) {
      throw new HttpError(400, 'lat and lng must be numbers');
    }
    const category = url.searchParams.get('category') ?? undefined;
    return json(res, 200, { salons: await listSalons(db, q, { lat, lng, category }) });
  }

  if (method === 'GET' && seg[0] === 'api' && seg[1] === 'salons' && seg.length === 3) {
    const salon = await getSalon(db, uuid(seg[2]!, 'salonId'));
    if (!salon) throw new HttpError(404, 'Salon not found');
    return json(res, 200, salon);
  }

  if (
    method === 'POST' &&
    seg[0] === 'api' &&
    seg[1] === 'salons' &&
    seg[3] === 'availability' &&
    seg.length === 4
  ) {
    const salonId = uuid(seg[2]!, 'salonId');
    const body = await readJson(req);
    const serviceIds = stringArray(body['serviceIds'], 'serviceIds');

    const cart = await loadCart(db, salonId, serviceIds);
    if (cart.length !== new Set(serviceIds).size) {
      throw new HttpError(400, 'Some services are not offered by this salon');
    }

    const availability = await getAvailability(db, salonId, cart, { cache });
    if (!availability) throw new HttpError(404, 'Salon not found');

    return json(res, 200, {
      salonId: availability.salonId,
      timezone: availability.timezone,
      requiredMin: availability.requiredMin,
      days: availability.days.map((d) => ({
        date: d.date,
        state: d.state,
        closedReason: d.closedReason,
        full: d.full.map((t) => t.toISOString()),
        partial: d.partial.map((p) => ({
          at: p.at.toISOString(),
          freeMin: p.freeMin,
          suggest: { serviceId: p.suggest.serviceId, name: p.suggest.name, price: p.suggest.price },
        })),
      })),
    });
  }

  if (method === 'GET' && path === '/api/me') {
    const s = await session(db, req);
    return json(res, 200, {
      id: s.userId,
      role: s.role,
      phone: s.phone,
      name: s.name,
      email: s.email,
      avatarUrl: s.avatarUrl,
      blockedUntil: s.blockedUntil,
    });
  }

  if (method === 'GET' && path === '/api/me/bookings') {
    const s = await session(db, req);
    return json(res, 200, { bookings: await listCustomerBookings(db, s.userId) });
  }

  if (method === 'POST' && seg[0] === 'api' && seg[1] === 'me' && seg[2] === 'bookings' && seg[4] === 'cancel' && seg.length === 5) {
    const s = await session(db, req);
    const bookingId = uuid(seg[3]!, 'bookingId');
    const result = await customerCancelBooking(db, s.userId, bookingId);
    await cache.invalidate(result.salonId);
    return json(res, 200, { ok: true, booking: result });
  }

  // §4: move a no-show or a cancellation to a new slot within 36 hours, at no
  // extra charge. One transaction — see booking/reschedule.ts.
  if (
    method === 'POST' &&
    seg[0] === 'api' &&
    seg[1] === 'me' &&
    seg[2] === 'bookings' &&
    seg[4] === 'reschedule' &&
    seg.length === 5
  ) {
    const s = await session(db, req);
    const bookingId = uuid(seg[3]!, 'bookingId');
    const body = await readJson(req);
    const startAt = isoDate(body['startAt']);

    const result = await rescheduleBooking(db, { bookingId, customerId: s.userId, startAt }, { cache });
    return json(res, 201, {
      id: result.booking.id,
      previousBookingId: result.previousBookingId,
      salonId: result.booking.salonId,
      startAt: result.booking.startAt.toISOString(),
      endAt: result.booking.endAt.toISOString(),
      amount: result.booking.amount,
      status: result.booking.status,
      paid: true,
    });
  }

  if (method === 'GET' && path === '/api/me/favorites') {
    const s = await session(db, req);
    return json(res, 200, { salonIds: await listFavorites(db, s.userId) });
  }

  if (method === 'POST' && path === '/api/me/favorites') {
    const s = await session(db, req);
    const body = await readJson(req);
    const salonId = uuid(String(body['salonId'] ?? ''), 'salonId');
    await addFavorite(db, s.userId, salonId);
    return json(res, 201, { ok: true });
  }

  if (
    method === 'DELETE' &&
    seg[0] === 'api' &&
    seg[1] === 'me' &&
    seg[2] === 'favorites' &&
    seg.length === 4
  ) {
    const s = await session(db, req);
    await removeFavorite(db, s.userId, uuid(seg[3]!, 'salonId'));
    return json(res, 200, { ok: true });
  }

  // ---------- booking + payment ----------
  //
  // Step 1 of two. This takes the chair and opens a Razorpay order; the booking
  // exists as 'pending_payment' and is holding a real slot from this moment.
  // §4 describes the reverse order (pay, then create) — that version has
  // nothing holding the chair while the payment sheet is open, so two customers
  // on the last chair both pay and one is refunded. See db/migrations/003.
  if (method === 'POST' && path === '/api/bookings') {
    // Authenticate before touching the body: an unauthenticated request should
    // not get 64KB of parsing done on its behalf.
    const customer = await session(db, req);
    limits.booking.check(`book:${customer.userId}`);

    const body = await readJson(req);
    const salonId = uuid(String(body['salonId'] ?? ''), 'salonId');
    const serviceIds = stringArray(body['serviceIds'], 'serviceIds');
    const startAt = isoDate(body['startAt']);

    const out = await withIdempotency<BookingResponse>(db, req, customer.userId, 'POST /api/bookings', body, async () => {
      const booking = await createBooking(
        db,
        { salonId, customerId: customer.userId, serviceIds, startAt },
        { cache, holdTtlMs: payments.enabled ? payments.holdTtlMs : 0 },
      );

      if (!payments.enabled) {
        // Only reachable in dev with no Razorpay keys. start() refuses to boot
        // in production without them, so this cannot silently ship.
        return {
          status: 201,
          body: {
            id: booking.id,
            salonId: booking.salonId,
            startAt: booking.startAt.toISOString(),
            endAt: booking.endAt.toISOString(),
            amount: booking.amount,
            status: booking.status,
            paid: false,
            warning: 'Payments are not configured on this server; the booking was created unpaid.',
          },
        };
      }

      const checkout = await openCheckout(db, payments, booking.id, customer.userId);
      return {
        status: 201,
        body: {
          id: booking.id,
          salonId: booking.salonId,
          startAt: booking.startAt.toISOString(),
          endAt: booking.endAt.toISOString(),
          amount: booking.amount,
          status: booking.status,
          holdExpiresAt: booking.holdExpiresAt ? booking.holdExpiresAt.toISOString() : null,
          paid: false,
          checkout,
        },
      };
    });

    return json(res, out.status, out.body);
  }

  // Re-open checkout for a hold that is still live — a customer who reloaded
  // the page, or dismissed the sheet and changed their mind.
  if (
    method === 'POST' &&
    seg[0] === 'api' &&
    seg[1] === 'bookings' &&
    seg[3] === 'checkout' &&
    seg.length === 4
  ) {
    const customer = await session(db, req);
    const bookingId = uuid(seg[2]!, 'bookingId');
    return json(res, 200, await openCheckout(db, payments, bookingId, customer.userId));
  }

  // Step 2 of two: the browser's success callback. The signature is what makes
  // this endpoint safe to expose — see payments/service.ts.
  if (
    method === 'POST' &&
    seg[0] === 'api' &&
    seg[1] === 'bookings' &&
    seg[3] === 'confirm' &&
    seg.length === 4
  ) {
    const customer = await session(db, req);
    const bookingId = uuid(seg[2]!, 'bookingId');
    const body = await readJson(req);

    const result = await confirmCheckout(
      db,
      payments,
      {
        bookingId,
        customerId: customer.userId,
        orderId: String(body['razorpay_order_id'] ?? ''),
        paymentId: String(body['razorpay_payment_id'] ?? ''),
        signature: String(body['razorpay_signature'] ?? ''),
      },
      { cache },
    );

    // 202 for a payment that landed too late: the money is real, the booking is
    // not, and a refund is queued. A 200 here would have the app show a
    // confirmation screen for a booking that does not exist.
    return json(res, result.outcome === 'refunding' ? 202 : 200, {
      bookingId: result.bookingId,
      outcome: result.outcome,
      status: result.status,
      paid: result.outcome !== 'refunding',
      message:
        result.outcome === 'refunding'
          ? 'Your payment arrived after the slot was taken. A full refund is on its way.'
          : 'Booking confirmed.',
    });
  }

  if (method === 'GET' && seg[0] === 'api' && seg[1] === 'bookings' && seg.length === 3) {
    const booking = await getBooking(db, uuid(seg[2]!, 'bookingId'));
    if (!booking) throw new HttpError(404, 'Booking not found');
    return json(res, 200, booking);
  }

  throw new HttpError(404, `No route for ${method} ${path}`);
}

function isoDate(value: unknown): Date {
  if (typeof value !== 'string') throw new HttpError(400, 'startAt must be an ISO-8601 string');
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'startAt is not a valid date');
  return d;
}

/**
 * Turn a thrown error into a response.
 *
 * Every branch here is a deliberate status code. The default is 500 with no
 * detail: an unexpected error's message can contain a SQL fragment or a
 * connection string, and the customer does not need either.
 */
function respondToError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return;

  if (err instanceof RateLimitError) {
    res.setHeader('retry-after', String(err.retryAfterSec));
    return json(res, 429, { error: err.message, code: 'RATE_LIMITED' });
  }
  if (err instanceof HttpError) return json(res, err.status, { error: err.message });
  if (err instanceof AuthError) return json(res, err.status, { error: err.message, code: err.code });
  if (err instanceof ForbiddenError) return json(res, 403, { error: err.message, code: err.code });
  if (err instanceof WebhookSignatureError) {
    // 400, not 401: Razorpay does not retry a 4xx, and a body we cannot verify
    // is one we never want again.
    return json(res, 400, { error: 'Invalid signature', code: 'BAD_SIGNATURE' });
  }
  if (err instanceof SlotUnavailableError) {
    return json(res, 409, { error: err.message, code: err.code });
  }
  if (err instanceof PaymentError) {
    const status =
      err.code === 'BAD_SIGNATURE' ? 403
      : err.code === 'PAYMENT_NOT_FOUND' ? 404
      : err.code === 'PAYMENTS_DISABLED' ? 503
      : err.code === 'VERIFY_UNAVAILABLE' ? 503
      : 400;
    return json(res, status, { error: err.message, code: err.code });
  }
  if (err instanceof BookingError) {
    const status =
      err.code === 'CUSTOMER_BLOCKED' ? 403
      : err.code === 'NOT_FOUND' ? 404
      : err.code === 'INVALID_TRANSITION' ? 409
      : err.code === 'RESCHEDULE_LIMIT' ? 409
      : err.code === 'RESCHEDULE_EXPIRED' ? 410
      : 400;
    return json(res, status, { error: err.message, code: err.code });
  }

  reportError(err, { unhandled: true });
  return json(res, 500, { error: 'Internal error' });
}

export function buildServer(db: Pool): Server {
  return createServer((req, res) => {
    const requestId = newRequestId(req.headers['x-request-id']);
    const startedAt = Date.now();

    void withRequestContext({ requestId, route: `${req.method} ${req.url}` }, async () => {
      res.setHeader('x-request-id', requestId);
      securityHeaders(res, IS_PROD);

      res.on('finish', () => {
        const ms = Date.now() - startedAt;
        // Assets are the majority of requests and none of the interest.
        const noisy = req.url?.startsWith('/lib/') || req.url?.startsWith('/components/') ||
                      req.url?.startsWith('/views/') || req.url?.endsWith('.css');
        if (!noisy || res.statusCode >= 400) {
          log[res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info']('request', {
            method: req.method,
            path: req.url,
            status: res.statusCode,
            ms,
          });
        }
      });

      try {
        if (applyCors(req, res, allowedOrigins)) return;
        // The webhook is exempt: Razorpay's retry storm during an incident is
        // exactly when we must not start dropping their deliveries, and the
        // signature already gates it.
        if (req.url !== '/api/webhooks/razorpay') {
          limits.global.check(clientKey(req, TRUST_PROXY));
        }
        await route(db, req, res);
      } catch (err) {
        respondToError(res, err);
      }
    });
  });
}

export function start(): void {
  if (IS_PROD) {
    const fatal: string[] = [];

    // Both flags, not just their conjunction. Either one set in production is
    // a misconfiguration worth refusing on: DEV_AUTH means someone intended
    // the bypass, and CI_SMOKE is the other half of the key.
    if (DEV_AUTH_REQUESTED) {
      fatal.push(
        'DEV_AUTH=true trusts an unverified x-dev-user header. Anyone could book, ' +
          'cancel, or edit any salon as anyone else.',
      );
    }
    if (CI_SMOKE) {
      fatal.push(
        'CI_SMOKE=true enables the DEV_AUTH bypass and the /api/dev/* routes. ' +
          'It exists for the smoke test harness and must never be set in production.',
      );
    }
    // Fail at boot, not on the first customer's request.
    if (!process.env['FIREBASE_SERVICE_ACCOUNT'] && !process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
      fatal.push(
        'No Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT (inline JSON) or ' +
          'GOOGLE_APPLICATION_CREDENTIALS (path).',
      );
    }
    if (!payments.enabled) {
      fatal.push(
        'No Razorpay credentials. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET. ' +
          'Without them the server would take bookings without taking money.',
      );
    }
    if (!process.env['RAZORPAY_WEBHOOK_SECRET']) {
      fatal.push(
        'No RAZORPAY_WEBHOOK_SECRET. Without it every webhook fails its signature ' +
          'check, and any customer who closes the tab mid-payment is debited with ' +
          'no booking.',
      );
    }

    if (fatal.length > 0) {
      console.error('Refusing to start:\n' + fatal.map((f) => `  - ${f}`).join('\n'));
      process.exit(1);
    }
  }

  const port = Number(process.env['PORT'] ?? 3000);
  const db = getPool();
  const server = buildServer(db);

  let workers: RunningWorkers | null = null;
  // One process runs both by default, which is right for one box. Set
  // RUN_WORKERS=false on the web tier and true on a worker dyno to split them;
  // the advisory locks in workers/runner.ts already make that safe.
  if (process.env['RUN_WORKERS'] !== 'false') {
    workers = startWorkers({
      db,
      razorpay: payments.client,
      channel: channelFromEnv(),
      cache,
    });
  }

  server.listen(port, () => {
    log.info('listening', {
      port,
      auth: DEV_AUTH ? 'DEV_AUTH' : verifier.kind,
      payments: payments.enabled ? payments.client.kind : 'disabled',
      workers: workers ? 'in-process' : 'off',
    });
    console.log(`hasino  →  http://localhost:${port}          (customer)`);
    console.log(`        →  http://localhost:${port}/business (salon panel)`);
    if (DEV_AUTH) {
      log.warn('DEV_AUTH is on — authentication is bypassed. CI only.');
    } else if (DEV_AUTH_REQUESTED) {
      // Ignored, loudly. Silently honouring it would be a server that trusts a
      // header; silently dropping it would look like the flag was broken.
      log.warn(
        'DEV_AUTH=true was ignored: it now also requires CI_SMOKE=true, which exists ' +
          'for the smoke-test harness. Local development signs in with real Google auth — ' +
          'set the FIREBASE_WEB_* variables in .env. Authentication is ON.',
      );
    }
    if (!payments.enabled) console.warn('Razorpay is not configured — bookings will be unpaid.');
  });

  /**
   * Shutdown, in order: stop accepting, let in-flight requests finish, stop the
   * workers, then close the pool. A hard deadline sits over the whole thing
   * because an orchestrator will SIGKILL after ~30s regardless, and a
   * half-finished graceful shutdown is worse than a clean fast one.
   */
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });

    const deadline = setTimeout(() => {
      log.warn('shutdown deadline exceeded, exiting anyway');
      process.exit(1);
    }, 15_000);
    deadline.unref();

    server.close(() => {
      void (async () => {
        try {
          await workers?.stop();
          await db.end();
        } catch (err) {
          reportError(err, { during: 'shutdown' });
        }
        clearTimeout(deadline);
        process.exit(0);
      })();
    });
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown(signal));

  // A rejection nobody handled is a bug, and a process that keeps serving after
  // one is a process in an unknown state. Log it with its stack and let the
  // orchestrator restart a clean one.
  process.on('unhandledRejection', (reason) => {
    reportError(reason, { fatal: 'unhandledRejection' });
  });
  process.on('uncaughtException', (err) => {
    reportError(err, { fatal: 'uncaughtException' });
    shutdown('uncaughtException');
  });
}
