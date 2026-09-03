/**
 * The salon gallery — many photos, distinct from the one storefront cover.
 *
 * salon_photos is the many-row gallery the customer carousel reads; migration
 * 014 gave it the bytes so an owner can upload rather than only seed a link.
 * These cover the repo behaviour (add/list/delete, the max, the dedup, the
 * scope), that an uploaded photo serves and surfaces to customers, and that the
 * panel routes are the owner's own.
 *
 * Needs a real Postgres; skips (does not fail) without one.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type pg from 'pg';

import {
  MAX_GALLERY_PHOTOS,
  addGalleryPhoto,
  deleteGalleryPhoto,
  listGalleryPhotos,
  serveGalleryPhoto,
} from '../src/salons/images.ts';
import { businessRoutes } from '../src/http/routes-business.ts';
import { getSalon } from '../src/salons/repo.ts';
import { MemorySnapshotCache } from '../src/availability/cache.ts';
import { connect, seed } from './db.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let pool: pg.Pool | null = null;
before(async () => { pool = await connect(); });
after(async () => { await pool?.end(); });

/** A valid JPEG that differs per index, so each has its own checksum. */
const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, n)]);
const NOT_AN_IMAGE = Buffer.from('<script>alert(1)</script>', 'utf8');

function captureResponse() {
  const captured = { status: 0, headers: {} as Record<string, string>, body: null as unknown };
  const res = {
    headersSent: false,
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

describe('gallery — adding, listing and deleting', () => {
  it('adds a photo, lists it, and hands back a served URL', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);

    const added = await addGalleryPhoto(db, fx.salonId, jpeg(1), fx.ownerId);
    assert.equal(added.duplicate, false);
    assert.match(added.url, new RegExp(`^/api/salons/${fx.salonId}/photos/${added.id}/image[?]v=`));

    const list = await listGalleryPhotos(db, fx.salonId);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, added.id);
    assert.equal(list[0]!.url, added.url);

    const row = await db.query<{ uploaded_by: string; byte_size: number }>(
      `SELECT uploaded_by, byte_size FROM salon_photos WHERE id = $1`, [added.id],
    );
    assert.equal(row.rows[0]!.uploaded_by, fx.ownerId, 'records who uploaded it');
    assert.equal(row.rows[0]!.byte_size, jpeg(1).length);
  });

  it('keeps adding rather than replacing — the gallery is many', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    await addGalleryPhoto(db, fx.salonId, jpeg(1), fx.ownerId);
    await addGalleryPhoto(db, fx.salonId, jpeg(2), fx.ownerId);
    await addGalleryPhoto(db, fx.salonId, jpeg(3), fx.ownerId);
    assert.equal((await listGalleryPhotos(db, fx.salonId)).length, 3);
  });

  it('the same image twice is one photo, not two', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    const first = await addGalleryPhoto(db, fx.salonId, jpeg(1), fx.ownerId);
    const again = await addGalleryPhoto(db, fx.salonId, jpeg(1), fx.ownerId);
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id, 'the existing row is returned');
    assert.equal((await listGalleryPhotos(db, fx.salonId)).length, 1);
  });

  it('refuses anything that is not actually an image, storing nothing', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    await assert.rejects(
      addGalleryPhoto(db, fx.salonId, NOT_AN_IMAGE, fx.ownerId),
      /not a JPEG, PNG or WebP/,
    );
    assert.equal((await listGalleryPhotos(db, fx.salonId)).length, 0);
  });

  it('caps the gallery at MAX_GALLERY_PHOTOS', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    for (let i = 0; i < MAX_GALLERY_PHOTOS; i++) {
      await addGalleryPhoto(db, fx.salonId, jpeg(i), fx.ownerId);
    }
    await assert.rejects(
      addGalleryPhoto(db, fx.salonId, jpeg(999), fx.ownerId),
      /at most 8 photos/,
    );
    assert.equal((await listGalleryPhotos(db, fx.salonId)).length, MAX_GALLERY_PHOTOS);
  });

  it('deletes one, and deleting again is a no-op, not an error', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    const p = await addGalleryPhoto(db, fx.salonId, jpeg(1), fx.ownerId);
    assert.equal(await deleteGalleryPhoto(db, fx.salonId, p.id), true);
    assert.equal((await listGalleryPhotos(db, fx.salonId)).length, 0);
    assert.equal(await deleteGalleryPhoto(db, fx.salonId, p.id), false, 'already gone');
  });

  it('a delete is scoped to the salon — no cross-salon reach', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const mine = await seed(db);
    const p = await addGalleryPhoto(db, mine.salonId, jpeg(1), mine.ownerId);
    // A second salon under a second owner.
    const otherOwner = await db.query<{ id: string }>(
      `INSERT INTO users (name, email, role) VALUES ('Other', 'other@example.test', 'business') RETURNING id`,
    );
    const otherSalon = await db.query<{ id: string }>(
      `INSERT INTO salons (owner_id, name, address, lat, lng, status)
       VALUES ($1, 'Other', 'Elsewhere', 12.9, 77.6, 'active') RETURNING id`,
      [otherOwner.rows[0]!.id],
    );
    assert.equal(await deleteGalleryPhoto(db, otherSalon.rows[0]!.id, p.id), false, 'not theirs to delete');
    assert.equal((await listGalleryPhotos(db, mine.salonId)).length, 1, 'mine is untouched');
  });
});

