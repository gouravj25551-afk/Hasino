/**
 * Token verification. Spec §7: the identity provider owns identity, Postgres
 * owns data.
 *
 * The verifier is an interface rather than a direct SDK call so the
 * authorization logic above it — user provisioning, roles, ownership — is
 * testable without a provider account. That logic is where the security bugs
 * live; signature checking is the provider's problem. It is also what made
 * swapping Firebase for Clerk a change to this file and nothing above it.
 */
export interface VerifiedToken {
  uid: string;
  phone?: string | undefined;
  email?: string | undefined;
  /**
   * Whether the provider vouches for the address, not merely that a value is
   * present. Admin elevation keys off ADMIN_EMAILS, so an unverified `email`
   * claim is an unauthenticated string that must never grant a role — see
   * resolveSession.
   */
  emailVerified?: boolean | undefined;
  name?: string | undefined;
  picture?: string | undefined;
}

export interface TokenVerifier {
  readonly kind: string;
  verify(idToken: string): Promise<VerifiedToken>;
}

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Real verification against a Clerk instance.
 *
 * Two steps, deliberately split by cost:
 *
 * 1. verifyToken() checks the session JWT's signature locally against Clerk's
 *    JWKS (fetched once and cached by the SDK). No network call per request.
 *    This runs on every authenticated request, so it has to be cheap.
 *
 * 2. The Backend API is called only for the profile — email, phone, name,
 *    avatar — because a default Clerk session token carries `sub` and little
 *    else. Requiring a custom JWT template instead would put a dashboard
 *    setting on the critical path, and a deploy where someone forgot it fails
 *    as "admin elevation mysteriously stopped working".
 *
 * Step 2 is skipped when the caller only needs identity, which is the common
 * case: resolveSession looks the user up by auth_provider_id and already has
 * their profile locally. See `verify` vs `verifyIdentityOnly`.
 */
export class ClerkVerifier implements TokenVerifier {
  readonly kind = 'clerk';
  #client: ReturnType<typeof import('@clerk/backend').createClerkClient> | null = null;
  #secretKey: string | undefined;

  constructor(secretKey = process.env['CLERK_SECRET_KEY']) {
    this.#secretKey = secretKey;
  }

  async #getClient() {
    if (this.#client) return this.#client;
    if (!this.#secretKey) {
      throw new AuthError(
        500,
        'AUTH_NOT_CONFIGURED',
        'CLERK_SECRET_KEY is not set, so no token can be verified',
      );
    }
    const { createClerkClient } = await import('@clerk/backend');
    this.#client = createClerkClient({ secretKey: this.#secretKey });
    return this.#client;
  }

  /** The subject claim, after a local signature check. */
  async #subject(token: string): Promise<string> {
    if (!this.#secretKey) {
      throw new AuthError(
        500,
        'AUTH_NOT_CONFIGURED',
        'CLERK_SECRET_KEY is not set, so no token can be verified',
      );
    }
    const { verifyToken } = await import('@clerk/backend');
    try {
      const claims = await verifyToken(token, { secretKey: this.#secretKey });
      if (!claims.sub) throw new Error('token carries no subject');
      return claims.sub;
    } catch (err) {
      throw new AuthError(401, 'INVALID_TOKEN', `Token rejected: ${(err as Error).message}`);
    }
  }

  async verify(idToken: string): Promise<VerifiedToken> {
    const userId = await this.#subject(idToken);

    let user;
    try {
      user = await (await this.#getClient()).users.getUser(userId);
    } catch (err) {
      // The signature was good, so the token is real; the user being
      // unreadable means deleted, or a secret key pointing at a different
      // instance. Either way this identity cannot act.
      throw new AuthError(401, 'INVALID_TOKEN', `Could not load the signed-in user: ${(err as Error).message}`);
    }

    // Clerk keeps several addresses per user; the primary one is what the
    // person signed in with and the only one worth trusting for identity.
    const email = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
    const phone = user.phoneNumbers.find((p) => p.id === user.primaryPhoneNumberId);

    return {
      uid: userId,
      // Only a verified number satisfies users.phone. An unverified one is a
      // string the user typed, and salons ring these.
      phone: phone?.verification?.status === 'verified' ? phone.phoneNumber : undefined,
      email: email?.emailAddress,
      emailVerified: email?.verification?.status === 'verified',
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined,
      picture: user.imageUrl || undefined,
    };
  }
}

/**
 * CI only. Trusts a header naming the user directly. server.ts refuses to boot
 * with this in production, and ignores it unless CI_SMOKE is also set.
 *
 * A token containing '@' is treated as a verified email address for that
 * identity. Admin elevation requires a verified email in ADMIN_EMAILS, and the
 * demotion rule is fail-closed — an admin row whose sign-in presents no such
 * email is demoted. Without this, a CI fixture admin would be demoted by its
 * own first request and every /api/admin/* smoke check would 403.
 */
export class DevVerifier implements TokenVerifier {
  readonly kind = 'dev';
  async verify(idToken: string): Promise<VerifiedToken> {
    const looksLikeEmail = idToken.includes('@');
    return {
      uid: 'dev:' + idToken,
      email: looksLikeEmail ? idToken : undefined,
      emailVerified: looksLikeEmail,
    };
  }
}

export function verifierFromEnv(devAuth: boolean): TokenVerifier {
  return devAuth ? new DevVerifier() : new ClerkVerifier();
}
