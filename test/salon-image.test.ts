/**
 * The salon's storefront photo.
 *
 * Two things are being protected. One is that a photo is a photo: these bytes
 * are rendered into an <img> on the customer app, the owner's panel and the
 * admin's, so what a browser claims a file is never decides what is stored.
 * The other is that a salon's picture belongs to that salon — the owner route
 * takes no salon id at all, and that is the property worth a test rather than
 * a comment.
 *
 * Needs a real Postgres; skips (does not fail) without one.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type pg from 'pg';

import {
  MAX_IMAGE_BYTES,
  ImageUploadError,
  loadSalonImage,
  readImageBody,
  saveSalonImage,
  serveSalonImage,
  sniffImageType,
} from '../src/salons/images.ts';
import { businessRoutes } from '../src/http/routes-business.ts';
import { salonForOwner } from '../src/business/repo.ts';
import { getSalon } from '../src/salons/repo.ts';
import { MemorySnapshotCache } from '../src/availability/cache.ts';
import { connect, seed } from './db.ts';

let pool: pg.Pool | null = null;

before(async () => {
  pool = await connect();
});

after(async () => {
  await pool?.end();
});

/** The smallest byte strings that are unambiguously each format. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 9),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64, 3),
]);

describe('salon image — what counts as an image', () => {
  it('recognises the three formats by their signature', () => {
    assert.equal(sniffImageType(JPEG), 'image/jpeg');
    assert.equal(sniffImageType(PNG), 'image/png');
    assert.equal(sniffImageType(WEBP), 'image/webp');
  });

  it('refuses a file that only claims to be an image', () => {
    // The header said image/png; the bytes say HTML. Stored and served back,
    // this is stored XSS with an admin as its most likely viewer.
    assert.equal(sniffImageType(Buffer.from('<script>alert(1)</script>')), null);
    assert.equal(sniffImageType(Buffer.from('%PDF-1.7')), null);
    assert.equal(sniffImageType(Buffer.alloc(0)), null);
  });

  it('rejects a body over the size cap while it streams', async () => {
    const oversized = Readable.from([Buffer.alloc(MAX_IMAGE_BYTES + 1024, 1)]);
    await assert.rejects(
      readImageBody(oversized as unknown as IncomingMessage),
      (err: unknown) => {
        assert.ok(err instanceof ImageUploadError);
        assert.equal(err.status, 413);
        assert.equal(err.code, 'IMAGE_TOO_LARGE');
        return true;
      },
    );
  });

  it('rejects an empty body', async () => {
    await assert.rejects(
      readImageBody(Readable.from([]) as unknown as IncomingMessage),
      (err: unknown) => {
        assert.ok(err instanceof ImageUploadError);
        assert.equal(err.code, 'EMPTY_IMAGE');
        return true;
      },
    );
  });
});

describe('salon image — stored against the salon', () => {
  it('saves the bytes and points cover_url at them', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);

    const stored = await saveSalonImage(db, fx.salonId, PNG, fx.ownerId);
    assert.equal(stored.contentType, 'image/png');
    assert.match(stored.coverUrl, new RegExp(`^/api/salons/${fx.salonId}/image\\?v=`));

    const row = await db.query<{ cover_url: string }>(`SELECT cover_url FROM salons WHERE id = $1`, [
      fx.salonId,
    ]);
    assert.equal(row.rows[0]!.cover_url, stored.coverUrl, 'the salon points at its own image');

    const loaded = await loadSalonImage(db, fx.salonId);
    assert.ok(loaded);
    assert.equal(loaded.contentType, 'image/png');
    assert.ok(loaded.bytes.equals(PNG), 'the bytes come back byte for byte');
  });

  it('replacing the photo replaces the URL, so no cache serves the old one', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);

    const first = await saveSalonImage(db, fx.salonId, PNG, fx.ownerId);
    const second = await saveSalonImage(db, fx.salonId, JPEG, fx.ownerId);
    assert.notEqual(first.coverUrl, second.coverUrl);

    const rows = await db.query(`SELECT 1 FROM salon_images WHERE salon_id = $1`, [fx.salonId]);
    assert.equal(rows.rowCount, 1, 'one photo per salon, not a growing pile');

    const loaded = await loadSalonImage(db, fx.salonId);
    assert.equal(loaded!.contentType, 'image/jpeg');
  });

  it('refuses a file that is not an image', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    await assert.rejects(
      saveSalonImage(db, fx.salonId, Buffer.from('<svg onload=alert(1)>'), fx.ownerId),
      (err: unknown) => {
        assert.ok(err instanceof ImageUploadError);
        assert.equal(err.status, 415);
        return true;
      },
    );
    const row = await db.query<{ cover_url: string | null }>(
      `SELECT cover_url FROM salons WHERE id = $1`,
      [fx.salonId],
    );
    assert.equal(row.rows[0]!.cover_url, null, 'a rejected upload changes nothing');
  });
});

describe('salon image — who sees it', () => {
  it('the customer salon detail returns the uploaded photo', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);

    const before = await getSalon(db, fx.salonId);
    assert.equal(before!.coverImage, null, 'the placeholder case is unchanged');

    const stored = await saveSalonImage(db, fx.salonId, JPEG, fx.ownerId);
    const after = await getSalon(db, fx.salonId);
    assert.equal(after!.coverImage, stored.coverUrl, 'customers see the real photo, not a mock');
  });

  it("the owner's own panel sees the same URL", async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    const stored = await saveSalonImage(db, fx.salonId, JPEG, fx.ownerId);

    const salon = await salonForOwner(db, fx.ownerId);
    assert.equal(salon.coverImage, stored.coverUrl);
  });

  it('serves the bytes with a matching ETag, and 304s a repeat visit', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    const stored = await saveSalonImage(db, fx.salonId, WEBP, fx.ownerId);

    const first = captureResponse();
    const served = await serveSalonImage(
      db,
      fx.salonId,
      { headers: {} } as IncomingMessage,
      first.res,
    );
    assert.equal(served, true);
    assert.equal(first.captured.status, 200);
    assert.equal(first.captured.headers['content-type'], 'image/webp');
    assert.equal(first.captured.headers['x-content-type-options'], 'nosniff');
    assert.equal(first.captured.headers['etag'], `"${stored.checksum}"`);

    const second = captureResponse();
    await serveSalonImage(
      db,
      fx.salonId,
      { headers: { 'if-none-match': `"${stored.checksum}"` } } as IncomingMessage,
      second.res,
    );
    assert.equal(second.captured.status, 304);
  });

  it('a salon with no photo is not served one', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    const { res } = captureResponse();
    assert.equal(await serveSalonImage(db, fx.salonId, { headers: {} } as IncomingMessage, res), false);
  });
});

function captureResponse() {
  const captured = {
    status: 0,
    headers: {} as Record<string, string>,
    body: null as unknown,
  };
  const res = {
    headersSent: false,
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      for (const [k, v] of Object.entries(headers ?? {})) captured.headers[k.toLowerCase()] = String(v);
      return this;
    },
    end(payload?: unknown) {
      captured.body = payload ?? null;
      (this as { headersSent: boolean }).headersSent = true;
    },
  };
  return { captured, res: res as unknown as ServerResponse };
}

describe('salon image — an owner can only touch their own salon', () => {
  it('the upload route takes no salon id at all', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;

    // Two salons, two owners. The second owner uploads; the route resolves the
    // salon from their session, so there is nothing in the request that could
    // name the first salon even if they tried.
    const victim = await seed(db);
    const attackerOwner = await db.query<{ id: string }>(
      `INSERT INTO users (phone, name, email, role) VALUES ('+919000000001', 'Other', 'other@example.test', 'business') RETURNING id`,
    );
    const attackerId = attackerOwner.rows[0]!.id;
    const attackerSalon = await db.query<{ id: string }>(
      `INSERT INTO salons (owner_id, name, address, lat, lng, status)
       VALUES ($1, 'Other Salon', 'Elsewhere', 12.9, 77.6, 'active') RETURNING id`,
      [attackerId],
    );
    const attackerSalonId = attackerSalon.rows[0]!.id;

    const { captured, res } = captureResponse();
    const req = Object.assign(Readable.from([PNG]), { headers: { 'content-type': 'image/png' } });
    const handled = await businessRoutes(db, req as unknown as IncomingMessage, res, {
      // The path an attacker controls is this one — and it names no salon.
      seg: ['api', 'business', 'image'],
      method: 'PUT',
      url: new URL('http://localhost/api/business/image'),
      ownerId: attackerId,
      cache: new MemorySnapshotCache(),
    });

    assert.equal(handled, true);
    assert.equal(captured.status, 200);

    const mine = await loadSalonImage(db, attackerSalonId);
    assert.ok(mine, "the uploader's own salon got the photo");

    const theirs = await loadSalonImage(db, victim.salonId);
    assert.equal(theirs, null, "another owner's salon is untouched");
    const victimCover = await db.query<{ cover_url: string | null }>(
      `SELECT cover_url FROM salons WHERE id = $1`,
      [victim.salonId],
    );
    assert.equal(victimCover.rows[0]!.cover_url, null);
  });
});
