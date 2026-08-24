import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Pool, PoolClient } from '../db/pool.ts';
import { withTransaction } from '../db/pool.ts';

/**
 * A salon's storefront photo: stored in Postgres, pointed at by cover_url.
 *
 * One module because both servers need it and they are separate processes: the
 * public server takes the owner's upload and serves the bytes to customers,
 * the admin server takes the admin's upload during onboarding and serves the
 * same bytes back into the admin panel. They share a database and nothing
 * else, which is exactly why the bytes live in the database — see
 * db/migrations/008_salon_images.sql.
 */

type Queryable = Pool | PoolClient;

/**
 * 2 MB.
 *
 * A phone camera shot is 2-5 MB, so this rejects some straight-off-the-camera
 * files. That is deliberate for now: the alternative is either an unbounded
 * upload path or server-side re-encoding, and neither belongs in the first
 * version of this. The panel says the limit before the file is chosen and
 * names it again on rejection, which is the difference between a limit and a
 * failure.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export class ImageUploadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ImageUploadError';
    this.status = status;
    this.code = code;
  }
}

/**
 * What the file actually is, read from its first bytes.
 *
 * The browser's content-type header is a claim by the uploader, and this image
 * is rendered into an <img> on three surfaces including the admin's own panel.
 * A file that says image/png and begins with `<script` is the oldest trick
 * there is; the header is therefore ignored entirely and the signature
 * decides. An unrecognised signature is rejected rather than stored as
 * octet-stream, because there is no use here for a file that is not an image.
 */
export function sniffImageType(bytes: Buffer): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * The request body, with the size cap enforced while it streams.
 *
 * The cap is checked per chunk rather than against content-length, because
 * content-length is a header and a client is free to lie in it. This way a
 * 50 MB upload is dropped after the first 2 MB regardless of what it claimed.
 */
export async function readImageBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_IMAGE_BYTES) {
      throw new ImageUploadError(
        413,
        'IMAGE_TOO_LARGE',
        `That image is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB. Please upload a smaller one.`,
      );
    }
    chunks.push(chunk as Buffer);
  }
  if (size === 0) throw new ImageUploadError(400, 'EMPTY_IMAGE', 'No image was uploaded');
  return Buffer.concat(chunks);
}

/** The URL a stored image is served from. Same origin, so it works in the app too. */
export function coverUrlFor(salonId: string, checksum: string): string {
  // The checksum in the query string is what lets the response be cached hard:
  // replacing the photo changes the URL, so nothing anywhere serves the old
  // one, and cover_url changing is what tells every reader it moved.
  return `/api/salons/${salonId}/image?v=${checksum}`;
}

export interface StoredImage {
  contentType: ImageType;
  byteSize: number;
  checksum: string;
  coverUrl: string;
}

/**
 * Store (or replace) a salon's storefront photo and point cover_url at it.
 *
 * Callers are responsible for authorisation — the owner route resolves the
 * salon from the signed-in owner and the admin route from an admin session.
 * `salonId` must never come from a request body.
 */
export async function saveSalonImage(
  db: Pool,
  salonId: string,
  bytes: Buffer,
  uploadedBy: string | null,
): Promise<StoredImage> {
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw new ImageUploadError(
      415,
      'UNSUPPORTED_IMAGE',
      'That file is not a JPEG, PNG or WebP image.',
    );
  }

  const checksum = createHash('sha256').update(bytes).digest('base64url').slice(0, 22);
  const coverUrl = coverUrlFor(salonId, checksum);

  // One transaction: a stored image whose salon still points at the old URL —
  // or worse, at nothing — is the state where the upload "worked" and the
  // photo never appears.
  await withTransaction(db, async (tx) => {
    const salon = await tx.query(`SELECT 1 FROM salons WHERE id = $1`, [salonId]);
    if (salon.rowCount === 0) {
      throw new ImageUploadError(404, 'NO_SUCH_SALON', 'No such salon');
    }
    await tx.query(
      `INSERT INTO salon_images (salon_id, content_type, bytes, byte_size, checksum, uploaded_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (salon_id) DO UPDATE
         SET content_type = EXCLUDED.content_type,
             bytes        = EXCLUDED.bytes,
             byte_size    = EXCLUDED.byte_size,
             checksum     = EXCLUDED.checksum,
             uploaded_by  = EXCLUDED.uploaded_by,
             updated_at   = now()`,
      [salonId, contentType, bytes, bytes.length, checksum, uploadedBy],
    );
    await tx.query(`UPDATE salons SET cover_url = $2 WHERE id = $1`, [salonId, coverUrl]);
  });

  return { contentType, byteSize: bytes.length, checksum, coverUrl };
}

