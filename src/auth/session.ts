import type { Pool, PoolClient } from '../db/pool.ts';
import { AuthError, type TokenVerifier, type VerifiedToken } from './verifier.ts';

type Queryable = Pool | PoolClient;

/**
 * ADMIN_EMAILS is the single source of truth for who is an admin.
 *
 * The first admin cannot be created by an admin, and hand-editing a role in the
 * database is the thing that gets done once, forgotten, and later exploited.
 * So the env var decides and `users.role` is only a cache of it, re-derived on
 * every sign-in in both directions — see applyAdminPolicy.
 *
 * Read at call time rather than module load so tests can set it per case and a
 * deploy can change it without a code change.
 */
export function adminEmails(): Set<string> {
  return new Set(
    (process.env['ADMIN_EMAILS'] ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Whether this token proves its holder is an admin.
 *
 * Requires a *verified* email. An unverified `email` claim is an
 * unauthenticated string — on a provider that allows unverified sign-ups it is
 * chosen by the person signing up, which would make ADMIN_EMAILS a list of
 * addresses anyone may claim.
 */
function tokenIsAdmin(token: VerifiedToken): boolean {
  if (!token.email || token.emailVerified !== true) return false;
  return adminEmails().has(token.email.trim().toLowerCase());
}

/**
 * Re-derive the admin role from ADMIN_EMAILS on every sign-in.
 *
 * Fail-closed in both directions:
 *  - verified email in the list        -> promote to admin
 *  - stored admin without that proof   -> demote to customer
 *
 * Deliberately scoped to `admin` alone. 'business' is assigned by an admin
 * onboarding a salon, and a salon owner's sign-in carries no ADMIN_EMAILS
 * proof — demoting them here would silently destroy the owner-onboarding
 * mechanism the moment they first log in.
 */
async function applyAdminPolicy(
  db: Queryable,
  userId: string,
  storedRole: Session['role'],
  token: VerifiedToken,
): Promise<Session['role']> {
  const shouldBeAdmin = tokenIsAdmin(token);

  if (shouldBeAdmin && storedRole !== 'admin') {
    await db.query(`UPDATE users SET role = 'admin', updated_at = now() WHERE id = $1`, [userId]);
    return 'admin';
  }
  if (!shouldBeAdmin && storedRole === 'admin') {
    await db.query(`UPDATE users SET role = 'customer', updated_at = now() WHERE id = $1`, [userId]);
    return 'customer';
  }
  return storedRole;
}

export interface Session {
  userId: string;
  role: 'customer' | 'business' | 'admin';
  /**
   * Null for anyone who signed in with Google and never had a number recorded
   * — which is now every new account. Present on rows an admin onboarded, and
   * on accounts created before the number stopped being required.
   */
  phone: string | null;
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
 * 2. Adopting a pre-existing row is safe *only* because the identity provider
 *    has already verified ownership of the identifier being matched. A
 *    client-supplied value is never accepted, and an unverified claim is
 *    treated as absent — see claimByEmail.
 *
 * 3. Google carries no phone number, so a first sign-in creates the account
 *    from the Google identity alone. This used to answer 428 PHONE_REQUIRED
 *    instead and make the client collect a number first; that step is gone,
 *    and users.phone is nullable to match.
 */
/**
 * Adopt a row an admin created before its owner ever signed in.
 *
 * This is the join that used to run on the phone number: an admin onboards a
 * salon, which writes a `business` users row, and the owner takes ownership of
 * it on their first Google sign-in. Google carries no phone, so the verified
 * email address is what identifies them now.
 *
 * The trust model is unchanged and rests entirely on `emailVerified`. An
 * unverified address is a string the person signing up chose, and honouring it
 * here would let anyone claim a salon by typing its owner's address into a
 * throwaway account. So an unverified email claims nothing — it is treated
 * exactly as if it were absent.
 *
 * Only a row that has never been signed into is adoptable. The
 * `auth_provider_id IS NULL` guard is what makes that safe: without it, two
 * Google accounts sharing an address on different providers could hand one
 * person the other's booking history. Returns null when there is nothing to
 * claim, and the caller creates a fresh account.
 */
async function claimByEmail(db: Queryable, token: VerifiedToken): Promise<Session | null> {
  if (!token.email || token.emailVerified !== true) return null;

  const res = await db.query<{
    id: string;
    role: Session['role'];
    phone: string | null;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
    blocked_until: Date | null;
  }>(
    `UPDATE users
        SET auth_provider_id = $1,
            name       = coalesce(name, $3),
            avatar_url = coalesce(avatar_url, $4),
            updated_at = now()
      WHERE auth_provider_id IS NULL
        AND lower(email) = lower($2)
      RETURNING id, role, phone, name, email, avatar_url, blocked_until`,
    [token.uid, token.email, token.name ?? null, token.picture ?? null],
  );

  const row = res.rows[0];
  if (!row) return null;

  return {
    userId: row.id,
    // role is deliberately untouched above, so the 'business' an admin
    // assigned survives its owner's first sign-in. Admin is re-derived.
    role: await applyAdminPolicy(db, row.id, row.role, token),
    phone: row.phone,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatar_url,
    blockedUntil: row.blocked_until,
  };
}

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
    `SELECT id, role, phone, name, email, avatar_url, blocked_until FROM users WHERE auth_provider_id = $1`,
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
      role: await applyAdminPolicy(db, found.id, found.role, token),
      phone: found.phone,
      name: token.name ?? found.name,
      email: token.email ?? found.email,
      avatarUrl: token.picture ?? found.avatar_url,
      blockedUntil: found.blocked_until,
    };
  }

  // No row carries this provider id yet, so this is a first sign-in. Before
  // creating an account, see whether an admin already made one for this person
  // — a salon owner's row exists before its owner has ever signed in, and
  // creating a second row here would leave them a customer staring at a panel
  // they cannot open.
  const claimed = await claimByEmail(db, token);
  if (claimed) return claimed;

  const created = await db.query<{
    id: string;
    role: Session['role'];
    phone: string | null;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
    blocked_until: Date | null;
  }>(
    // phone is left NULL: Google does not supply one and nothing is asked of
    // the user. A number arrives later only if an admin records one.
    `INSERT INTO users (auth_provider_id, name, email, avatar_url, role)
     VALUES ($1, $2, $3, $4, 'customer')
     RETURNING id, role, phone, name, email, avatar_url, blocked_until`,
    [token.uid, token.name ?? null, token.email ?? null, token.picture ?? null],
  );

  const row = created.rows[0]!;
  return {
    userId: row.id,
    // The INSERT above always writes 'customer'. Roles are never taken from a
    // token; admin is re-derived from ADMIN_EMAILS.
    role: await applyAdminPolicy(db, row.id, row.role, token),
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

/**
 * Roles do not nest. Admin is its own namespace, not a superset of business.
 *
 * Treating admin as business was a trap: /api/business/* resolves the caller's
 * salon through salonForOwner(), which looks for a salon the *admin* owns,
 * finds none, and throws ForbiddenError. The admin appeared to be authorised
 * and then failed anyway, one layer deeper and with a misleading error. An
 * admin acting on a salon does it through /api/admin/salons/:id, where the
 * salon is named explicitly.
 */
export function requireRole(session: Session, role: Session['role']): void {
  if (session.role !== role) {
    throw new AuthError(403, 'WRONG_ROLE', `This endpoint requires the ${role} role`);
  }
}