describe('gallery — serving and the customer view', () => {
  it('serves an uploaded photo as its own bytes, cached hard', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    const p = await addGalleryPhoto(db, fx.salonId, jpeg(1), fx.ownerId);

    const { captured, res } = captureResponse();
    const served = await serveGalleryPhoto(db, fx.salonId, p.id, { headers: {} } as IncomingMessage, res);
    assert.equal(served, true);
    assert.equal(captured.status, 200);
    assert.equal(captured.headers['content-type'], 'image/jpeg');
    assert.deepEqual(captured.body, jpeg(1), 'the same bytes, byte for byte');
    assert.match(captured.headers['cache-control'] ?? '', /immutable/);
    assert.equal(captured.headers['x-content-type-options'], 'nosniff');
  });

  it('reports not-found for a photo that is not this salon’s', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    const { res } = captureResponse();
    const served = await serveGalleryPhoto(
      db, fx.salonId, '00000000-0000-0000-0000-000000000000', { headers: {} } as IncomingMessage, res,
    );
    assert.equal(served, false);
  });

  it('an uploaded gallery photo shows up in the customer’s photos[]', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    const p = await addGalleryPhoto(db, fx.salonId, jpeg(1), fx.ownerId);

    const salon = await getSalon(db, fx.salonId);
    assert.ok(salon);
    assert.ok(
      salon.photos.some((u) => u.includes(`/photos/${p.id}/image`)),
      'the coalesced served URL is what the carousel gets',
    );
  });
});

describe('gallery — the panel routes are the owner’s own', () => {
  const cache = () => new MemorySnapshotCache();

  it('POST adds to the caller’s own salon, resolved from the session', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    const { captured, res } = captureResponse();
    const req = Object.assign(Readable.from([jpeg(1)]), { headers: { 'content-type': 'image/jpeg' } });
    const handled = await businessRoutes(db, req as unknown as IncomingMessage, res, {
      // The path names no salon; the owner id is the session's.
      seg: ['api', 'business', 'photos'],
      method: 'POST',
      url: new URL('http://localhost/api/business/photos'),
      ownerId: fx.ownerId,
      cache: cache(),
    });
    assert.equal(handled, true);
    assert.equal(captured.status, 201);
    assert.equal((await listGalleryPhotos(db, fx.salonId)).length, 1);
  });

  it('DELETE of a missing photo answers 404 rather than a silent ok', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    const fx = await seed(db);
    const { res } = captureResponse();
    await assert.rejects(
      businessRoutes(db, { headers: {} } as unknown as IncomingMessage, res, {
        seg: ['api', 'business', 'photos', '00000000-0000-0000-0000-000000000000'],
        method: 'DELETE',
        url: new URL('http://localhost/api/business/photos/x'),
        ownerId: fx.ownerId,
        cache: cache(),
      }),
      /not in this gallery/,
    );
  });
});

describe('gallery — wiring', () => {
  it('the public serve route is mounted and takes both ids from the path', () => {
    const server = read('src/http/server.ts');
    assert.match(server, /seg\[3\] === 'photos' &&\s*\n\s*seg\[5\] === 'image'/);
    assert.match(server, /serveGalleryPhoto\(db, uuid\(seg\[2\]!, 'salonId'\), uuid\(seg\[4\]!, 'photoId'\)/);
  });

  it('the panel gallery panel is on the profile screen, not the today dashboard', () => {
    const business = read('src/http/public/business.js');
    assert.match(business, /view\.append\(salonGalleryPanel\(salon\)\)/);
    // The cover photo panel was removed from today; it must not be re-added.
    assert.doesNotMatch(business, /view\.append\(salonImagePanel\(overview\.salon\)\)/);
  });
});
