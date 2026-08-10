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

