import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { getPool, type Pool } from '../db/pool.ts';
import { MemorySnapshotCache } from '../availability/cache.ts';
import { getAvailability } from '../availability/service.ts';
import { loadCart } from '../availability/repo.ts';
import { createBooking } from '../booking/create.ts';
import { BookingError, SlotUnavailableError } from '../booking/errors.ts';
import { ForbiddenError, listCustomerBookings } from '../business/repo.ts';
import { getBooking, getSalon, listSalons } from '../salons/repo.ts';
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
  const page = PAGES[path];
  if (method === 'GET' && page) {
    if (!DEV_AUTH) {
      return json(res, 200, {
        service: 'hasino-api',
        ui: 'disabled (DEV_AUTH is off)',
        pages: Object.keys(PAGES),
      });
    }
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
    return json(res, 200, { salons: await listSalons(db, q) });
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
    return json(res, 200, { id: s.userId, role: s.role, phone: s.phone, name: s.name, blockedUntil: s.blockedUntil });
  }

  if (method === 'GET' && path === '/api/me/bookings') {
    const s = await session(db, req);
    return json(res, 200, { bookings: await listCustomerBookings(db, s.userId) });
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