export interface LoadedImage {
  contentType: string;
  bytes: Buffer;
  checksum: string;
}

export async function loadSalonImage(db: Queryable, salonId: string): Promise<LoadedImage | null> {
  const res = await db.query<{ content_type: string; bytes: Buffer; checksum: string }>(
    `SELECT content_type, bytes, checksum FROM salon_images WHERE salon_id = $1`,
    [salonId],
  );
  const row = res.rows[0];
  return row ? { contentType: row.content_type, bytes: row.bytes, checksum: row.checksum } : null;
}

/**
 * GET /api/salons/:id/image — public, on both servers.
 *
 * Public because the customer app is public: a salon card is visible to
 * someone who has never signed in, and its photo has to be too. Cached for a
 * year and revalidated by ETag, which is safe because the URL carries the
 * content hash — a new photo is a different URL rather than the same URL with
 * different bytes.
 */
export async function serveSalonImage(
  db: Queryable,
  salonId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const image = await loadSalonImage(db, salonId);
  if (!image) return false;

  const etag = `"${image.checksum}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'public, max-age=31536000, immutable' });
    res.end();
    return true;
  }

  res.writeHead(200, {
    'content-type': image.contentType,
    'content-length': String(image.bytes.length),
    etag,
    'cache-control': 'public, max-age=31536000, immutable',
    // Belt and braces for a store of user-uploaded bytes: even if the sniffer
    // were ever fooled, the browser must not be talked into running it.
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
  });
  res.end(image.bytes);
  return true;
}

// ---------- staged uploads: a photo with no salon yet ----------

/**
 * How long an uploaded-but-never-submitted photo is kept.
 *
 * Long enough that someone can upload, close the tab, and come back the next
 * day to finish their application; short enough that abandoned bytes do not
 * accumulate forever. The sweep is in src/workers/runner.ts.
 */
export const STAGED_IMAGE_TTL_HOURS = 72;

export interface StagedImage {
  contentType: ImageType;
  byteSize: number;
  checksum: string;
  /** Where the applicant's own browser can fetch it back for a preview. */
  url: string;
}

/** The URL a staged image is served from. No id in it: it is always yours. */
export function stagedImageUrl(checksum: string): string {
  return `/api/salons/apply/image?v=${checksum}`;
}

/**
 * Store (or replace) the storefront photo an applicant is staging.
 *
 * Keyed to the user and nothing else. There is no id in the request for
 * anyone to tamper with, and the primary key means uploading again replaces
 * rather than accumulates — an applicant is staging *the* photo, and a second
 * upload means "no, this one instead".
 *
 * The bytes are sniffed exactly as saveSalonImage sniffs them: the browser's
 * content-type header is a claim by the uploader and this image is rendered
 * into an <img> on the applicant's own screen and, once claimed, on an
 * admin's.
 */
export async function saveStagedImage(
  db: Queryable,
  userId: string,
  bytes: Buffer,
): Promise<StagedImage> {
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw new ImageUploadError(
      415,
      'UNSUPPORTED_IMAGE',
      'That file is not a JPEG, PNG or WebP image.',
    );
  }
  const checksum = createHash('sha256').update(bytes).digest('base64url').slice(0, 22);

  await db.query(
    `INSERT INTO salon_image_uploads (user_id, content_type, bytes, byte_size, checksum, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id) DO UPDATE
       SET content_type = EXCLUDED.content_type,
           bytes        = EXCLUDED.bytes,
           byte_size    = EXCLUDED.byte_size,
           checksum     = EXCLUDED.checksum,
           updated_at   = now()`,
    [userId, contentType, bytes, bytes.length, checksum],
  );

  return { contentType, byteSize: bytes.length, checksum, url: stagedImageUrl(checksum) };
}

/**
 * GET /api/salons/apply/image — the applicant's own staged photo.
 *
 * Private, unlike serveSalonImage: this is a photo of a business nobody has
 * approved, belonging to an application nobody else can see, so it is served
 * to the session that uploaded it and to no one else. The admin sees it after
 * submission, on the salon, through the public route.
 *
 * Not cached. The URL carries the content hash so a replacement is a new URL,
 * but the *previous* URL would then serve whatever the user uploaded next
 * from a cache keyed on a path with no id in it. no-store is the honest
 * answer for a per-session resource.
 */
export async function serveStagedImage(
  db: Queryable,
  userId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const found = await db.query<{ content_type: string; bytes: Buffer; checksum: string }>(
    `SELECT content_type, bytes, checksum FROM salon_image_uploads WHERE user_id = $1`,
    [userId],
  );
  const image = found.rows[0];
  if (!image) return false;

  const etag = `"${image.checksum}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  res.writeHead(200, {
    'content-type': image.content_type,
    'content-length': String(image.bytes.length),
    etag,
    'cache-control': 'no-store, private',
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
  });
  res.end(image.bytes);
  return true;
}

