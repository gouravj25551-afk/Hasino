import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
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
 * Static assets, read once at boot into memory. There are four of them and
 * they never change at runtime; a real static server would be more machinery
 * than the problem deserves.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function loadAssets(dir: URL, names: string[]): Map<string, { body: string; type: string }> {
  const assets = new Map<string, { body: string; type: string }>();
  for (const name of names) {
    const ext = name.slice(name.lastIndexOf('.'));
    assets.set(name, {
      body: readFileSync(new URL(name, dir), 'utf8'),
      type: MIME[ext] ?? 'application/octet-stream',
    });
  }
  return assets;
}

export function sendAsset(res: ServerResponse, asset: { body: string; type: string }): void {
  res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
  res.end(asset.body);
}
