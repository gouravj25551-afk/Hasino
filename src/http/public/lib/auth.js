/**
 * Clerk Auth: Google sign-in, and nothing else.
 *
 * Google supplies the entire identity, so a first sign-in creates the account
 * outright. There is no phone-link step: users.phone is nullable and the
 * server no longer answers 428 PHONE_REQUIRED — see
 * db/migrations/006_users_phone_optional.sql.
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
 * The routes of the app using this module.
 *
 * Clerk has to be told where to send the browser — for a sign-in page, for the
 * landing spot afterwards, for every step of a redirect flow it might need to
 * resume. Those URLs were hardcoded to the customer app's hash routes, which
 * is fine while there is one app and wrong the moment there are two: the admin
 * panel has no '#/login' and no '#/home', so Clerk sent it to a route that
 * does not exist and the router quietly fell back to '#/overview' — a sign-in
 * that appears to do nothing.
 *
 * Defaults are the customer app's, so index.html needs no change. The admin
 * panel calls configureAuthRoutes() with its own.
 */
const routes = { signIn: '/#/login', home: '/#/home' };

/**
 * Must be called before anything triggers clerk-js to load, because load()
 * takes these. Calling it later would leave the SDK configured for whichever
 * app got there first.
 */
export function configureAuthRoutes(next) {
  if (clerk || loadPromise) {
    throw new Error('configureAuthRoutes() must be called before Clerk loads');
  }
  Object.assign(routes, next);
}

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
      signInUrl: routes.signIn,
      afterSignOutUrl: routes.home,
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
 * The path Clerk returns the browser to after Google, served by the server as
 * the app shell — see PAGES in src/http/server.ts.
 *
 * It is a real path, not a hash route, and that is load-bearing. Clerk appends
 * its callback parameters (__clerk_status and friends) to this URL as a query
 * string. Given '/#/login' the browser parses the result as one long fragment,
 * location.search is empty, and handleRedirectCallback finds nothing to act
 * on — which is precisely how the sign-in loop used to happen.
 */
const CALLBACK_PATH = '/sso-callback';

/**
 * Returning to the app after Google: how it works, and why the web code needs
 * no part in it.
 *
 * The sign-in redirect is one ordinary https URL — `/sso-callback` — for every
 * platform. There is deliberately no app-specific callback path or `?native=1`
 * marker any more: both were attempts to have the *page* notice it was stranded
 * in a browser and bounce itself back to the app, and both failed the same way
 * — Clerk rewrites the redirect it round-trips, so the marker never arrived,
 * and a scripted bounce to `hasino://` is a visible interstitial the app is
 * meant not to have.
 *
 * Instead the return is handled entirely on the native side. Google's OAuth is
 * opened in a Chrome Custom Tab (MainActivity opens it there instead of the
 * full browser — see OAuthTabWebViewClient.java), and a Custom Tab hands the
 * verified App Link `/sso-callback` back to the app automatically, with no
 * page and no tap, which standalone Chrome does not do for an OAuth redirect.
 * The WebView then loads `/sso-callback` and finishes the handshake exactly as
 * the web does. So from here, native and web are identical.
 */

/**
 * True inside the Hasino Android app, false in any ordinary browser.
 *
 * Not `window.Capacitor`: the site is loaded from the network rather than from
 * the APK, so Capacitor never injects its bridge and that object does not
 * exist here. The app announces itself in the user agent instead — see
 * appendUserAgent in capacitor.config.ts. The Capacitor check stays as a
 * second signal in case the shell ever serves bundled assets.
 */
export function isNativeApp() {
  return (
    / HasinoApp\//.test(navigator.userAgent) ||
    Boolean(window.Capacitor?.isNativePlatform?.())
  );
}

/** True on the page load that Clerk redirected to after Google. */
export function isRedirectCallback() {
  return window.location.pathname === CALLBACK_PATH;
}

/**
 * Google sign-in, step 1 of 2.
 *
 * Clerk's OAuth is a full redirect rather than a popup, so this never returns
 * on success — the browser leaves for Google and comes back at CALLBACK_PATH,
 * where completeRedirectCallback() finishes the handshake. That is why the
 * caller must treat a resolved promise as "we are navigating", not "we are
 * signed in".
 */
export async function signInWithGoogle() {
  const c = await ensureClerk();
  try {
    await c.client.signIn.authenticateWithRedirect({
      strategy: 'oauth_google',
      // One https callback for every platform. In the Android app this same URL
      // comes back through a Custom Tab, which returns it to the app on its own
      // (see the native OAuthTabWebViewClient); the web code does nothing
      // special. `redirectUrl` must stay a real https URL — Clerk rejects a
      // custom scheme, and the App Links filter claims exactly this path.
      redirectUrl: window.location.origin + CALLBACK_PATH,
      redirectUrlComplete: window.location.origin + routes.home,
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
 * Google sign-in, step 2 of 2 — run on CALLBACK_PATH and nowhere else.
 *
 * This is what turns a returning OAuth redirect into an actual session, and
 * its absence was the original bug: authenticateWithRedirect() started a flow
 * that nothing ever finished, so the browser came back with a sign-in attempt
 * in progress, no session, and a login page that offered to start the whole
 * thing again.
 *
 * Clerk navigates away itself when it is done, so this does not return in the
 * success case. The destinations matter:
 *
 *  - existing user  -> redirectUrlComplete from step 1 ('/#/home')
 *  - brand-new user -> the sign-in is transferred to a sign-up automatically
 *                      (transferable defaults to true), and with Google
 *                      supplying every required attribute that sign-up
 *                      completes in the same round trip and lands on '/#/home'
 *                      too. Nothing is collected in between.
 *
 * The remaining URLs are stops this app does not use but Clerk may still route
 * to — an instance reconfigured to require a phone or a second factor, say.
 * They all point at the login view because that is the only auth UI mounted
 * here; left unset they default to Clerk's own hosted component routes, which
 * do not exist in this app and would dead-end.
 */
export async function completeRedirectCallback() {
  const c = await ensureClerk();
  return c.handleRedirectCallback({
    continueSignUpUrl: routes.signIn,
    signInFallbackRedirectUrl: routes.home,
    signUpFallbackRedirectUrl: routes.home,
    signInUrl: routes.signIn,
    signUpUrl: routes.signIn,
    firstFactorUrl: routes.signIn,
    secondFactorUrl: routes.signIn,
    resetPasswordUrl: routes.signIn,
    verifyPhoneNumberUrl: routes.signIn,
    verifyEmailAddressUrl: routes.signIn,
  });
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

/**
 * Resolves once clerk-js has loaded and restored whatever session exists.
 *
 * currentUser() is synchronous and reports null until that finishes, so any
 * "are they signed in?" check that does not await this first answers "no" for
 * everybody on a cold page load — and, on the login view, offers a signed-in
 * user the sign-in button.
 */
export async function awaitClerk() {
  await ensureClerk();
}
