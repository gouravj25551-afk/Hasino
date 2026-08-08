import type { Pool, PoolClient } from '../db/pool.ts';
import { AuthError, type TokenVerifier, type VerifiedToken } from './verifier.ts';

type Queryable = Pool | PoolClient;

export interface Session {
  userId: string;
  role: 'customer' | 'business' | 'admin';
  phone: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  blockedUntil: Date | null;
}

/**
 * Turn a verified token into the users row that owns bookings, creating it on
 * first sign-in.
 *
 * Three rules here are load-bearing:
 *
 * 1. A new account is ALWAYS 'customer'. Roles never come from token claims —
 *    otherwise anyone who can mint a custom claim, or any future bug in claim
 *    propagation, becomes a salon owner or admin. Elevation is an admin
 *    action against the database.
 *
 * 2. Linking by phone is safe *only* because Firebase has already verified
 *    ownership of that number. We never accept a client-supplied phone.
 *
 * 3. users.phone is NOT NULL UNIQUE, and a salon has to be able to ring the
 *    customer. Google sign-in carries no phone, so the client must link a
 *    phone credential before the account can exist. 428 tells it to do that.
 */
export async function resolveSession(
  db: Queryable,
  token: VerifiedToken,
  _now: Date = new Date(),
): Promise<Session> {
  const existing = await db.query<{
    id: string;
    role: Session['role'];
    phone: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
    blocked_until: Date | null;
  }>(
    `SELECT id, role, phone, name, email, avatar_url, blocked_until FROM users WHERE firebase_uid = $1`,
    [token.uid],
  );

  const found = existing.rows[0];
  if (found) {
    // Update name/email/avatar_url/updated_at if available from token
    if (token.name || token.email || token.picture) {
      await db.query(
        `UPDATE users
            SET name = coalesce($2, name),
                email = coalesce($3, email),
                avatar_url = coalesce($4, avatar_url),
                updated_at = now()
          WHERE id = $1`,
        [found.id, token.name ?? null, token.email ?? null, token.picture ?? null],
      );
    }
    return {
      userId: found.id,
      role: found.role,
      phone: found.phone,
      name: token.name ?? found.name,
      email: token.email ?? found.email,
      avatarUrl: token.picture ?? found.avatar_url,
      blockedUntil: found.blocked_until,
    };
  }

  // users.phone is NOT NULL UNIQUE, and a salon has to be able to ring the
  // customer. Google sign-in carries no phone, so the client must link a
  // phone credential before the account can exist. 428 tells it to do that.
  if (!token.phone) {
    throw new AuthError(
      428,
      'PHONE_REQUIRED',
      'Link a verified phone number to this account before booking',
    );
  }

  const linked = await db.query<{
    id: string;
    role: Session['role'];
    phone: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
    blocked_until: Date | null;
  }>(
    `INSERT INTO users (phone, firebase_uid, name, email, avatar_url, role)
     VALUES ($1, $2, $3, $4, $5, 'customer')
     ON CONFLICT (phone) DO UPDATE
       SET firebase_uid = EXCLUDED.firebase_uid,
           name  = coalesce(users.name, EXCLUDED.name),
           email = coalesce(users.email, EXCLUDED.email),
           avatar_url = coalesce(users.avatar_url, EXCLUDED.avatar_url),
           updated_at = now()
     WHERE users.firebase_uid IS NULL OR users.firebase_uid = EXCLUDED.firebase_uid
     RETURNING id, role, phone, name, email, avatar_url, blocked_until`,
    [token.phone, token.uid, token.name ?? null, token.email ?? null, token.picture ?? null],
  );

  const row = linked.rows[0];
  if (!row) {
    // The phone belongs to a row already bound to a *different* Firebase uid.
    // Silently rebinding would hand one person another's booking history.
    throw new AuthError(
      409,
      'PHONE_TAKEN',
      'That phone number is already linked to another account',
    );
  }

  return {
    userId: row.id,
    role: row.role,
    phone: row.phone,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatar_url,
    blockedUntil: row.blocked_until,
  };
}

/** Bearer token out of the Authorization header. */
export function bearer(authorization: string | undefined): string {
  if (!authorization) throw new AuthError(401, 'NO_TOKEN', 'Missing Authorization header');
  const m = /^Bearer (.+)$/i.exec(authorization.trim());
  if (!m) throw new AuthError(401, 'NO_TOKEN', 'Authorization must be "Bearer <idToken>"');
  return m[1]!;
}

export async function authenticate(
  db: Queryable,
  verifier: TokenVerifier,
  authorization: string | undefined,
): Promise<Session> {
  return resolveSession(db, await verifier.verify(bearer(authorization)));
}

export function requireRole(session: Session, role: Session['role']): void {
  // admin is a superset of business for panel access; customers never are.
  const ok = session.role === role || (role === 'business' && session.role === 'admin');
  if (!ok) {
    throw new AuthError(403, 'WRONG_ROLE', `This endpoint requires the ${role} role`);
  }
}
