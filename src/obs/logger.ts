import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Structured logging.
 *
 * One JSON object per line, because every log aggregator worth using parses
 * that and none of them reliably parse prose. In a TTY it prints human-readable
 * instead — the local console is a different audience from Loki.
 *
 * The request id is carried in AsyncLocalStorage rather than threaded through
 * every function signature. A booking touches ten modules; passing a logger to
 * each of them to get "which request was that" is a large diff for something
 * the runtime can do for free.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = LEVELS[(process.env['LOG_LEVEL'] as Level) ?? 'info'] ?? LEVELS.info;
const pretty = process.env['LOG_FORMAT'] === 'pretty' || (!process.env['LOG_FORMAT'] && process.stdout.isTTY);

export interface RequestContext {
  requestId: string;
  userId?: string;
  route?: string;
}

const store = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return store.getStore();
}

/** Attach something discovered mid-request — the user id, once authenticated. */
export function annotate(fields: Partial<RequestContext>): void {
  const ctx = store.getStore();
  if (ctx) Object.assign(ctx, fields);
}

export function newRequestId(inbound?: string | string[] | undefined): string {
  // Trust an inbound id when it looks like one, so a trace survives the load
  // balancer. Length-capped and character-restricted because it ends up in log
  // lines that something else will parse.
  const v = Array.isArray(inbound) ? inbound[0] : inbound;
  if (typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[\w.:-]+$/.test(v)) return v;
  return randomUUID();
}

/**
 * Keys whose values never reach a log line.
 *
 * Signatures and tokens are credentials; a payment id is not secret but is
 * enough to correlate a person with a purchase, and logs get shared more
 * casually than databases do.
 */
const REDACT = new Set([
  'authorization',
  'password',
  'token',
  'idtoken',
  'signature',
  'x-razorpay-signature',
  'keysecret',
  'key_secret',
  'webhooksecret',
  'phone',
  'email',
]);

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = REDACT.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}

function emit(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < threshold) return;

  const ctx = store.getStore();
  const record = {
    time: new Date().toISOString(),
    level,
    message,
    ...(ctx ? { requestId: ctx.requestId, ...(ctx.userId ? { userId: ctx.userId } : {}) } : {}),
    ...redact(fields),
  };

  const line = pretty
    ? `${record.time.slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${message} ${
        Object.keys(fields).length || ctx ? JSON.stringify(redact({ ...(ctx ?? {}), ...fields })) : ''
      }`
    : JSON.stringify(record);

  // stderr for warn/error so `node app 2>errors.log` still works, and so a
  // crash-looping container's useful output is not interleaved into stdout.
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};

/**
 * Where uncaught errors go.
 *
 * Sentry and friends are a dependency and an account; this is the seam they
 * plug into. Until one exists, an error still reaches the logs with its stack —
 * the failure mode of "we added error tracking later" should not be "the last
 * six months of errors were never written down".
 */
export type ErrorReporter = (err: unknown, context: Record<string, unknown>) => void;

let reporter: ErrorReporter | null = null;

export function setErrorReporter(fn: ErrorReporter | null): void {
  reporter = fn;
}

export function reportError(err: unknown, context: Record<string, unknown> = {}): void {
  const e = err as Error;
  log.error(e?.message ?? String(err), {
    ...context,
    errorName: e?.name,
    stack: e?.stack?.split('\n').slice(0, 8).join('\n'),
  });
  try {
    reporter?.(err, { ...context, ...(currentContext() ?? {}) });
  } catch {
    // An error reporter that throws must not take the request down with it.
  }
}
