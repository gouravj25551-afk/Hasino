/**
 * index.html's shell.
 *
 * External rather than inline because the CSP is `script-src 'self'`
 * with no 'unsafe-inline' — an inline module script is blocked outright,
 * which renders the page blank. Keeping the strict policy and moving the
 * code out is the right trade; the alternative weakens CSP for every page
 * to save one file.
 */
import { register, start, go, replace, reload, currentHash, activeSection } from './lib/router.js';
import { api } from './lib/api.js';
import {
  watchAuthState,
  isRedirectCallback,
  completeRedirectCallback,
  signOut,
  isNativeApp,
  callbackWantsNativeApp,
  nativeCallbackUrl,
  nativeCallbackIntentUrl,
} from './lib/auth.js';
import { TopBar, highlightTopBarNav } from './components/TopBar.js';
import { LocationSheet } from './components/LocationSheet.js';
import { getLocation } from './lib/location.js';
import { BottomNav } from './components/BottomNav.js';
import { installBackHandler } from './lib/backbutton.js';
import { initTheme } from './lib/theme.js';
import { el } from './lib/dom.js';
import { forgetFavorites, loadFavorites } from './lib/favorites.js';

import { renderHome } from './views/home.js';
import { renderExplore } from './views/explore.js';
import { renderSalon, releaseCartBarSpace } from './views/salon.js';
import { renderCheckout } from './views/checkout.js';
import { renderBookings } from './views/bookings.js';
import { renderSaved } from './views/saved.js';
import { renderProfile } from './views/profile.js';
import { renderLogin } from './views/login.js';
import { renderApply } from './views/apply.js';
import { renderTerms, renderPrivacy } from './views/legal.js';

// Before anything renders: the stored theme, or the device's. Any later and
// the first paint is the wrong colour and then corrects itself, which on a
// phone reads as the app flashing white every time it opens.
initTheme();

const viewRoot = document.getElementById('view');
const topbarRoot = document.getElementById('topbar');
const bottomNavRoot = document.getElementById('bottomNav');

/**
 * The launch splash (index.html) hand-off.
 *
 * revealApp() fades the splash out once the first screen's shell is in the DOM
 * — never on a timer, so a fast boot reveals fast and a slow one stays covered
 * exactly as long as it genuinely needs. splashError() is the escape hatch: if
 * boot throws before it can reveal, the splash shows a retry rather than
 * hanging. Both clear the inline watchdog and are safe to call more than once.
 */
let splashDone = false;
function stopSplashWatchdog() {
  if (window.__hasinoSplashWatchdog) {
    clearTimeout(window.__hasinoSplashWatchdog);
    window.__hasinoSplashWatchdog = null;
  }
}
function revealApp() {
  if (splashDone) return;
  splashDone = true;
  stopSplashWatchdog();
  const splash = document.getElementById('splash');
  if (!splash) return;
  splash.classList.add('is-hiding');
  const remove = () => splash.remove();
  splash.addEventListener('transitionend', remove, { once: true });
  // Belt and suspenders: if the transition never fires (reduced motion,
  // background tab), take it off the page anyway so it can never trap input.
  setTimeout(remove, 400);
}
function splashError() {
  if (splashDone) return;
  stopSplashWatchdog();
  const splash = document.getElementById('splash');
  if (splash) splash.classList.add('has-error');
}

/** Shared app state + the handful of things every view needs from the shell. */
const app = {
  session: null,       // GET /api/me response, or null when signed out
  config: null,        // GET /api/config — tells the UI whether payments exist
  // The customer's chosen place, from localStorage. Read once at boot so
  // every view sees the same value; the sheet updates it in place.
  location: getLocation(),
  navigate: go,
  refreshSession,
  requireSession,
  afterSignIn,
  signIn: goToSignIn,
  signOut: doSignOut,
};

/**
 * Throws on failure so callers that need to tell "signed in" from "not" can.
 * Callers that just want a best-effort refresh catch it themselves.
 */
async function refreshSession() {
  const session = await api('/api/me');
  app.session = session;
  renderChrome();
  return session;
}

