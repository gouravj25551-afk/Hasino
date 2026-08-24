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

export async function api(path, opts = {}) {
  let { res, body } = await doFetch(path, opts, false);
  // A 401 usually means the ID token just expired — retry once with a forced
  // refresh before surfacing an error.
  if (res.status === 401) {
    ({ res, body } = await doFetch(path, opts, true));
  }
  if (!res.ok) throw new ApiError(body.error ?? res.statusText, res.status, body.code, body);
  return body;
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
