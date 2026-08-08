/**
 * Firebase Auth: Google sign-in + the phone-link flow that satisfies
 * users.phone NOT NULL. No bundler — the Firebase Web SDK loads as native
 * ES modules straight from the CDN, pinned to one version.
 *
 * Config comes from GET /api/config (not secret, but environment-specific,
 * so it isn't hardcoded here).
 */

const SDK_VERSION = '11.0.2';

const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`);
const {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut: firebaseSignOut,
  RecaptchaVerifier,
  linkWithPhoneNumber,
} = await import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-auth.js`);

let auth = null;
let configPromise = null;

async function ensureApp() {
  if (auth) return auth;
  configPromise ??= fetch('/api/config').then((r) => r.json());
  const { firebase } = await configPromise;
  if (!firebase.apiKey) {
    throw new Error('Firebase is not configured on the server (FIREBASE_WEB_API_KEY and friends are unset)');
  }
  auth = getAuth(initializeApp(firebase));
  return auth;
}

/** Fires `handler(user | null)` immediately and on every sign-in state change. */
export async function watchAuthState(handler) {
  const a = await ensureApp();
  return onAuthStateChanged(a, handler);
}

/**
 * Google sign-in. Popup first (best UX, no full page reload); falls back to
 * signInWithRedirect if the popup was blocked, which is common on mobile
 * browsers and in-app webviews. A redirect reloads the page, so its result
 * surfaces later through consumeRedirectResult()/watchAuthState(), not the
 * return value here.
 */
export async function signInWithGoogle() {
  const a = await ensureApp();
  const provider = new GoogleAuthProvider();
  try {
    return await signInWithPopup(a, provider);
  } catch (err) {
    if (err.code === 'auth/popup-blocked') {
      await signInWithRedirect(a, provider);
      return null;
    }
    if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
      throw Object.assign(new Error('Sign-in was cancelled'), { code: 'CANCELLED' });
    }
    if (err.code === 'auth/network-request-failed') {
      throw Object.assign(new Error('Network error — check your connection and try again'), { code: 'NETWORK' });
    }
    throw err;
  }
}

/** Call once on app boot to pick up the result of a signInWithRedirect(). */
export async function consumeRedirectResult() {
  const a = await ensureApp();
  try {
    return await getRedirectResult(a);
  } catch (err) {
    console.error('Redirect sign-in failed', err);
    return null;
  }
}

export async function signOut() {
  const a = await ensureApp();
  await firebaseSignOut(a);
}

/** The ID token for `Authorization: Bearer <idToken>`. null when signed out. */
export async function currentIdToken(forceRefresh = false) {
  const a = await ensureApp();
  return a.currentUser ? a.currentUser.getIdToken(forceRefresh) : null;
}

export function currentUser() {
  return auth?.currentUser ?? null;
}

// ---------- phone link: the 428 PHONE_REQUIRED flow ----------

let recaptcha = null;

/** An invisible reCAPTCHA bound to `containerId`. Firebase phone auth requires one. */
async function getRecaptcha(containerId) {
  const a = await ensureApp();
  recaptcha ??= new RecaptchaVerifier(a, containerId, { size: 'invisible' });
  return recaptcha;
}

/**
 * Step 1: send the OTP and link it to the CURRENT Google-signed-in user —
 * never a fresh sign-in, so this can't create a second account for the same
 * person. Returns a confirmation handle for confirmPhoneLinkOtp().
 */
export async function sendPhoneLinkOtp(phoneNumber, containerId) {
  const a = await ensureApp();
  if (!a.currentUser) throw new Error('Sign in with Google first');
  const verifier = await getRecaptcha(containerId);
  return linkWithPhoneNumber(a.currentUser, phoneNumber, verifier);
}

/** Step 2: verify the OTP, completing the link. */
export async function confirmPhoneLinkOtp(confirmationResult, code) {
  try {
    return await confirmationResult.confirm(code);
  } catch (err) {
    if (err.code === 'auth/credential-already-in-use' || err.code === 'auth/account-exists-with-different-credential') {
      throw Object.assign(new Error('That phone number is already linked to another account'), {
        code: 'PHONE_TAKEN',
      });
    }
    if (err.code === 'auth/invalid-verification-code') {
      throw Object.assign(new Error('That code is incorrect'), { code: 'BAD_OTP' });
    }
    throw err;
  }
}
