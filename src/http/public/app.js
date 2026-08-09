/**
 * index.html's shell.
 *
 * External rather than inline because the CSP is `script-src 'self'`
 * with no 'unsafe-inline' — an inline module script is blocked outright,
 * which renders the page blank. Keeping the strict policy and moving the
 * code out is the right trade; the alternative weakens CSP for every page
 * to save one file.
 */
import { register, start, go, activeSection } from './lib/router.js';
import { api, ApiError } from './lib/api.js';
import { watchAuthState, consumeRedirectResult, signOut } from './lib/auth.js';
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
 * Throws on failure (including 428 PHONE_REQUIRED) so callers that need to
 * distinguish "not signed in" from "needs a phone" can. Callers that just
 * want a best-effort refresh catch it themselves.
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

  {
    // Browsing is public even if Clerk was never configured on this deploy —
    // only sign-in itself should fail, visibly, when attempted.
    try {
      await consumeRedirectResult().catch(() => {});
      await watchAuthState(async (fbUser) => {
        if (!fbUser) {
          app.session = null;
          renderChrome();
          return;
        }
        try {
          await refreshSession();
        } catch (err) {
          app.session = null;
          renderChrome();
          // A persisted Google sign-in that never finished the phone-link step.
          if (err instanceof ApiError && err.status === 428) go('#/login');
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
