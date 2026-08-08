/**
 * Token verification. Spec §7: Firebase Auth for identity, Postgres for data.
 *
 * The verifier is an interface rather than a direct firebase-admin call so the
 * authorization logic above it — user provisioning, roles, ownership — is
 * testable without a Firebase project. That logic is where the security bugs
 * live; signature checking is Google's problem.
 */

export interface VerifiedToken {
  uid: string;
  phone?: string | undefined;
  email?: string | undefined;
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

/** Real verification against a Firebase project. */
export class FirebaseVerifier implements TokenVerifier {
  readonly kind = 'firebase';
  #auth: import('firebase-admin/auth').Auth | null = null;

  async #getAuth() {
    if (this.#auth) return this.#auth;
    const { initializeApp, getApps, cert, applicationDefault } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');

    if (getApps().length === 0) {
      // FIREBASE_SERVICE_ACCOUNT (inline JSON) suits Railway/Render/Fly, where
      // mounting a key file is awkward. GOOGLE_APPLICATION_CREDENTIALS is the
      // path-based alternative and what Cloud Run injects for free.
      const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
      initializeApp(
        inline
          ? { credential: cert(JSON.parse(inline) as Record<string, string>) }
          : { credential: applicationDefault() },
      );
    }
    this.#auth = getAuth();
    return this.#auth;
  }

  async verify(idToken: string): Promise<VerifiedToken> {
    let decoded;
    try {
      // checkRevoked: a disabled or signed-out account must stop working
      // immediately, not in up to an hour when the token expires.
      decoded = await (await this.#getAuth()).verifyIdToken(idToken, true);
    } catch (err) {
      throw new AuthError(401, 'INVALID_TOKEN', `Token rejected: ${(err as Error).message}`);
    }
    return {
      uid: decoded.uid,
      phone: decoded.phone_number,
      email: decoded.email,
      name: typeof decoded['name'] === 'string' ? decoded['name'] : undefined,
      picture: typeof decoded['picture'] === 'string' ? decoded['picture'] : undefined,
    };
  }
}

/**
 * Local development only. Trusts a header naming the user directly.
 * server.ts refuses to boot with this in production.
 */
export class DevVerifier implements TokenVerifier {
  readonly kind = 'dev';
  async verify(idToken: string): Promise<VerifiedToken> {
    return {
      uid: 'dev:' + idToken,
    };
  }
}

export function verifierFromEnv(devAuth: boolean): TokenVerifier {
  return devAuth ? new DevVerifier() : new FirebaseVerifier();
}
