/**
 * index.html's shell.
 *
 * External rather than inline because the CSP is `script-src 'self'`
 * with no 'unsafe-inline' — an inline module script is blocked outright,
 * which renders the page blank. Keeping the strict policy and moving the
 * code out is the right trade; the alternative weakens CSP for every page
 * to save one file.
 */
import { register, start, go, currentHash, activeSection } from './lib/router.js';
import { api } from './lib/api.js';
import { watchAuthState, isRedirectCallback, completeRedirectCallback, signOut } from './lib/auth.js';
import { TopBar, highlightTopBarNav } from './components/TopBar.js';
import { BottomNav } from './components/BottomNav.js';
import { el } from './lib/dom.js';

import { renderHome } from './views/home.js';
import { renderExplore } from './views/explore.js';
import { renderSalon } from './views/salon.js';
import { renderCheckout } from './views/checkout.js';
import { renderBookings } from './views/bookings.js';
import { renderProfile } from './views/profile.js';
import { renderLogin } from './views/login.js';
import { renderApply } from './views/apply.js';

const viewRoot = document.getElementById('view');
const topbarRoot = document.getElementById('topbar');
const bottomNavRoot = document.getElementById('bottomNav');

/** Shared app state + the handful of things every view needs from the shell. */
const app = {
  session: null,       // GET /api/me response, or null when signed out
  config: null,        // GET /api/config — tells the UI whether payments exist
  navigate: go,
  refreshSession,
  requireSession,
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

/** Views call this when a route needs a signed-in user. Redirects to login if there isn't one. */
function requireSession() {
  if (!app.session) {
    go('#/login');
    return null;
  }
  return app.session;
}

async function doSignOut() {
  await signOut();
  app.session = null;
  renderChrome();
  go('#/home');
}

/**
 * Where a just-signed-in person goes, honouring the button they picked before
 * they left for Google.
 *
 * Read once and cleared: the choice belongs to that sign-in, and a stale
 * 'salon' would send them to the application form every time they signed in.
 * Anyone who already owns a salon goes to their panel instead — asking them to
 * apply again would only 409.
 */
function afterSignInDestination() {
  const intent = sessionStorage.getItem('postSignIn');
  sessionStorage.removeItem('postSignIn');
  if (app.session?.role === 'business') return '#/home';
  return intent === 'salon' ? '#/apply' : '#/home';
}

function renderChrome() {
  topbarRoot.innerHTML = '';
  const bar = TopBar({
    user: app.session,
    onSignIn: () => go('#/login'),
  });
  topbarRoot.append(bar);
  highlightTopBarNav(bar, activeSection());

  bottomNavRoot.innerHTML = '';
  bottomNavRoot.append(BottomNav(activeSection()));
}

function showRouteError(err) {
  viewRoot.innerHTML = '';
  const box = el('div', 'out bad', `${err.status ?? ''} ${err.code ?? err.body?.code ?? ''}\n${err.message}`);
  viewRoot.append(box);
}

register(/^#\/home$/, () => renderHome(viewRoot, app));
register(/^#\/explore$/, () => renderExplore(viewRoot, app));
register(/^#\/salon\/([\w-]+)$/, (id) => renderSalon(viewRoot, app, id));
register(/^#\/checkout\/([\w-]+)$/, (id) => renderCheckout(viewRoot, app, id));
register(/^#\/bookings$/, () => renderBookings(viewRoot, app));
register(/^#\/profile$/, () => renderProfile(viewRoot, app));
register(/^#\/login$/, () => renderLogin(viewRoot, app));
register(/^#\/apply$/, () => renderApply(viewRoot, app));

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
    try {
      await watchAuthState(async (fbUser) => {
        if (!fbUser) {
          app.session = null;
          renderChrome();
          return;
        }
        try {
          await refreshSession();
          // The session can land after the login view has already painted —
          // Clerk restores asynchronously. Leaving the user on a sign-in page
          // they no longer need is the same dead end as the original loop,
          // just one step later.
          if (currentHash() === '#/login') go(afterSignInDestination());
        } catch {
          // A Clerk session whose token the server will not accept — revoked,
          // expired, or issued by a different instance. Browsing stays public,
          // so this drops to signed-out rather than interrupting the page.
          app.session = null;
          renderChrome();
        }
      });
    } catch (err) {
      console.error('Clerk did not initialize — sign-in is unavailable', err);
      app.session = null;
    }
  }

  renderChrome();
  await start((err) => {
    console.error('route error', err);
    showRouteError(err);
  });
  window.addEventListener('hashchange', renderChrome);
}

boot();
