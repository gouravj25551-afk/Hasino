/**
 * The Hasino admin panel — a separate process, on loopback by default.
 *
 * This is not part of the public application and is not reachable from it.
 * The public server serves the customer app and the salon panel and has no
 * admin route, no admin asset and no admin API; everything the operator uses
 * lives here, in its own process on its own port.
 *
 * ADMIN_PUBLIC=true hosts it on the internet instead — for an operator who
 * needs to approve a salon without their laptop. That is a genuine reduction
 * in defence, not a deployment detail: read the note on PUBLIC below before
 * setting it, and see startAdmin() for what it refuses to come up without.
 *
 * Why a second process rather than a flag on the first
 * ----------------------------------------------------
 * Still the reason it is separate even when both are hosted: the public app
 * cannot serve an admin route it does not have. A flag on one server is a
 * runtime decision, and the failure mode of a runtime decision is that it is
 * wrong in production. Two processes means the customer-facing service has no
 * admin code in it to expose, whatever its configuration says — which is why
 * hosting this one changes nothing about that one.
 *
 * Same data, not a copy
 * ---------------------
 * This connects to whatever DATABASE_URL points at — the production database,
 * whether that is over a tunnel from a laptop or from a second hosted service.
 * There is no local mirror to sync and no second source of truth: an approval
 * here is immediately visible to the deployed app because it is the same row.
 * See DEPLOY.md.
 *
 * The network was never the authorisation
 * ----------------------------------------
 * Every route runs requireRole(s, 'admin') against a verified Clerk token, and
 * always has. On loopback that was the second lock — anyone with an account on
 * the laptop can reach the port, and "the network already checked" is how an
 * internal tool ends up with no checks at all. Public, it is the only lock,
 * which is why it was worth writing that way from the start.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { getPool, type Pool } from '../db/pool.ts';
import { MemorySnapshotCache } from '../availability/cache.ts';
import { adminRoutes } from './routes-admin.ts';
import { HttpError, json, loadAssets, sendAsset, uuid } from './respond.ts';
import { serveSalonImage } from '../salons/images.ts';
import { respondToError } from './server.ts';
import { RateLimiter, clientKey, securityHeaders } from './middleware.ts';
import { verifierFromEnv } from '../auth/verifier.ts';
import { type Session, authenticate, requireRole } from '../auth/session.ts';
import { annotate, log, newRequestId, reportError, withRequestContext } from '../obs/logger.ts';

const DEV_AUTH = process.env['DEV_AUTH'] === 'true' && process.env['CI_SMOKE'] === 'true';
const verifier = verifierFromEnv(DEV_AUTH);
const IS_PROD = process.env['NODE_ENV'] === 'production';

/**
 * ADMIN_PUBLIC=true hosts the panel on the internet instead of on loopback.
 *
 * This is a real reduction in defence and is written as one variable you have
 * to set on purpose, rather than as a host that can be nudged. Off, the
 * operating system refuses every connection from another machine and Clerk is
 * the second lock. On, Clerk and ADMIN_EMAILS are the *only* locks — every
 * /api/admin/* route still runs requireRole(s,'admin') against a verified
 * token, which was always true and is now the entire perimeter.
 *
 * The trade is deliberate: an operator who needs to approve a salon from a
 * phone cannot do it through a loopback socket. startAdmin() below refuses to
 * come up public with anything about that perimeter missing.
 */
const PUBLIC = process.env['ADMIN_PUBLIC'] === 'true';

/**
 * Loopback unless the panel is deliberately public.
 *
 * ADMIN_HOST still exists for the operator who needs one specific interface —
 * a VPN address, say — and still has to be typed on purpose. What it can no
 * longer do is become 0.0.0.0 by accident: that now takes ADMIN_PUBLIC, whose
 * only meaning is "on the internet".
 */
const HOST = process.env['ADMIN_HOST'] ?? (PUBLIC ? '0.0.0.0' : '127.0.0.1');

/**
 * ADMIN_PORT for a local panel; PORT is what a host injects. Both, because the
 * public app runs beside this one locally and 4000 keeps them apart, while on
 * Render the port is assigned and not ours to pick.
 */
