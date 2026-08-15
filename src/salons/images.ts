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
