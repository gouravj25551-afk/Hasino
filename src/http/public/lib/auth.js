/**
 * Clerk Auth: Google sign-in, plus the phone-link step that satisfies
 * users.phone NOT NULL.
 *
 * No bundler — @clerk/clerk-js loads as a native ES module straight from the
 * CDN, pinned to one version, the same way the rest of this app's JavaScript
 * is served. Clerk's React SDKs are the documented path and would need a build
 * step; clerk-js is the same library underneath and needs none.
 *
 * The publishable key comes from GET /api/config. It is not secret — it ships
 * to every browser by design — but it is environment-specific, so it is served
 * from server env rather than hardcoded here.
 *
 * The exported surface is deliberately identical to what the Firebase version
 * exposed, so index.html, business.html, admin.html and views/login.js did not
 * have to learn a new shape.
 */

const SDK_VERSION = '6.27.1';
const SDK_URL = `https://cdn.jsdelivr.net/npm/@clerk/clerk-js@${SDK_VERSION}/dist/clerk.mjs`;

let clerk = null;
let loadPromise = null;
let configPromise = null;

/**
 * The SDK is fetched lazily, inside here, rather than imported at module
 * scope.
 *
 * clerk-js is 1.5MB. A top-level `await import()` of it would block this
 * module's evaluation, and therefore the whole app's module graph, on that
 * download — and if the CDN were unreachable the entire page would fail to
 * boot rather than just losing sign-in. Browsing is public and must survive an
 * auth provider that is slow, unconfigured, or down.
 */
async function ensureClerk() {
  if (clerk?.loaded) return clerk;
  loadPromise ??= (async () => {
    configPromise ??= fetch('/api/config').then((r) => r.json());
    const { clerk: cfg } = await configPromise;
    if (!cfg?.publishableKey) {
      throw new Error('Clerk is not configured on the server (CLERK_PUBLISHABLE_KEY is unset)');
    }
    const mod = await import(SDK_URL);
    const Clerk = mod.Clerk ?? mod.default;
    if (typeof Clerk !== 'function') {
      throw new Error('clerk-js loaded but exported no Clerk constructor');
    }
    const instance = new Clerk(cfg.publishableKey);
    await instance.load({
      // The app renders its own chrome; Clerk supplies identity, not UI.
      // Redirects are handled by the hash router.
      signInUrl: '/#/login',
      afterSignOutUrl: '/#/home',
    });
    clerk = instance;
    return instance;
  })();
  return loadPromise;
}

/**
 * Fires `handler(user | null)` once the session is restored, and again on
 * every change. Clerk restores asynchronously, so the first call is what tells
 * a page whether it is looking at a signed-out visitor or a slow load.
 */
export async function watchAuthState(handler) {
  const c = await ensureClerk();
  handler(c.user ?? null);
  return c.addListener(({ user }) => handler(user ?? null));
}

/**
 * Google sign-in.
 *
 * Clerk's OAuth is a full redirect rather than a popup, so this never returns
 * on success — the browser leaves and comes back at the redirect URL, where
 * watchAuthState picks the session up. That is why the caller must treat a
 * resolved promise as "we are navigating", not "we are signed in".
 */
export async function signInWithGoogle() {
  const c = await ensureClerk();
  try {
    await c.client.signIn.authenticateWithRedirect({
      strategy: 'oauth_google',
      redirectUrl: window.location.origin + '/#/login',
      redirectUrlComplete: window.location.origin + '/#/home',
    });
    return null; // navigating away
  } catch (err) {
    if (/network/i.test(err?.message ?? '')) {
      throw Object.assign(new Error('Network error — check your connection and try again'), { code: 'NETWORK' });
    }
    throw err;
  }
}

/**
 * Kept for API compatibility with the shell's boot sequence. Clerk finishes
 * the OAuth handshake inside load(), so by the time anything calls this the
 * session already exists or does not; there is no separate result to consume.
 */
export async function consumeRedirectResult() {
  const c = await ensureClerk();
  return c.user ? { user: c.user } : null;
}

export async function signOut() {
  const c = await ensureClerk();
  await c.signOut();
}

/**
 * The session token for `Authorization: Bearer <token>`, or null when signed
 * out. Clerk caches it and refreshes shortly before expiry, so this is cheap
 * to call per request; `forceRefresh` skips the cache after a 401.
 */
export async function currentIdToken(forceRefresh = false) {
  const c = await ensureClerk();
  if (!c.session) return null;
  return c.session.getToken(forceRefresh ? { skipCache: true } : undefined);
}

export function currentUser() {
  return clerk?.user ?? null;
}

// ---------- phone link: the 428 PHONE_REQUIRED flow ----------

/**
 * Google carries no phone number, and users.phone is NOT NULL UNIQUE because a
 * salon has to be able to ring the customer. It is also how a salon owner
 * claims the account an admin created for them — resolveSession matches on the
 * verified number. So a new Google account links a phone before it can exist.
 *
 * Unlike the Firebase version this needs no reCAPTCHA container: Clerk handles
 * bot protection itself, so the caller no longer passes a container id. The
 * argument is still accepted and ignored, so the login view did not have to
 * change shape.
 */
export async function sendPhoneLinkOtp(phoneNumber, _containerId) {
  const c = await ensureClerk();
  if (!c.user) throw new Error('Sign in with Google first');

  try {
    const created = await c.user.createPhoneNumber({ phoneNumber });
    await created.prepareVerification();
    // Returned as a handle so confirmPhoneLinkOtp mirrors the old signature.
    return created;
  } catch (err) {
    const message = clerkMessage(err);
    if (/already.*(in use|exists|taken)/i.test(message)) {
      throw Object.assign(new Error('That phone number is already linked to another account'), {
        code: 'PHONE_TAKEN',
      });
    }
    if (/invalid/i.test(message)) {
      throw Object.assign(new Error('That does not look like a valid phone number'), { code: 'BAD_PHONE' });
    }
    throw Object.assign(new Error(message), { code: 'SEND_FAILED' });
  }
}

/** Step 2: verify the OTP, completing the link. */
export async function confirmPhoneLinkOtp(phoneNumberResource, code) {
  try {
    const verified = await phoneNumberResource.attemptVerification({ code });
    if (verified?.verification?.status !== 'verified') {
      throw Object.assign(new Error('That code is incorrect'), { code: 'BAD_OTP' });
    }
    // The server reads the phone from Clerk's Backend API, and only trusts a
    // number whose verification status is 'verified'. Reload so the next
    // /api/me sees it rather than racing the propagation.
    await clerk?.user?.reload?.();
    return verified;
  } catch (err) {
    if (err?.code === 'BAD_OTP') throw err;
    const message = clerkMessage(err);
    if (/already.*(in use|exists|taken)/i.test(message)) {
      throw Object.assign(new Error('That phone number is already linked to another account'), {
        code: 'PHONE_TAKEN',
      });
    }
    if (/incorrect|invalid|expired/i.test(message)) {
      throw Object.assign(new Error('That code is incorrect or has expired'), { code: 'BAD_OTP' });
    }
    throw err;
  }
}

/** Clerk puts the useful text in errors[0], not in message. */
function clerkMessage(err) {
  return err?.errors?.[0]?.longMessage ?? err?.errors?.[0]?.message ?? err?.message ?? 'Unknown error';
}