const PORT = Number(process.env['ADMIN_PORT'] ?? process.env['PORT'] ?? 4000);

/**
 * Only meaningful when hosted: behind Render's proxy every request otherwise
 * looks like it came from the proxy, and one caller would rate-limit everyone.
 */
const TRUST_PROXY = process.env['TRUST_PROXY'] === 'true';

/**
 * There was no rate limit here while the panel was on loopback, because the
 * operating system was the limit. On the internet an unauthenticated caller
 * can reach the door, so the door gets a budget: enough for an operator
 * clicking through salons, not enough to grind tokens against /api/me.
 */
const limit = new RateLimiter(Number(process.env['ADMIN_RATE_LIMIT_PER_MIN'] ?? 120));

/**
 * Only what the panel actually loads. The public app's assets are not served
 * here and this server's assets are not served there — neither can drift into
 * the other by being in the same directory listing.
 */
const assets = loadAssets(new URL('./public/', import.meta.url), [
  'admin.html',
  'admin.js',
  'brand.css',
  'lib/auth.js',
  'lib/dialog.js',
  // Shared components. admin.js keeps its own tiny `el` helper, but the empty
  // and loading states are the same ones the customer app uses — a second
  // implementation here is how two panels drift apart.
  'lib/dom.js',
  'components/EmptyState.js',
  'components/Skeleton.js',
]);

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

const cache = new MemorySnapshotCache();

async function handle(db: Pool, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const seg = path.split('/').filter(Boolean);
  const read = method === 'GET' || method === 'HEAD';

  // HSTS only when this is a hosted HTTPS panel; sending it from a local
  // http://127.0.0.1 pins the browser and breaks development for months.
  securityHeaders(res, IS_PROD && PUBLIC);

  if (PUBLIC) limit.check(clientKey(req, TRUST_PROXY));

  // The panel boots clerk-js with this, exactly as the public app does. The
  // publishable key is not a secret; it ships to every browser by design.
  if (read && path === '/api/config') {
    return json(res, 200, {
      clerk: { publishableKey: process.env['CLERK_PUBLISHABLE_KEY'] ?? null },
    });
  }

  // GET /api/salons/:id/image — the same bytes the public server serves.
  //
  // Needed here because salons.cover_url is an origin-relative path, and this
  // panel is a different origin: without this route the admin's own <img> for
  // a salon they just photographed would 404 while the customer app shows it
  // perfectly. Reading a shop's storefront photo is not privileged — it is on
  // a public salon card — so this sits with /api/config rather than behind the
  // admin session check.
  if (read && seg[0] === 'api' && seg[1] === 'salons' && seg[3] === 'image' && seg.length === 4) {
    const served = await serveSalonImage(db, uuid(seg[2]!, 'salonId'), req, res);
    if (served) return;
    throw new HttpError(404, 'This salon has no image');
  }

  // Who am I. The panel shows the signed-in address and refuses to render for
  // a non-admin; the server refuses regardless.
  if (method === 'GET' && path === '/api/me') {
    const s = await session(db, req);
    return json(res, 200, {
      id: s.userId,
      role: s.role,
      name: s.name,
      email: s.email,
      phone: s.phone,
      avatarUrl: s.avatarUrl,
      blockedUntil: s.blockedUntil,
    });
  }

  if (seg[0] === 'api' && seg[1] === 'admin') {
    const s = await session(db, req);
    requireRole(s, 'admin');
    const handled = await adminRoutes(db, req, res, { seg, method, url, adminUserId: s.userId, cache });
    if (handled) return;
    throw new HttpError(404, `No route for ${method} ${path}`);
  }

  // The panel is a hash-routed single page, so every path serves the shell.
  // /sso-callback included: Clerk returns the browser there after Google, with
  // its parameters in the query string, and admin.js completes the handshake.
  // The panel signs in on its own origin because a Clerk session belongs to
  // one origin — being signed in on the public app at :3000 grants nothing
  // here, which is exactly the separation that was asked for.
  if (read && (path === '/' || path === '/admin' || path === '/sso-callback')) {
    return sendAsset(res, assets.get('admin.html')!, req);
  }
  if (read && assets.has(path.slice(1))) {
    return sendAsset(res, assets.get(path.slice(1))!, req);
  }
  if (read && path === '/favicon.ico') {
    res.writeHead(204);
    return void res.end();
  }

  throw new HttpError(404, `No route for ${method} ${path}`);
}

