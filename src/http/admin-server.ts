/**
 * The Hasino admin panel — a separate process, bound to loopback.
 *
 * This is not part of the public application and is not reachable from it.
 * The public server serves the customer app and the salon panel and has no
 * admin route, no admin asset and no admin API; everything the operator uses
 * lives here, behind an address the internet cannot route to.
 *
 * Why a second process rather than a flag on the first
 * ----------------------------------------------------
 * A flag is a runtime decision, and the failure mode of a runtime decision is
 * that it is wrong in production — one missing environment variable and the
 * admin panel is on the public internet. Binding to 127.0.0.1 is enforced by
 * the operating system: no port forward, firewall rule or reverse proxy makes
 * a loopback socket reachable from another machine.
 *
 * Same data, not a copy
 * ---------------------
 * This connects to whatever DATABASE_URL points at, which in production is the
 * production database over an SSH tunnel. There is no local mirror to sync and
 * no second source of truth — an approval here is immediately visible to the
 * deployed app because it is the same row. See DEPLOY.md.
 *
 * Loopback is not the authorisation
 * ---------------------------------
 * Every route still runs requireRole(s, 'admin') against a verified Clerk
 * token. Anyone with an account on this laptop can reach this port, and
 * "the network already checked" is how an internal tool ends up with no
 * checks at all.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { getPool, type Pool } from '../db/pool.ts';
import { MemorySnapshotCache } from '../availability/cache.ts';
import { adminRoutes } from './routes-admin.ts';
import { HttpError, json, loadAssets, sendAsset } from './respond.ts';
import { respondToError } from './server.ts';
import { securityHeaders } from './middleware.ts';
import { verifierFromEnv } from '../auth/verifier.ts';
import { type Session, authenticate, requireRole } from '../auth/session.ts';
import { annotate, log, newRequestId, reportError, withRequestContext } from '../obs/logger.ts';

const DEV_AUTH = process.env['DEV_AUTH'] === 'true' && process.env['CI_SMOKE'] === 'true';
const verifier = verifierFromEnv(DEV_AUTH);

/**
 * Loopback only, and deliberately awkward to change.
 *
 * ADMIN_HOST exists so a operator who genuinely needs another interface — a
 * VPN address, say — can have one, but it has to be typed on purpose. The
 * default can never accidentally become 0.0.0.0.
 */
const HOST = process.env['ADMIN_HOST'] ?? '127.0.0.1';
const PORT = Number(process.env['ADMIN_PORT'] ?? 4000);

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

  securityHeaders(res, false);

  // The panel boots clerk-js with this, exactly as the public app does. The
  // publishable key is not a secret; it ships to every browser by design.
  if (read && path === '/api/config') {
    return json(res, 200, {
      clerk: { publishableKey: process.env['CLERK_PUBLISHABLE_KEY'] ?? null },
    });
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
  if (process.env['NODE_ENV'] === 'production' && HOST !== '127.0.0.1' && HOST !== '::1') {
    // Not a warning. The whole design is "the operating system refuses the
    // connection", and a production bind to anything routable throws that away.
    throw new Error(
      `Refusing to start: ADMIN_HOST=${HOST} in production would put the admin panel on a ` +
        'reachable interface. Run it on your own machine against the production database ' +
        'over an SSH tunnel — see DEPLOY.md.',
    );
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
    log.info('admin panel listening', { host: HOST, port: PORT, auth: verifier.kind });
    const emails = process.env['ADMIN_EMAILS'] ?? '';
    console.log(`\n  Hasino admin   http://${HOST}:${PORT}`);
    console.log(`  ${emails ? `${emails} gets in.` : 'ADMIN_EMAILS is empty — nobody can get in.'}`);
    console.log('  Private to this machine. The public app has no admin route.\n');
  });

  return server;
}
