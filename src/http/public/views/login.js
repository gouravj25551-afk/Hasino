import { el } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { confirmPhoneLinkOtp, sendPhoneLinkOtp, signInWithGoogle } from '../lib/auth.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

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

export function renderLogin(container, app) {
  container.innerHTML = '';

  if (app.devIdentities) {
    container.append(
      card(
        logo(),
        el('h1', null, 'DEV_AUTH is on'),
        el('p', 'sub', 'Use the identity switcher in the top bar instead of signing in with Google.'),
      ),
    );
    return;
  }

  renderGoogleStep(container, app);
}

function renderGoogleStep(container, app) {
  container.innerHTML = '';

  const status = el('div', 'note');
  status.style.marginTop = '18px';
  status.style.display = 'none';

  const googleBtn = el('button', 'btn primary');
  googleBtn.type = 'button';
  googleBtn.style.cssText = 'width:100%; padding:12px 20px; font-size:15px; border-radius:12px; display:flex; align-items:center; justify-content:center; gap:12px;';
  googleBtn.innerHTML = `${GOOGLE_G}<span>Continue with Google</span>`;

  googleBtn.onclick = async () => {
    googleBtn.disabled = true;
    status.style.display = 'block';
    status.textContent = 'Opening Google sign-in…';
    try {
      const result = await signInWithGoogle();
      if (!result) {
        status.textContent = 'Redirecting to Google…';
        return; // page is about to navigate away for the redirect fallback
      }
      status.textContent = 'Signed in — setting up your account…';
      await afterGoogleSignIn(container, app);
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

async function afterGoogleSignIn(container, app) {
  try {
    app.session = await app.refreshSession();
    app.navigate('#/home');
  } catch (err) {
    if (err instanceof ApiError && err.status === 428) {
      renderPhoneLink(container, app);
      return;
    }
    throw err;
  }
}

function renderPhoneLink(container, app) {
  container.innerHTML = '';

  const recaptchaHost = el('div');
  recaptchaHost.id = 'recaptcha-container';

  const phoneField = Input({ label: 'Phone number', type: 'tel', placeholder: '+91 98765 43210' });
  const otpField = Input({ label: 'Enter the 6-digit code', type: 'text', placeholder: '123456' });
  otpField.style.display = 'none';
  const status = el('div', 'note');
  status.style.marginTop = '14px';

  let confirmation = null;

  const sendBtn = Button({
    label: 'Send code',
    variant: 'primary',
    onClick: async () => {
      const phone = phoneField.input.value.trim();
      if (!phone) return;
      sendBtn.disabled = true;
      status.textContent = 'Sending code…';
      try {
        confirmation = await sendPhoneLinkOtp(phone, 'recaptcha-container');
        otpField.style.display = '';
        confirmBtn.style.display = '';
        sendBtn.style.display = 'none';
        phoneField.input.disabled = true;
        status.textContent = 'Code sent — enter it below.';
      } catch (err) {
        status.textContent = err.message || 'Could not send that code — check the number and try again.';
        sendBtn.disabled = false;
      }
    },
  });

  const confirmBtn = Button({
    label: 'Confirm',
    variant: 'primary',
    onClick: async () => {
      confirmBtn.disabled = true;
      status.textContent = 'Verifying…';
      try {
        await confirmPhoneLinkOtp(confirmation, otpField.input.value.trim());
        app.session = await app.refreshSession();
        app.navigate('#/home');
      } catch (err) {
        const isTaken = err.code === 'PHONE_TAKEN' || (err instanceof ApiError && err.status === 409);
        status.textContent = isTaken
          ? 'That phone number is already linked to another account.'
          : err.message || 'That code did not verify — try again.';
        confirmBtn.disabled = false;
      }
    },
  });
  confirmBtn.style.display = 'none';

  container.append(
    card(
      logo(),
      el('h1', null, 'Add your phone number'),
      Object.assign(el('p', 'sub', 'Salons need a number to reach you about your booking. One-time step.'), {
        style: 'margin-bottom:20px',
      }),
      phoneField,
      sendBtn,
      otpField,
      confirmBtn,
      status,
      recaptchaHost,
    ),
  );
}
