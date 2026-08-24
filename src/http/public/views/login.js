import { el } from '../lib/dom.js';
import { awaitClerk, currentUser, signInWithGoogle } from '../lib/auth.js';
import { replace } from '../lib/router.js';

function card(...children) {
  const box = el('div', 'panel');
  box.style.maxWidth = '440px';
  box.style.margin = '48px auto';
  box.style.padding = '36px 28px';
  box.style.textAlign = 'center';
  box.style.borderRadius = 'var(--radius-lg)';
  box.append(...children);
  return box;
}

function logo() {
  const wrap = el('div');
  wrap.innerHTML =
    '<a class="lockup" href="#/home" style="font-size:26px; padding:10px 20px;">' +
    '<span class="wordmark">has<span class="i">i</span>no</span></a>';
  return wrap;
}

const GOOGLE_G = `
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
    <path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
  </svg>`;

/**
 * Sign-in is one step and one button.
 *
 * Google supplies the whole identity, so a first sign-in creates the account
 * outright — there is nothing further to collect. The only branch left is
 * whether the visitor is already signed in, and someone who is must never be
 * shown a sign-in page: that was the shape of the original loop.
 *
 * awaitClerk() before reading currentUser() is what makes that check
 * meaningful. Clerk restores its session asynchronously, and reading the user
 * before the restore finishes reports "signed out" for everybody.
 */
export async function renderLogin(container, app) {
  container.innerHTML = '';

  const ssoError = sessionStorage.getItem('ssoError');
  sessionStorage.removeItem('ssoError');

  if (await awaitClerk().then(() => currentUser()).catch(() => null)) {
    try {
      await app.refreshSession();
      // Not '#/home': the session that just came back says whether this is a
      // salon owner, and an owner belongs in their panel. Same decision as a
      // fresh sign-in, made in one place.
      app.afterSignIn();
      return;
    } catch {
      // A rejected or expired token genuinely does mean "sign in again",
      // so fall through to the button.
    }
  }

  renderGoogleStep(container, app, ssoError);
}

function renderGoogleStep(container, app, ssoError) {
  container.innerHTML = '';

  /**
   * The way out of a sign-in nobody has to complete.
   *
   * Back is the gesture people reach for, and this is the same movement: one
   * step back through this document's own history, or home when the app was
   * opened straight onto this page and there is nothing behind it. The login
   * page never leaves itself in history once a sign-in succeeds — see
   * afterSignIn() in app.js — so pressing this cannot land on a screen that
   * bounces straight back here.
   */
  const back = el('button', 'btn sm login-back');
  back.type = 'button';
  back.textContent = '← Back';
  back.onclick = () => {
    // One step back through this document's own history when there is one.
    // With nothing behind it — the app opened straight onto this page — home
    // *replaces* the login entry rather than stacking on top of it, so the
    // next Back press does not come straight back here.
    if (window.history.length > 1) window.history.back();
    else replace('#/home');
  };
  container.append(back);

  const status = el('div', 'note');
  status.style.marginTop = '18px';
  status.style.display = ssoError ? 'block' : 'none';
  if (ssoError) status.textContent = ssoError;

  /**
   * Both buttons run the same Google sign-in, because with OAuth there is no
   * separate "sign up" — the first sign-in creates the account. What differs
   * is only where the person lands afterwards, so the choice is remembered as
   * an intent and read once on the way back.
   *
   * sessionStorage rather than the URL: the OAuth round trip rewrites the
   * whole location, and the hash router matches /^#\/login$/ exactly, so a
   * query parameter would miss every route and bounce to #/home.
   */
  const start = async (button, intent) => {
    sessionStorage.setItem('postSignIn', intent);
    for (const b of [customerBtn, salonBtn]) b.disabled = true;
    status.style.display = 'block';
    status.textContent = 'Redirecting to Google…';
    try {
      await signInWithGoogle();
    } catch (err) {
      sessionStorage.removeItem('postSignIn');
      status.textContent = err.message || 'Sign-in failed. Please try again.';
      for (const b of [customerBtn, salonBtn]) b.disabled = false;
    }
  };

  const bigBtn = (cls, label) => {
    const b = el('button', cls);
    b.type = 'button';
    b.style.cssText =
      'width:100%; padding:12px 20px; font-size:15px; border-radius:12px; '
      + 'display:flex; align-items:center; justify-content:center; gap:12px;';
    b.innerHTML = `${GOOGLE_G}<span>${label}</span>`;
    return b;
  };

  const customerBtn = bigBtn('btn primary', 'Sign up as Customer');
  // "Apply", not "List" — a salon is not listed by signing up. The button
  // opens an application that a Hasino admin reviews.
  const salonBtn = bigBtn('btn', 'Apply as a Salon');
  salonBtn.style.marginTop = '12px';

  customerBtn.onclick = () => start(customerBtn, 'customer');
  salonBtn.onclick = () => start(salonBtn, 'salon');

  container.append(
    card(
      logo(),
      el('h1', null, 'Welcome to Hasino'),
      Object.assign(el('p', 'sub', 'Book top salons & barbers near you — or list your own.'), {
        style: 'margin-bottom:28px',
      }),
      customerBtn,
      salonBtn,
      status,
      Object.assign(
        el('div', 'note',
          '🔒 Both use the same Google sign-in. Applying as a salon opens an application — '
          + 'a Hasino admin reviews it before your salon goes live.'),
        { style: 'margin-top:24px; text-align:left' },
      ),
    ),
  );
}