export function startAdmin(): Server {
  const loopback = HOST === '127.0.0.1' || HOST === '::1';

  if (IS_PROD && !loopback && !PUBLIC) {
    // Unchanged for anyone who has not opted in. Reaching a routable interface
    // by editing ADMIN_HOST alone is still refused, because that is the shape
    // a mistake takes — ADMIN_PUBLIC is the shape a decision takes.
    throw new Error(
      `Refusing to start: ADMIN_HOST=${HOST} in production would put the admin panel on a ` +
        'reachable interface. Run it on your own machine against the production database, ' +
        'or set ADMIN_PUBLIC=true to host it deliberately — see DEPLOY.md.',
    );
  }

  if (PUBLIC) {
    // Public means Clerk and ADMIN_EMAILS are the whole perimeter, so refuse to
    // come up with any part of it missing. Every one of these would otherwise
    // fail open or fail silently: a panel anyone can enter, a panel nobody can
    // enter, or a panel that cannot verify a token at all.
    const fatal: string[] = [];

    if (process.env['DEV_AUTH'] === 'true' || process.env['CI_SMOKE'] === 'true') {
      fatal.push(
        'DEV_AUTH/CI_SMOKE trust an unverified x-dev-user header. On a public admin panel ' +
          'that is a header away from every admin route.',
      );
    }
    if (!process.env['CLERK_SECRET_KEY']) {
      fatal.push('No CLERK_SECRET_KEY. Nothing could verify a token, so nothing could be trusted.');
    }
    if (!process.env['CLERK_PUBLISHABLE_KEY']) {
      fatal.push('No CLERK_PUBLISHABLE_KEY. The panel would load and nobody could sign in.');
    }
    if (!(process.env['ADMIN_EMAILS'] ?? '').trim()) {
      fatal.push(
        'ADMIN_EMAILS is empty, so no sign-in can ever be promoted to admin. A public panel ' +
          'nobody can enter is not a safe default, it is a deployment that was never wired up.',
      );
    }
    if (!IS_PROD) {
      fatal.push(
        'ADMIN_PUBLIC=true without NODE_ENV=production. The production guards elsewhere — ' +
          'and HSTS here — key off NODE_ENV, so this combination is half-hosted.',
      );
    }

    if (fatal.length > 0) {
      throw new Error(
        `Refusing to start a public admin panel:\n  - ${fatal.join('\n  - ')}\n\n` +
          'Fix these or unset ADMIN_PUBLIC to go back to loopback.',
      );
    }
  }

  const db = getPool();
  const server = createServer((req, res) => {
    const requestId = newRequestId();
    withRequestContext({ requestId }, async () => {
      const started = Date.now();
      try {
        await handle(db, req, res);
      } catch (err) {
        reportError(err);
        respondToError(res, err);
      } finally {
        log.info('request', {
          requestId,
          method: req.method,
          path: (req.url ?? '').split('?')[0],
          status: res.statusCode,
          ms: Date.now() - started,
        });
      }
    });
  });

  server.listen(PORT, HOST, () => {
    log.info('admin panel listening', {
      host: HOST,
      port: PORT,
      auth: verifier.kind,
      exposure: PUBLIC ? 'public' : 'loopback',
    });
    const emails = process.env['ADMIN_EMAILS'] ?? '';
    console.log(`\n  Hasino admin   http://${HOST}:${PORT}`);
    console.log(`  ${emails ? `${emails} gets in.` : 'ADMIN_EMAILS is empty — nobody can get in.'}`);
    console.log(
      PUBLIC
        ? '  PUBLIC — reachable from the internet. Clerk and ADMIN_EMAILS are the only locks.\n'
        : '  Private to this machine. The public app has no admin route.\n',
    );
  });

  return server;
}
