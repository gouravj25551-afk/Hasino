import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './respond.ts';

/**
 * The things every request needs that are not routing.
 *
 * Written as plain functions rather than an onion of `(req,res,next)` wrappers:
 * there are four of them, the order matters, and a chain abstraction would make
 * that order harder to see rather than easier.
 */

// ------------------------------------------------------------------ security

/**
 * The Clerk Frontend API host this deploy talks to, read out of the
 * publishable key.
 *
 * The key is `pk_<env>_<base64 host>` — the host is not a secret, it is where
 * every browser is about to send its session traffic. Deriving it beats naming
 * it in a second environment variable that can disagree with the key, and it
 * beats a wildcard: this returns the one host that is actually correct for the
 * instance the keys belong to.
 *
 * Returns null for a missing or malformed key, in which case the CSP simply
 * carries no Clerk host and sign-in is visibly broken rather than silently
 * over-permitted.
 */
export function clerkFrontendApiHost(publishableKey: string | undefined): string | null {
  const encoded = publishableKey?.split('_')[2];
  if (!encoded) return null;
  try {
    // Clerk pads the encoded host with a trailing '$'.
    const host = Buffer.from(encoded, 'base64').toString('utf8').replace(/\$+$/, '');
    // A host and nothing else: no scheme, no path, no room for a stray
    // wildcard or space to widen the policy.
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}

/**
 * Built per deploy rather than as a constant, because the Clerk host differs
 * between instances.
 *
 * This used to carry `https://clerk.*`, which is not valid CSP — a wildcard is
 * only allowed as the leftmost label, so browsers discarded the token entirely
 * and said so in the console. It happened to be harmless on a development
 * instance, where the neighbouring `*.clerk.accounts.dev` covers the real
 * host, and would have failed on the first production deploy: a production
 * instance serves its Frontend API from `clerk.<yourdomain>`, which nothing
 * else here matches. Sign-in would have been blocked with a CSP violation.
 */
export function contentSecurityPolicy(publishableKey = process.env['CLERK_PUBLISHABLE_KEY']): string {
  const clerkHost = clerkFrontendApiHost(publishableKey);
  // The exact instance host (production is clerk.<yourdomain>), plus the
  // development wildcard, which is what *.clerk.accounts.dev instances use.
  const clerk = ['https://*.clerk.accounts.dev', ...(clerkHost ? [`https://${clerkHost}`] : [])].join(' ');

  return [
    "default-src 'self'",
    // Razorpay's checkout is a script from their CDN that injects an iframe.
    // There is no self-hosted build of it, and taking payments requires it.
    // clerk-js is loaded from jsDelivr because this app has no bundler, and
    // Clerk itself injects a worker and frames from its own hosted domains.
    // 'unsafe-eval' is deliberately NOT granted; clerk-js does not need it.
    //
    // challenges.cloudflare.com is Clerk's bot protection (Turnstile). It was
    // already trusted in frame-src, but the widget is a *script* that then
    // creates that frame — without it here the script is blocked, and the only
    // symptom is that sign-up fails with captcha_invalid. Sign-in is
    // unaffected, so this breaks new accounts exclusively.
    `script-src 'self' https://checkout.razorpay.com https://*.razorpay.com https://cdn.jsdelivr.net ${clerk} https://challenges.cloudflare.com`,
    "worker-src 'self' blob:",
    `frame-src https://api.razorpay.com https://*.razorpay.com ${clerk} https://challenges.cloudflare.com`,
    `connect-src 'self' https://*.razorpay.com https://lumberjack.razorpay.com ${clerk} https://api.clerk.com`,
    // The customer app has no build step, so component styles are inline.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// Computed once: the key cannot change without restarting the process.
const CSP = contentSecurityPolicy();

export function securityHeaders(res: ServerResponse, isProd: boolean): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', 'geolocation=(self), camera=(), microphone=(), payment=(self)');
  res.setHeader('content-security-policy', CSP);
  if (isProd) {
    // Only over HTTPS, and only in production — sending HSTS from a local
    // http://localhost pins the browser and breaks development for months.
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}

// ---------------------------------------------------------------------- CORS

/**
 * Same-origin by default: the customer app and the API are one server, so no
 * CORS header is needed at all. ALLOWED_ORIGINS exists for the React Native and
 * Next.js clients the spec plans, and is an explicit list — never a reflected
 * `*` with credentials, which is the same as having no origin check.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse, allowed: string[]): boolean {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && allowed.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-dev-user');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('access-control-max-age', '600');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

export function originsFromEnv(): string[] {
  return (process.env['ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// -------------------------------------------------------------- rate limiting

export class RateLimitError extends HttpError {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(429, 'Too many requests. Slow down.');
    this.name = 'RateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token bucket, in memory.
 *
 * In-memory means per-instance: three instances behind a load balancer allow
 * three times the configured rate. That is the honest trade for not adding
 * Redis to the request path, and it is the right one here — this limit exists
 * to stop a script hammering `POST /api/bookings`, not to meter a paid API. The
 * interface is small enough that a Redis implementation is a drop-in when
 * there is more than one instance to care about.
 */
export class RateLimiter {
  #buckets = new Map<string, Bucket>();
  #capacity: number;
  #refillPerMs: number;
  #sweepAt = 0;

  constructor(perMinute: number, burst = perMinute) {
    this.#capacity = burst;
    this.#refillPerMs = perMinute / 60_000;
  }

  /** Throws RateLimitError when the caller is over budget. */
  check(key: string, cost = 1, now = Date.now()): void {
    this.#sweep(now);

    const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, updatedAt: now };
    bucket.tokens = Math.min(
      this.#capacity,
      bucket.tokens + (now - bucket.updatedAt) * this.#refillPerMs,
    );
    bucket.updatedAt = now;

    if (bucket.tokens < cost) {
      this.#buckets.set(key, bucket);
      throw new RateLimitError(Math.ceil((cost - bucket.tokens) / this.#refillPerMs / 1000));
    }

    bucket.tokens -= cost;
    this.#buckets.set(key, bucket);
  }

  /** Drop full buckets periodically, so one IP per request does not leak memory. */
  #sweep(now: number): void {
    if (now < this.#sweepAt) return;
    this.#sweepAt = now + 60_000;
    for (const [key, b] of this.#buckets) {
      if (b.tokens >= this.#capacity && now - b.updatedAt > 300_000) this.#buckets.delete(key);
    }
  }
}

/**
 * Who to charge for a request.
 *
 * X-Forwarded-For is only trusted when TRUST_PROXY is set, because behind no
 * proxy it is caller-controlled — anyone can send a fresh one per request and
 * have an unlimited budget. Behind a proxy the *last* entry is the one the
 * proxy itself appended and the only one that is not spoofable.
 */
export function clientKey(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const chain = (Array.isArray(xff) ? xff[0] : xff)?.split(',').map((s) => s.trim()) ?? [];
    const last = chain[chain.length - 1];
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

// -------------------------------------------------------------------- bodies

/**
 * The raw request body.
 *
 * The Razorpay webhook's HMAC is computed over the exact bytes sent. Reading
 * the body as JSON and re-serialising it changes key order and whitespace and
 * the signature stops matching — so the webhook route needs the Buffer, and
 * nothing may parse it first.
 */
export async function readRawBody(req: IncomingMessage, limitBytes = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new HttpError(413, 'Body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