/**
 * Resolves once the first answer about who is signed in has landed.
 *
 * lib/auth.js calls its handler with the restored user and returns; it does
 * not wait for the handler to finish, and the handler is what fetches
 * /api/me. So without this the very first route rendered while `app.session`
 * was still null — and a route that needs a session (profile, bookings,
 * checkout, the application form) would bounce to the login page, which then
 * noticed the session had arrived and bounced back. Two redirects for a
 * signed-in person opening their own bookmark, and the destination could be
 * lost between them: both the bounce and the login page read the remembered
 * route, and whichever ran second found it already spent and fell back to
 * home.
 *
 * Racing it against a timeout rather than waiting outright: browsing is
 * public and must not be held hostage to a slow or unreachable identity
 * provider. If the answer has not come by then the app renders signed-out,
 * exactly as it did before, and corrects itself when the session lands.
 */
const AUTH_SETTLE_TIMEOUT_MS = 4000;
let markAuthSettled;
const authSettled = new Promise((resolve) => { markAuthSettled = resolve; });

/**
 * Where a visitor was going when they were asked to sign in.
 *
 * sessionStorage rather than the URL: the sign-in leaves for Google and comes
 * back on a different document, and the hash router matches its routes
 * exactly — a `?next=` on '#/login' would match no route at all and bounce to
 * '#/home'. Cleared as soon as it is used, so yesterday's interrupted trip to
 * checkout does not hijack tomorrow's sign-in.
 */
const RETURN_TO = 'returnTo';

function rememberReturnTo(hash) {
  // '#/login' is not a destination, and neither is a route that only exists
  // to bounce. Anything else is where the person was actually headed.
  if (!hash || hash === '#/login' || !hash.startsWith('#/')) return;
  sessionStorage.setItem(RETURN_TO, hash);
}

function takeReturnTo() {
  const hash = sessionStorage.getItem(RETURN_TO);
  sessionStorage.removeItem(RETURN_TO);
  return hash && hash !== '#/login' ? hash : null;
}

/**
 * Views call this when a route needs a signed-in user.
 *
 * Two things beyond "go to login". The route that bounced them is *replaced*
 * rather than pushed past, because it is not a place they can come back to
 * while signed out — leaving it in history is what made Back from the login
 * page land on it and be bounced straight forward again. And where they were
 * going is remembered, so signing in finishes the trip instead of dropping
 * them on the home page.
 */
function requireSession() {
  if (!app.session) {
    rememberReturnTo(currentHash());
    replace('#/login');
    return null;
  }
  return app.session;
}

/**
 * Send someone to sign in from a page they chose to be on — the Sign in
 * button, or a heart tapped by a signed-out visitor.
 *
 * Pushed rather than replaced, because the page behind it is a real place to
 * come back to; what makes that safe is that the login page replaces *itself*
 * on the way out. Where they were is remembered, so a save that needed an
 * account finishes on the salon they were looking at.
 */
function goToSignIn() {
  rememberReturnTo(currentHash());
  go('#/login');
}

async function doSignOut() {
  await signOut();
  app.session = null;
  // The next account's saved salons are not this one's.
  forgetFavorites();
  sessionStorage.removeItem(RETURN_TO);
  renderChrome();
  // Replaced, not pushed: the page they signed out of is usually one that
  // needs a session, and leaving it behind means Back bounces them to login.
  replace('#/home');
}

/**
 * Where a just-signed-in person goes, decided by who the server says they are.
 *
 * An owner lands in their panel, not on the customer home with a link to it.
 * Two screens after a sign-in — a home page, then a profile page, then the
 * dashboard — reads as being asked to choose a role, and the role was never
 * theirs to choose: it is `role` on GET /api/me, derived server-side from the
 * identity Google verified.
 *
 * The intent from the login buttons still decides where a *customer* lands,
 * and is read once and cleared: the choice belongs to that sign-in, and a
 * stale 'salon' would send them to the application form every time. An owner
 * ignores it entirely — asking someone who already has a salon to apply again
 * would only 409.
 *
 * Returns a hash route or a real path; navigateTo() handles both. '/business'
 * is a separate document (business.html), so it cannot be a hash route.
 */
/**
 * The panel this account belongs in, or null for a customer.
 *
 * Decided by `role` on GET /api/me, which the server derives from the
 * owner_id relationship on the salon and from ADMIN_EMAILS — never from
 * anything the client can read off an email string. A tampered client can
 * change what it *shows*; it cannot change what /api/business/* will answer,
 * because those routes resolve the salon from the authenticated owner.
 */
