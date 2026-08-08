import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { getPool, type Pool } from '../db/pool.ts';
import { MemorySnapshotCache } from '../availability/cache.ts';
import { getAvailability } from '../availability/service.ts';
import { loadCart } from '../availability/repo.ts';
import { createBooking } from '../booking/create.ts';
import { customerCancelBooking } from '../booking/status.ts';
import { BookingError, SlotUnavailableError } from '../booking/errors.ts';
import { ForbiddenError, listCustomerBookings } from '../business/repo.ts';
import { addFavorite, getBooking, getSalon, listFavorites, listSalons, removeFavorite } from '../salons/repo.ts';
import { businessRoutes } from './routes-business.ts';
import { HttpError, json, loadAssets, readJson, sendAsset, stringArray, uuid } from './respond.ts';
import { AuthError, verifierFromEnv } from '../auth/verifier.ts';
import { type Session, authenticate, requireRole } from '../auth/session.ts';

/**
 * DEV_AUTH=true swaps Firebase token verification for a header naming the
 * user directly — anyone can act as anyone. The server refuses to start with
 * it in production; see start().
 */
const DEV_AUTH = process.env.DEV_AUTH === 'true';
const verifier = verifierFromEnv(DEV_AUTH);

const cache = new MemorySnapshotCache();

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
      return authenticate(db, verifier, `Bearer ${dev}`);
    }
  }
  return authenticate(db, verifier, req.headers.authorization);
}

async function route(db: Pool, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  const seg = path.split('/').filter(Boolean);

  // ---------- pages + assets ----------
  // Pages are served either way — production users sign in with real Google
  // auth. Only the x-dev-user bypass and /api/dev/identities (below) are
  // DEV_AUTH-only.
  const page = PAGES[path];
  if (method === 'GET' && page) {
    return sendAsset(res, assets.get(page)!);
  }

  if (method === 'GET' && assets.has(path.slice(1))) {
    return sendAsset(res, assets.get(path.slice(1))!);
  }

  if (method === 'GET' && path === '/favicon.ico') {
    res.writeHead(204);
    return void res.end();
  }

  if (method === 'GET' && path === '/health') {
    await db.query('SELECT 1');
    return json(res, 200, { ok: true, auth: DEV_AUTH ? 'DEV_AUTH (insecure)' : verifier.kind });
  }

  // The client Firebase config is not secret, but it's still environment-
  // specific — served from env so it's not hardcoded into a checked-in file.
  if (method === 'GET' && path === '/api/config') {
    return json(res, 200, {
      firebase: {
        apiKey: process.env.FIREBASE_WEB_API_KEY ?? null,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN ?? null,
        projectId: process.env.FIREBASE_PROJECT_ID ?? null,
        appId: process.env.FIREBASE_APP_ID ?? null,
      },
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

  if (method === 'POST' && path === '/api/bookings') {
    // Authenticate before touching the body: an unauthenticated request should
    // not get 64KB of parsing done on its behalf.
    const customer = await session(db, req);
    const body = await readJson(req);
    const salonId = uuid(String(body['salonId'] ?? ''), 'salonId');
    const serviceIds = stringArray(body['serviceIds'], 'serviceIds');
    const startAtRaw = body['startAt'];
    if (typeof startAtRaw !== 'string') throw new HttpError(400, 'startAt must be an ISO-8601 string');
    const startAt = new Date(startAtRaw);
    if (Number.isNaN(startAt.getTime())) throw new HttpError(400, 'startAt is not a valid date');

    // NOTE: no payment. Spec §4 is pay-then-create; Razorpay is build order
    // steps 4-5 and is not built. This creates an unpaid booking.
    const booking = await createBooking(
      db,
      { salonId, customerId: customer.userId, serviceIds, startAt },
      { cache },
    );

    return json(res, 201, {
      id: booking.id,
      salonId: booking.salonId,
      startAt: booking.startAt.toISOString(),
      endAt: booking.endAt.toISOString(),
      amount: booking.amount,
      slots: booking.slots.map((s) => s.toISOString()),
      paid: false,
      warning: 'Payment is not implemented — this booking holds a chair without money attached.',
    });
  }

  if (method === 'GET' && seg[0] === 'api' && seg[1] === 'bookings' && seg.length === 3) {
    const booking = await getBooking(db, uuid(seg[2]!, 'bookingId'));
    if (!booking) throw new HttpError(404, 'Booking not found');
    return json(res, 200, booking);
  }

  throw new HttpError(404, `No route for ${method} ${path}`);
}

export function buildServer(db: Pool) {
  return createServer((req, res) => {
    void route(db, req, res).catch((err: unknown) => {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      if (err instanceof AuthError) return json(res, err.status, { error: err.message, code: err.code });
      if (err instanceof ForbiddenError) return json(res, 403, { error: err.message, code: err.code });
      if (err instanceof SlotUnavailableError) {
        return json(res, 409, { error: err.message, code: err.code });
      }
      if (err instanceof BookingError) {
        const status =
          err.code === 'CUSTOMER_BLOCKED' ? 403
          : err.code === 'NOT_FOUND' ? 404
          : err.code === 'INVALID_TRANSITION' ? 409
          : 400;
        return json(res, status, { error: err.message, code: err.code });
      }
      console.error('unhandled', err);
      return json(res, 500, { error: 'Internal error' });
    });
  });
}

export function start(): void {
  if (process.env.NODE_ENV === 'production') {
    if (DEV_AUTH) {
      console.error(
        'Refusing to start: DEV_AUTH=true trusts an unverified x-dev-user header.\n' +
          'Anyone could book, cancel, or edit any salon as anyone else.',
      );
      process.exit(1);
    }
    // Fail at boot, not on the first customer's request.
    if (!process.env.FIREBASE_SERVICE_ACCOUNT && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.error(
        'Refusing to start: no Firebase credentials.\n' +
          'Set FIREBASE_SERVICE_ACCOUNT (inline JSON) or GOOGLE_APPLICATION_CREDENTIALS (path).\n' +
          'Without them every authenticated request would fail at runtime instead.',
      );
      process.exit(1);
    }
  }

  const port = Number(process.env.PORT ?? 3000);
  const db = getPool();
  const server = buildServer(db);

  server.listen(port, () => {
    console.log(`hasino  →  http://localhost:${port}          (customer)`);
    console.log(`        →  http://localhost:${port}/business (salon panel)`);
    if (DEV_AUTH) console.warn('DEV_AUTH is on — authentication is bypassed. Local use only.');
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => {
        void db.end().then(() => process.exit(0));
      });
    });
  }
}