/** Whether this applicant has a photo staged, without reading the bytes. */
export async function stagedImageFor(
  db: Queryable,
  userId: string,
): Promise<{ checksum: string; byteSize: number; url: string } | null> {
  const res = await db.query<{ checksum: string; byte_size: number }>(
    `SELECT checksum, byte_size FROM salon_image_uploads WHERE user_id = $1`,
    [userId],
  );
  const row = res.rows[0];
  return row
    ? { checksum: row.checksum, byteSize: row.byte_size, url: stagedImageUrl(row.checksum) }
    : null;
}

export async function deleteStagedImage(db: Queryable, userId: string): Promise<boolean> {
  const res = await db.query(`DELETE FROM salon_image_uploads WHERE user_id = $1`, [userId]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Move an applicant's staged photo onto the salon their submission just
 * created, and point cover_url at it.
 *
 * Takes a transaction rather than a pool on purpose: this runs inside the one
 * applyForSalon opens, so a submitted application either has its photo or
 * failed outright. The half-state — a salon whose application was accepted and
 * whose photo silently stayed in staging — is the one worth designing out.
 *
 * The bytes move by INSERT ... SELECT rather than by being read into the
 * application and written back: they are already sniffed and hashed, and
 * a megabyte does not need a round trip through Node to change tables.
 *
 * Returns the cover URL when there was something to claim, null when there
 * was not — an applicant who pasted a link instead, or who did not give a
 * photo at all.
 */
export async function claimStagedImage(
  tx: PoolClient,
  userId: string,
  salonId: string,
): Promise<string | null> {
  const staged = await tx.query<{ checksum: string }>(
    `SELECT checksum FROM salon_image_uploads WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  const row = staged.rows[0];
  if (!row) return null;

  await tx.query(
    `INSERT INTO salon_images (salon_id, content_type, bytes, byte_size, checksum, uploaded_by, updated_at)
     SELECT $2, content_type, bytes, byte_size, checksum, $1, now()
       FROM salon_image_uploads
      WHERE user_id = $1
     ON CONFLICT (salon_id) DO UPDATE
       SET content_type = EXCLUDED.content_type,
           bytes        = EXCLUDED.bytes,
           byte_size    = EXCLUDED.byte_size,
           checksum     = EXCLUDED.checksum,
           uploaded_by  = EXCLUDED.uploaded_by,
           updated_at   = now()`,
    [userId, salonId],
  );

  const coverUrl = coverUrlFor(salonId, row.checksum);
  await tx.query(`UPDATE salons SET cover_url = $2 WHERE id = $1`, [salonId, coverUrl]);
  // The staged row has done its job. Leaving it would mean the same bytes in
  // two tables and a second answer to "where is this salon's photo".
  await tx.query(`DELETE FROM salon_image_uploads WHERE user_id = $1`, [userId]);

  return coverUrl;
}

/**
 * Delete staged photos nobody submitted.
 *
 * The other half of "upload before the salon exists": most staged rows are
 * claimed within minutes, and the rest are people who changed their mind.
 * Without this they would sit in the database forever.
 */
export async function sweepStagedImages(
  db: Queryable,
  ttlHours: number = STAGED_IMAGE_TTL_HOURS,
): Promise<{ swept: number }> {
  const res = await db.query(
    `DELETE FROM salon_image_uploads WHERE updated_at < now() - ($1 || ' hours')::interval`,
    [String(ttlHours)],
  );
  return { swept: res.rowCount ?? 0 };
}