function panelForRole() {
  if (app.session?.role === 'business') return '/business';
  // The admin panel is a separate deployment on its own origin, so this is a
  // whole URL rather than a path, and it is only ever the one the server was
  // configured with (ADMIN_PANEL_URL) — never anything derived from the
  // session. Unset, an admin stays here and uses the app like anyone else;
  // there is nothing to redirect to and inventing a URL would be a guess.
  //
  // The panel has its own Clerk sign-in on its own origin: a session here does
  // not carry over, which is the separation working rather than a fault. For
  // the Android app to follow this without handing the user to Chrome, the
  // admin host must also be in the Capacitor allowNavigation list — see
  // capacitor.config.ts.
  if (app.session?.role === 'admin' && app.config?.adminPanelUrl) {
    return app.config.adminPanelUrl;
  }
  return null;
}

function afterSignInDestination() {
  const intent = sessionStorage.getItem('postSignIn');
  sessionStorage.removeItem('postSignIn');
  const returnTo = takeReturnTo();
  // An owner's panel wins over everything: it is not a preference, it is
  // where /api/me says this account belongs. Then the page the visitor was
  // trying to reach when they were asked to sign in, then the intent from the
  // two sign-in buttons.
  return panelForRole() ?? returnTo ?? (intent === 'salon' ? '#/apply' : '#/home');
}

/**
 * The routes that mean "the app just opened", as opposed to a place the person
 * chose to be. Only these are redirected away from on launch.
 */
const LANDING_ROUTES = new Set(['', '#/', '#/home']);
let openRouted = false;

/**
 * Send an owner to their panel when the app opens with a session already
 * restored — not only on the sign-in that created it.
 *
 * Sign-in happens once; opening the app happens every day. Routing only at
 * sign-in meant a salon owner who closed the app and came back landed on the
 * customer home and had to find their way to the dashboard again, which is the
 * "customer panel first" this exists to remove. Clerk restores its session
 * asynchronously, so this runs when the session resolves rather than at boot,
 * when the answer would still be "signed out" for everybody.
 *
 * Once per load, and only from a landing route. An owner who opened a specific
 * page — a salon someone shared, their own bookings — asked for that page, and
 * bouncing them to the dashboard would break every link into the app. A
 * customer has no panel and is never moved.
 */
function routeOnOpen() {
  if (openRouted) return;
  openRouted = true;
  const panel = panelForRole();
  if (panel && LANDING_ROUTES.has(currentHash())) navigateTo(panel, { swap: true });
}

/**
 * Hash routes stay in the router; anything else is a document load.
 *
 * `swap` replaces the current history entry instead of stacking one on top —
 * used when leaving the login page, which nobody should be able to press Back
 * into once they are signed in.
 */
function navigateTo(dest, { swap = false } = {}) {
  if (dest.startsWith('#')) swap ? replace(dest) : go(dest);
  else if (swap) window.location.replace(dest);
  else window.location.assign(dest);
}

/**
 * Send a signed-in person where they belong. Called on the sign-in that just
 * completed, and by the login view when someone already signed in opens it.
 *
 * `fromFreshSignIn` marks the browser OAuth return. Clerk finishes OAuth by
 * navigating to redirectUrlComplete ('#/home'), so a browser sign-in lands the
 * app on '#/home' rather than '#/login' — but that '#/home' is a transient the
 * flow dropped us on, not a place the person chose, so it must be replaced for
 * the same reason the login page is: Back must not return to it.
 */
function afterSignIn({ fromFreshSignIn = false } = {}) {
  // Leaving the login page replaces it. Pushing over it left a signed-in
  // person one Back press away from a sign-in screen that would immediately
  // send them forward again, which is the loop the customer sees as "the back
  // button does nothing". The post-OAuth '#/home' is the same kind of transient.
  navigateTo(afterSignInDestination(), {
    swap: fromFreshSignIn || currentHash() === '#/login',
  });
}

function renderChrome() {
  topbarRoot.innerHTML = '';
  const bar = TopBar({
    user: app.session,
    locationLabel: app.location?.label,
    onLocationClick: () =>
      LocationSheet({
        onPick: (loc) => {
          app.location = loc;
          renderChrome();
          // The list on screen belongs to the old city — discovery is
          // filtered to the customer's current city, not merely sorted by
          // distance from it — so every card on it is now wrong rather than
          // stale. Re-running the route refetches with the new city, which is
          // what makes switching Jind -> Sonipat swap the list immediately.
          reload();
        },
      }),
    onSignIn: goToSignIn,
    onSignOut: doSignOut,
  });
  topbarRoot.append(bar);
  highlightTopBarNav(bar, activeSection());
  measureHeader(bar);

  bottomNavRoot.innerHTML = '';
  bottomNavRoot.append(BottomNav(activeSection()));
}

