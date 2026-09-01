/**
 * Talks to the Hasino API: attaches an auth header, retries once on 401 after
 * a forced token refresh, and normalises errors to a single shape components
 * can render without knowing which endpoint failed.
 */
import { currentIdToken } from './auth.js';

export class ApiError extends Error {
  constructor(message, status, code, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function authHeader(forceRefresh) {
  try {
    const token = await currentIdToken(forceRefresh);
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    // Clerk not configured, or not yet initialized — browsing is public,
    // so a public request must still go out unauthenticated rather than fail.
    return {};
  }
}

async function doFetch(path, opts, forceRefresh) {
  const headers = {
    'content-type': 'application/json',
    ...(await authHeader(forceRefresh)),
    ...(opts.headers ?? {}),
  };
  const res = await fetch(path, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

// A waking free-tier server (Render sleeps after ~15 min idle) is the reason
// this exists: the first request after a cold start can be refused, reset, or
// answered with a 502/503/504 by the proxy before the app is up. Riding those
// out here is what turns "the server is waking up" into "Hasino is loading" —
// the view keeps its skeletons and the customer never has to refresh.
const RETRYABLE_STATUS = new Set([502, 503, 504]);
// Backoff between attempts (ms), capped. ~15s total, which covers a cold start
// that answers with errors; a cold start that instead just holds the
// connection open needs none of this and simply resolves slowly.
const BACKOFF_MS = [800, 1600, 3200, 5000, 5000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Only reads are retried on a transient failure. A GET is idempotent, so
 * repeating it cannot create a second booking or charge a card twice — the
 * exact hazard §8 warns about — whereas a POST that timed out *might* have
 * been applied, so it is surfaced rather than resent. The one retry that all
 * methods share is the 401 refresh below, and that is safe because a 401 is
 * rejected before the handler runs: nothing was mutated.
 */
function isRetryableRead(opts) {
  const method = (opts.method ?? 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD';
}

export async function api(path, opts = {}) {
  const maxTransient = isRetryableRead(opts) ? BACKOFF_MS.length : 0;
  let transient = 0;
  let triedRefresh = false;

  for (;;) {
    let res;
    let body;
    try {
      ({ res, body } = await doFetch(path, opts, triedRefresh));
    } catch {
      // fetch rejects on a dropped/refused connection — what a waking server
      // does to the first request. Retry a read; give up with a message that
      // says nothing about infrastructure.
      if (transient < maxTransient) {
        await sleep(BACKOFF_MS[transient++]);
        continue;
      }
      throw new ApiError(
        'Could not reach Hasino. Check your connection and try again.',
        0,
        'NETWORK',
        {},
      );
    }

    // A 401 usually means the ID token just expired — retry once with a forced
    // refresh before surfacing an error.
    if (res.status === 401 && !triedRefresh) {
      triedRefresh = true;
      continue;
    }

    // A gateway error from a waking proxy: retry reads, surface for mutations.
    if (RETRYABLE_STATUS.has(res.status) && transient < maxTransient) {
      await sleep(BACKOFF_MS[transient++]);
      continue;
    }

    if (!res.ok) throw new ApiError(body.error ?? res.statusText, res.status, body.code, body);
    return body;
  }
}

/**
 * Fetch an image this session is allowed to see, as a `data:` URL.
 *
 * An <img src="/api/…"> cannot be used for anything behind the bearer token:
 * the browser issues that request with no Authorization header, gets a 401 and
 * renders a broken image. And the object URL that would normally solve it is
 * refused by the CSP, which allows `data:` and not `blob:`.
 *
 * So the bytes are fetched like any other authenticated request and turned
 * into a data: URL. Used for the storefront photo an applicant has staged,
 * which belongs to an application nobody else can see.
 *
 * Returns null when there is nothing there (404), so callers can treat "no
 * photo yet" as an ordinary state rather than an error.
 */
export async function apiImageDataUrl(path) {
  const res = await fetch(path, { headers: { ...(await authHeader(false)) } });
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(res.statusText, res.status);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the image'));
    reader.readAsDataURL(blob);
  });
}
