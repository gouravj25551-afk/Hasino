import { el } from '../lib/dom.js';
import { awaitClerk, currentUser, signInWithGoogle } from '../lib/auth.js';

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
      app.navigate('#/home');
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

  const status = el('div', 'note');
  status.style.marginTop = '18px';
  status.style.display = ssoError ? 'block' : 'none';
  if (ssoError) status.textContent = ssoError;

  const googleBtn = el('button', 'btn primary');
  googleBtn.type = 'button';
  googleBtn.style.cssText = 'width:100%; padding:12px 20px; font-size:15px; border-radius:12px; display:flex; align-items:center; justify-content:center; gap:12px;';
  googleBtn.innerHTML = `${GOOGLE_G}<span>Continue with Google</span>`;

  // Clerk's OAuth is a full-page redirect, so the only outcomes here are
  // "the browser is leaving" and "it could not even start". What happens on
  // the way back is decided at /sso-callback, not here.
  googleBtn.onclick = async () => {
    googleBtn.disabled = true;
    status.style.display = 'block';
    status.textContent = 'Redirecting to Google…';
    try {
      await signInWithGoogle();
    } catch (err) {
      status.textContent = err.message || 'Sign-in failed. Please try again.';
      googleBtn.disabled = false;
    }
  };

  container.append(
    card(
      logo(),
      el('h1', null, 'Welcome to Hasino'),
      Object.assign(el('p', 'sub', 'Discover and book top salons & barbers near you in seconds.'), {
        style: 'margin-bottom:28px',
      }),
      googleBtn,
      status,
      Object.assign(el('div', 'note', '🔒 Single sign-on powered by Google.'), {
        style: 'margin-top:24px; text-align:left',
      }),
    ),
  );
}