/**
 * Publish the header's real height, so anything that sticks under it knows
 * where "under it" is — the salon page's category menu, today.
 *
 * Measured rather than assumed: the bar wraps at a narrow width, and it grows
 * by the status-bar inset on Android, which resolves after the first paint.
 */
let headerObserver = null;

function measureHeader(bar) {
  headerObserver?.disconnect();
  headerObserver = null;
  const write = () => {
    document.documentElement.style.setProperty('--app-header-height', `${bar.offsetHeight}px`);
  };
  write();
  if (typeof ResizeObserver === 'function') {
    headerObserver = new ResizeObserver(write);
    headerObserver.observe(bar);
  }
}

function showRouteError(err) {
  viewRoot.innerHTML = '';
  const box = el('div', 'out bad', `${err.status ?? ''} ${err.code ?? err.body?.code ?? ''}\n${err.message}`);
  viewRoot.append(box);
}

/**
 * The salon page reserves room at the bottom of the page for its cart bar.
 * Every other route has no such bar, so the reservation is released on the way
 * in — otherwise leaving the booking screen with services in the cart leaves a
 * band of empty space at the bottom of home, explore and everything else.
 */
for (const [pattern, handler] of [
  [/^#\/home$/, () => renderHome(viewRoot, app)],
  [/^#\/explore$/, () => renderExplore(viewRoot, app)],
  [/^#\/checkout\/([\w-]+)$/, (id) => renderCheckout(viewRoot, app, id)],
  [/^#\/bookings$/, () => renderBookings(viewRoot, app)],
  [/^#\/saved$/, () => renderSaved(viewRoot, app)],
  [/^#\/profile$/, () => renderProfile(viewRoot, app)],
  [/^#\/login$/, () => renderLogin(viewRoot, app)],
  [/^#\/terms$/, () => renderTerms(viewRoot, app)],
  [/^#\/privacy$/, () => renderPrivacy(viewRoot, app)],
  [/^#\/apply$/, () => renderApply(viewRoot, app)],
]) {
  register(pattern, (...args) => {
    releaseCartBarSpace();
    return handler(...args);
  });
}

// The one route that draws a cart bar, so it keeps its own reservation.
register(/^#\/salon\/([\w-]+)$/, (id) => renderSalon(viewRoot, app, id));

/**
 * Android's back button. Installed at module scope, before boot() awaits
 * anything: a press while the app is still fetching its config should be the
 * app going back, not the app quitting.
 *
 * The customer app's root is home — the landing routes are exactly the ones
 * routeOnOpen() treats as "the app just opened", and they are where there is
 * nothing left to go back to.
 */
installBackHandler({
  isRoot: () => LANDING_ROUTES.has(currentHash()),
  homeHash: '#/home',
});

/**
 * Give the callback back to the Android app, and never leave the person
 * looking at a blank page if that does not take.
 *
 * The navigation is attempted immediately, because the good case should feel
 * like the browser blinked. But it can fail in ways this page cannot detect —
 * a dialog the user dismisses, a browser that refuses an unprompted scheme
 * navigation — and the failure is silent: the page simply stays. So the page
 * is also *rendered* first, with a button that runs the same navigation from a
 * real tap, which browsers treat far more permissively than a scripted one.
 *
 * Signing in again here would be the wrong answer. This browser can complete
 * the handshake perfectly well; the session would just be in the wrong place.
 */
function handOffToNativeApp() {
  const intentUrl = nativeCallbackIntentUrl();
  const schemeUrl = nativeCallbackUrl();

  viewRoot.innerHTML = '';
  const card = el('div', 'panel');
  card.style.cssText = 'max-width:440px; margin:48px auto; padding:36px 28px; text-align:center';
  card.append(el('h1', null, 'Signed in'));
  card.append(el('p', 'sub', 'Returning you to the Hasino app…'));

  // The intent: form first — it is the one Chrome on Android is built to
  // honour. The scheme link below it is for the browsers that are not Chrome.
  const back = el('a', 'btn primary', 'Open the Hasino app');
  back.href = intentUrl;
  back.style.marginTop = '20px';
  card.append(back);

  const alt = el('a', 'btn sm', 'Open with hasino://');
  alt.href = schemeUrl;
  alt.style.cssText = 'margin-top:10px; display:inline-block';
  card.append(alt);

  card.append(
    Object.assign(
      el('div', 'note',
        'If nothing happens, tap the button above. You are signed in — this last step just '
        + 'moves you back to the app, because the app and the browser keep separate sessions.'),
      { style: 'margin-top:20px; text-align:left' },
    ),
  );

  // The way out for someone who has no Hasino app on this device: an Android
  // browser is only a hint that the app might be there, so this page must not
  // be a dead end for a person who signed in on the web. It finishes the
  // handshake here instead, which is what would have happened anyway.
  const stay = el('button', 'btn sm');
  stay.type = 'button';
  stay.textContent = 'Continue in this browser instead';
  stay.style.marginTop = '14px';
  stay.onclick = async () => {
    stay.disabled = true;
    try {
      await completeRedirectCallback();
    } catch (err) {
      console.error('sign-in could not be completed', err);
      sessionStorage.setItem('ssoError', err?.message ?? 'Sign-in could not be completed');
      location.replace('/#/login');
    }
  };
  card.append(stay);

  viewRoot.append(card);

  // location.replace, not assign: the callback URL must not sit in history
  // where Back would replay a consumed one-time code.
  window.location.replace(intentUrl);
}

async function boot() {
  // Fetched before the first route so no view has to guess whether there is a
  // payment step. Public endpoint; failure is not fatal to browsing.
  app.config = await fetch('/api/config').then((r) => r.json()).catch(() => null);

  // Coming back from Google. Finish the OAuth handshake before anything else
  // runs: this page is not a route, it carries Clerk's callback parameters in
  // its query string, and Clerk navigates on to the real destination itself.
  // Booting the router here instead would leave the sign-in half-finished,
  // which is the loop this replaced.
  if (isRedirectCallback()) {
    // This callback belongs to a sign-in that started in the Android app, and
    // it is being read by a browser instead. That is the stranded case: Chrome
    // would finish the handshake in its own cookie jar, and the app the user
    // started from would still be showing a sign-in button, because a WebView
    // shares no storage with the browser.
    //
    // App Links normally stop us ever getting here — Android hands the URL
    // straight to the app. This is what happens when that verification did not
    // hold: no network at install time, a sideloaded build, a device that
    // never rechecked. Handing the callback on by scheme needs no
    // verification and cannot fail that way.
    // Gate the hand-off on the precise signal ONLY: `?native=1`, set when the
    // sign-in started in the app. `isAndroidBrowser()` used to stand in as a
    // second signal, but it matches *every* Android phone on the mobile web —
    // the app tags its own WebView with `HasinoApp/` (capacitor.config.ts), so
    // an Android UA without that tag is an ordinary web visitor, not a stranded
    // app user. Treating them as stranded auto-redirected them to `intent://`
    // and never completed their web sign-in: they landed on a "Signed in" page
    // that could not open any app and were never actually authenticated — the
    // exact "signed in but not really, and no redirect" the mobile users saw.
    //
    // The residual risk this trades for is narrow: an app-started sign-in whose
    // `?native=1` was dropped in transit AND whose App Links failed, landing in
    // an external browser. That double failure is rare; breaking sign-in for
    // all Android web users is not. When it does happen the browser simply
    // finishes the sign-in on the web, which is a working session rather than a
    // dead end.
    if (!isNativeApp() && callbackWantsNativeApp()) {
      return handOffToNativeApp();
    }

    try {
      await completeRedirectCallback();
      return; // navigating away
    } catch (err) {
      console.error('sign-in could not be completed', err);
      // Land on the login view rather than a blank callback page. The reason
      // rides in sessionStorage because it cannot ride in the hash — the
      // router matches /^#\/login$/ exactly and a query string there would
      // miss every route and bounce to #/home.
      sessionStorage.setItem('ssoError', err?.message ?? 'Sign-in could not be completed');
      location.replace('/#/login');
      return;
    }
  }

  {
    // Browsing is public even if Clerk was never configured on this deploy —
    // only sign-in itself should fail, visibly, when attempted.
    //
    // Deliberately NOT awaited. watchAuthState() loads clerk-js (1.5MB, from a
    // third-party CDN) before it resolves, and awaiting it here would block the
    // first render on that download — so on a device or network where the CDN
    // is slow, blocked, or unparseable the whole app hangs on the splash, not
    // just sign-in. That is the opposite of "browsing survives a slow provider".
    // The Promise.race below is what bounds the wait: the handler calls
    // markAuthSettled() the moment it has an answer, and if that never comes the
    // race renders signed-out and the listener corrects it whenever Clerk lands.
    watchAuthState(async (fbUser) => {
      if (!fbUser) {
        app.session = null;
        markAuthSettled();
        // Signing out ends this launch as far as routing is concerned.
        // Without the reset, an owner who signed out and straight back in on
        // the same page would be left on the customer home, because
        // routeOnOpen had already spent its one shot.
        openRouted = false;
        renderChrome();
        return;
      }
      try {
        await refreshSession();
        markAuthSettled();
        // The saved list, now that there is somebody to have saved things.
        // Clerk restores asynchronously, so a screen full of salon cards is
        // usually already drawn by this point — lib/favorites.js tells each
        // heart on it what it should be, rather than leaving them all
        // outlines until the next navigation.
        loadFavorites({ signedIn: true, force: true }).catch(() => {});
        // A sign-in the person just completed and the app merely re-opening
        // with a session already restored route differently — the first honours
        // where they were headed (returnTo) and why they signed in (the salon
        // intent); the second only sends an owner to their panel and must never
        // move a customer off a page they deep-linked to.
        //
        // The hash alone cannot tell these apart. In the browser, Clerk ends
        // OAuth by navigating to redirectUrlComplete ('#/home'), so a fresh
        // sign-in lands on '#/home', not '#/login'. Gating the destination on
        // '#/login' therefore fired it for NO browser sign-in: every one landed
        // on '#/home' and had its returnTo and salon intent dropped.
        //
        // `postSignIn` is the signal that survives the round trip. It is set
        // only by the sign-in buttons — the single signInWithGoogle() call site
        // — so its presence when a session lands means a user-initiated sign-in
        // just completed. afterSignInDestination() consumes it. The login view
        // is still handled directly for the already-signed-in case, where the
        // session restores while that page is showing and there is no intent.
        const fromFreshSignIn = sessionStorage.getItem('postSignIn') !== null;
        if (fromFreshSignIn || currentHash() === '#/login') afterSignIn({ fromFreshSignIn });
        // Every other way in: the app was opened with a session already
        // restored. An owner belongs in their panel then too, not only on
        // the sign-in that created the session.
        else routeOnOpen();
      } catch {
        // A Clerk session whose token the server will not accept — revoked,
        // expired, or issued by a different instance. Browsing stays public,
        // so this drops to signed-out rather than interrupting the page.
        app.session = null;
        markAuthSettled();
        renderChrome();
      }
    }).catch((err) => {
      console.error('Clerk did not initialize — sign-in is unavailable', err);
      app.session = null;
      markAuthSettled();
    });
  }

  // Who is signed in, before the first route decides whether to let them in.
  // Bounded, so an identity provider that never answers costs a moment rather
  // than the whole app.
  await Promise.race([
    authSettled,
    new Promise((resolve) => setTimeout(resolve, AUTH_SETTLE_TIMEOUT_MS)),
  ]);

  renderChrome();
  // start() renders the first route synchronously up to its first await — the
  // topbar, the view's skeletons and the bottom nav are all in the DOM by the
  // time it returns its promise. Reveal on the next frame, once that shell has
  // painted behind the splash, then let the route's own data finish loading
  // under it. This is the whole point: the splash covers real initialisation
  // time and not a millisecond more.
  const firstRoute = start((err) => {
    console.error('route error', err);
    showRouteError(err);
  });
  // Reveal on the next frame in the ordinary case, so the shell has painted
  // behind the splash first. But requestAnimationFrame is PAUSED while the
  // document is hidden — a cold load in a background tab, a prerender, or a PWA
  // that launches before it is visible would never get that frame, and the
  // splash would sit until the 12s watchdog turned it into "didn't finish
  // loading" over a fully-loaded app. setTimeout still fires when hidden, so it
  // is the backstop; revealApp() is idempotent, so whichever runs first wins.
  requestAnimationFrame(revealApp);
  setTimeout(revealApp, 300);
  await firstRoute;
  window.addEventListener('hashchange', renderChrome);
}

// A boot that rejects (rather than handling its own error) must not leave the
// splash up forever — surface the retry instead.
boot().catch((err) => {
  console.error('Hasino failed to start', err);
  splashError();
});
