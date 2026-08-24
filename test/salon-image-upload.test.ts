/**
 * A storefront photo uploaded before the salon exists.
 *
 * salon_images is keyed by salon_id and an application has none — the salons
 * row is created by the submission. So the bytes are staged against the
 * applicant and moved onto the salon in the same transaction that creates it,
 * which is what makes the photo part of the request an admin reviews rather
 * than something that arrives afterwards.
 *
 * Needs a real Postgres; skips (does not fail) without one.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import type pg from 'pg';

import { applyForSalon, changeSalonStatus } from '../src/admin/repo.ts';
import {
  claimStagedImage,
  deleteStagedImage,
  loadSalonImage,
  saveStagedImage,
  stagedImageFor,
  sweepStagedImages,
} from '../src/salons/images.ts';
import { withTransaction } from '../src/db/pool.ts';
import { connect, reset } from './db.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let pool: pg.Pool | null = null;
before(async () => { pool = await connect(); });
after(async () => { await pool?.end(); });

/** A one-pixel JPEG: real magic bytes, so the sniffer accepts it. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const NOT_AN_IMAGE = Buffer.from('<script>alert(1)</script>', 'utf8');

async function customer(db: pg.Pool, email: string) {
  const res = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, role) VALUES ('Applicant', $1, 'customer') RETURNING id`,
    [email],
  );
  return res.rows[0]!.id;
}
async function admin(db: pg.Pool) {
  const res = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, role) VALUES ('Operator', 'ops@example.test', 'admin') RETURNING id`,
  );
  return res.rows[0]!.id;
}
const APPLICATION = {
  name: 'Sharma Hair Studio',
  address: '12 MG Road',
  city: 'Bengaluru',
  lat: 12.97,
  lng: 77.59,
};
const coverOf = async (db: pg.Pool, salonId: string) => (
  await db.query<{ cover_url: string | null }>(`SELECT cover_url FROM salons WHERE id = $1`, [salonId])
).rows[0]!.cover_url;

describe('staging a photo before there is a salon', () => {
  it('stores it against the applicant and hands back a URL', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'me@example.test');

    const staged = await saveStagedImage(db, me, JPEG);
    assert.equal(staged.contentType, 'image/jpeg');
    assert.equal(staged.byteSize, JPEG.length);
    assert.match(staged.url, /^\/api\/salons\/apply\/image\?v=/);
    // The URL carries no id: the photo is always the caller's own.
    assert.doesNotMatch(staged.url, new RegExp(me));

    const found = await stagedImageFor(db, me);
    assert.equal(found?.checksum, staged.checksum);
  });

  it('a second upload replaces the first rather than piling up', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'me@example.test');

    await saveStagedImage(db, me, JPEG);
    const second = await saveStagedImage(db, me, PNG);

    const rows = await db.query(`SELECT 1 FROM salon_image_uploads WHERE user_id = $1`, [me]);
    assert.equal(rows.rowCount, 1, 'one row per applicant, always');
    const found = await stagedImageFor(db, me);
    assert.equal(found?.checksum, second.checksum, 'the newest one wins');
  });

  it('refuses anything that is not actually an image', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'me@example.test');
    // The browser's content-type header is a claim; the magic bytes decide.
    await assert.rejects(saveStagedImage(db, me, NOT_AN_IMAGE), /not a JPEG, PNG or WebP/);
    const rows = await db.query(`SELECT 1 FROM salon_image_uploads`);
    assert.equal(rows.rowCount, 0, 'nothing was stored on the way to the refusal');
  });

  it('one applicant cannot reach another applicant’s photo', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'me@example.test');
    const other = await customer(db, 'other@example.test');
    await saveStagedImage(db, me, JPEG);

    // Every read is keyed by the session user; there is no id to pass.
    assert.equal(await stagedImageFor(db, other), null);
    assert.equal(await deleteStagedImage(db, other), false, 'and nothing to delete');
    assert.notEqual(await stagedImageFor(db, me), null, 'mine is untouched');
  });

  it('is removable, so a change of mind is not a stuck photo', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'me@example.test');
    await saveStagedImage(db, me, JPEG);
    assert.equal(await deleteStagedImage(db, me), true);
    assert.equal(await stagedImageFor(db, me), null);
  });
});

describe('submitting claims the photo onto the salon', () => {
  it('moves the bytes and points cover_url at them', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'me@example.test');
    await saveStagedImage(db, me, JPEG);

    const { salonId } = await applyForSalon(
      db, { userId: me, phone: null, name: 'Me', email: 'me@example.test' }, APPLICATION,
    );

    const image = await loadSalonImage(db, salonId);
    assert.ok(image, 'the salon has its photo');
    assert.equal(image.contentType, 'image/jpeg');
    assert.deepEqual(image.bytes, JPEG, 'the same bytes, byte for byte');

    const cover = await coverOf(db, salonId);
    assert.match(cover ?? '', new RegExp(`^/api/salons/${salonId}/image[?]v=`));

    // Staging is emptied: the same bytes in two tables would be two answers to
    // "where is this salon's photo".
    assert.equal(await stagedImageFor(db, me), null);
  });

  it('records who uploaded it', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'me@example.test');
    await saveStagedImage(db, me, JPEG);
    const { salonId } = await applyForSalon(
      db, { userId: me, phone: null, name: 'Me', email: 'me@example.test' }, APPLICATION,
    );
    const row = await db.query<{ uploaded_by: string }>(
      `SELECT uploaded_by FROM salon_images WHERE salon_id = $1`, [salonId],
    );
    assert.equal(row.rows[0]!.uploaded_by, me);
  });

  it('an application without a photo is still an application', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'me@example.test');
    const { salonId } = await applyForSalon(
      db, { userId: me, phone: null, name: 'Me', email: 'me@example.test' }, APPLICATION,
    );
    assert.equal(await loadSalonImage(db, salonId), null);
    assert.equal(await coverOf(db, salonId), null);
  });

  it('an uploaded photo beats a pasted link', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'me@example.test');
    await saveStagedImage(db, me, JPEG);
    const { salonId } = await applyForSalon(
      db, { userId: me, phone: null, name: 'Me', email: 'me@example.test' },
      { ...APPLICATION, coverUrl: 'https://example.test/somebody-elses.jpg' },
    );
    // Hasino hosts the one it was handed; the link loses.
    assert.match(await coverOf(db, salonId) ?? '', /^\/api\/salons\//);
  });

  it('a resubmission with no new photo keeps the one on file', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'me@example.test');
    const operator = await admin(db);
    await saveStagedImage(db, me, JPEG);
    const { salonId } = await applyForSalon(
      db, { userId: me, phone: null, name: 'Me', email: 'me@example.test' }, APPLICATION,
    );
    const first = await coverOf(db, salonId);
    await changeSalonStatus(db, operator, salonId, 'rejected', { reason: 'Add your prices' });

    // Fixed and sent back, with nothing new in the photo step.
    await applyForSalon(
      db, { userId: me, phone: null, name: 'Me', email: 'me@example.test' },
      { ...APPLICATION, coverUrl: null },
    );

    assert.equal(await coverOf(db, salonId), first, 'the photo is not silently dropped');
    assert.ok(await loadSalonImage(db, salonId), 'and its bytes are still there');
  });

  it('a resubmission with a new photo replaces it', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'me@example.test');
    const operator = await admin(db);
    await saveStagedImage(db, me, JPEG);
    const { salonId } = await applyForSalon(
      db, { userId: me, phone: null, name: 'Me', email: 'me@example.test' }, APPLICATION,
    );
    const first = await coverOf(db, salonId);
    await changeSalonStatus(db, operator, salonId, 'rejected', { reason: 'Blurry' });

    await saveStagedImage(db, me, PNG);
    await applyForSalon(
      db, { userId: me, phone: null, name: 'Me', email: 'me@example.test' }, APPLICATION,
    );

    const image = await loadSalonImage(db, salonId);
    assert.equal(image?.contentType, 'image/png');
    assert.deepEqual(image?.bytes, PNG);
    assert.notEqual(await coverOf(db, salonId), first, 'and the URL moved with it');
    // Still one row per salon.
    const rows = await db.query(`SELECT 1 FROM salon_images WHERE salon_id = $1`, [salonId]);
    assert.equal(rows.rowCount, 1);
  });

  it('claiming is part of the submission, not a step after it', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'me@example.test');
    await saveStagedImage(db, me, JPEG);

    // A transaction that claims and then fails leaves the staged photo where
    // it was — the applicant has not lost it.
    await assert.rejects(withTransaction(db, async (tx) => {
      const salon = await tx.query<{ id: string }>(
        `INSERT INTO salons (owner_id, name, address, city, lat, lng, status)
         VALUES ($1, 'Doomed', '1 Road', 'Bengaluru', 12.9, 77.6, 'pending') RETURNING id`,
        [me],
      );
      await claimStagedImage(tx, me, salon.rows[0]!.id);
      throw new Error('rolled back');
    }), /rolled back/);

    assert.notEqual(await stagedImageFor(db, me), null, 'still staged after the rollback');
    const salons = await db.query(`SELECT 1 FROM salons`);
    assert.equal(salons.rowCount, 0, 'and no salon was left behind either');
  });
});

describe('abandoned uploads do not accumulate', () => {
  it('the sweep clears photos nobody submitted', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const stale = await customer(db, 'stale@example.test');
    const fresh = await customer(db, 'fresh@example.test');
    await saveStagedImage(db, stale, JPEG);
    await saveStagedImage(db, fresh, JPEG);
    await db.query(
      `UPDATE salon_image_uploads SET updated_at = now() - interval '30 days' WHERE user_id = $1`,
      [stale],
    );

    const { swept } = await sweepStagedImages(db);
    assert.equal(swept, 1);
    assert.equal(await stagedImageFor(db, stale), null);
    assert.notEqual(await stagedImageFor(db, fresh), null, 'a recent one is left alone');
  });

  it('and deleting the account takes its staged photo with it', async (t) => {
    if (!pool) return t.skip('no test database reachable');
    const db = pool;
    await reset(db);
    const me = await customer(db, 'me@example.test');
    await saveStagedImage(db, me, JPEG);
    await db.query(`DELETE FROM users WHERE id = $1`, [me]);
    const rows = await db.query(`SELECT 1 FROM salon_image_uploads`);
    assert.equal(rows.rowCount, 0, 'ON DELETE CASCADE');
  });

  it('the sweep is wired into the worker loop', () => {
    const runner = read('src/workers/runner.ts');
    assert.match(runner, /name: 'sweep-staged-images'/);
    assert.match(runner, /sweepStagedImages\(db\)/);
    // Its own advisory lock, or two instances would sweep at once.
    const locks = [...runner.matchAll(/lockKey: (\d[\d_]*)/g)].map((m) => m[1]);
    assert.equal(new Set(locks).size, locks.length, `duplicate lock keys: ${locks.join(', ')}`);
  });
});

describe('the upload route is the applicant’s own, and nobody else’s', () => {
  const server = read('src/http/server.ts');

  it('takes the user from the session and no id from the request', () => {
    const block = /if \(seg\[0\] === 'api' && seg\[1\] === 'salons' && seg\[2\] === 'apply' && seg\[3\] === 'image'[\s\S]*?\n  \}/.exec(server)?.[0] ?? '';
    assert.notEqual(block, '', 'the staged-image route was not found');
    assert.match(block, /const applicant = await session\(db, req\)/);
    const calls = [
      'saveStagedImage(db, applicant.userId',
      'serveStagedImage(db, applicant.userId',
      'deleteStagedImage(db, applicant.userId',
    ];
    for (const call of calls) {
      assert.ok(block.includes(call), `${call} must be keyed to the session`);
    }
    assert.doesNotMatch(block, /uuid\(seg/, 'no id is parsed out of the path');
  });

  it('is behind the same verified-email gate as the application', () => {
    const block = /if \(seg\[0\] === 'api' && seg\[1\] === 'salons' && seg\[2\] === 'apply' && seg\[3\] === 'image'[\s\S]*?\n  \}/.exec(server)?.[0] ?? '';
    assert.match(block, /EMAIL_NOT_VERIFIED/);
    assert.match(block, /limits\.booking\.check\(`apply-image:/, 'and rate limited per user');
  });

  it('the size cap and the sniffer are the shared ones', () => {
    const block = /if \(seg\[0\] === 'api' && seg\[1\] === 'salons' && seg\[2\] === 'apply' && seg\[3\] === 'image'[\s\S]*?\n  \}/.exec(server)?.[0] ?? '';
    assert.match(block, /readImageBody\(req\)/);
    assert.match(read('src/salons/images.ts'), /export async function saveStagedImage[\s\S]*?sniffImageType\(bytes\)/);
  });

  it('a staged photo is never cached by anything in between', () => {
    // The path carries no id, so a cached response would be served to the
    // next person on the same proxy.
    const fn = /export async function serveStagedImage\([\s\S]*?\n\}/.exec(read('src/salons/images.ts'))?.[0] ?? '';
    assert.match(fn, /'cache-control': 'no-store, private'/);
    assert.doesNotMatch(fn, /max-age=31536000/);
  });

  it('the form uploads through the shared crop dialog', () => {
    const apply = read('src/http/public/views/apply.js');
    assert.match(apply, /from '\.\.\/lib\/imagecrop\.js'/);
    assert.match(apply, /cropImage\(chosen, \{ aspect: CARD_ASPECT/);
    assert.match(apply, /api\('\/api\/salons\/apply\/image', \{\s*method: 'PUT'/);
    // The preview is what the server has, not what was picked.
    assert.match(apply, /paintCover\(await apiImageDataUrl\('\/api\/salons\/apply\/image'\)\)/);
    // And the old "paste a link" instruction is gone.
    assert.doesNotMatch(apply, /direct uploads are coming/);
  });
});
