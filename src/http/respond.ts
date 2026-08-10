import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  readonly status: number;
  /** Optional machine-readable code, so clients can branch without string matching. */
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body, null, 2));
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, 'Body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(value: string, field: string): string {
  if (!UUID.test(value)) throw new HttpError(400, `${field} must be a UUID`);
  return value;
}

export function str(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== 'string' || v.length === 0) throw new HttpError(400, `${field} must be a non-empty string`);
  return v;
}

export function int(body: Record<string, unknown>, field: string): number {
  const v = body[field];
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new HttpError(400, `${field} must be an integer`);
  return v;
}

export function bool(body: Record<string, unknown>, field: string): boolean {
  const v = body[field];
  if (typeof v !== 'boolean') throw new HttpError(400, `${field} must be a boolean`);
  return v;
}

export function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string')) {
    throw new HttpError(400, `${field} must be a non-empty array of strings`);
  }
  return value as string[];
}

/**
 * Static assets, read once at boot into memory. There are forty of them, none
 * changes at runtime, and the whole set is well under a megabyte; a real static
 * server would be more machinery than the problem deserves.
 *
 * Each one gets an ETag hashed from its bytes at boot. The customer app is
 * ~40 ES modules loaded natively by the browser — without conditional requests
 * that is 40 full downloads on every navigation, which on a 3G phone in a salon
 * queue is the difference between usable and not. With them it is 40 requests
 * that answer 304 and transfer nothing.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export interface Asset {
  body: string;
  type: string;
  etag: string;
  cacheControl: string;
}

export function loadAssets(dir: URL, names: string[]): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  for (const name of names) {
    const ext = name.slice(name.lastIndexOf('.'));
    const body = readFileSync(new URL(name, dir), 'utf8');
    assets.set(name, {
      body,
      type: MIME[ext] ?? 'application/octet-stream',
      etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`,
      // The HTML shells must never be cached: they name every other file, so a
      // stale shell pins a stale app forever. Everything else revalidates,
      // which is cheap because the ETag makes the answer a 304.
      cacheControl:
        ext === '.html' ? 'no-store' : 'public, max-age=0, must-revalidate',
    });
  }
  return assets;
}

export function sendAsset(res: ServerResponse, asset: Asset, req?: IncomingMessage): void {
  const inm = req?.headers['if-none-match'];
  if (typeof inm === 'string' && inm.split(',').some((t) => t.trim() === asset.etag)) {
    res.writeHead(304, { etag: asset.etag, 'cache-control': asset.cacheControl });
    return void res.end();
  }
  res.writeHead(200, {
    'content-type': asset.type,
    'cache-control': asset.cacheControl,
    etag: asset.etag,
  });
  res.end(asset.body);
}
