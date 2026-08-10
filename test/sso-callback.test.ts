/**
 * The two server-side halves of the Google sign-in redirect.
 *
 * Neither is exercised by any user-facing endpoint, and both fail silently
 * when wrong — a missing route looks like a blank page, a missing CSP source
 * looks like "sign-up is broken but sign-in works". They are asserted here
 * because the symptom is a redirect loop and the cause is one string.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/http/server.ts', import.meta.url), 'utf8');
const middleware = readFileSync(new URL('../src/http/middleware.ts', import.meta.url), 'utf8');
const auth = readFileSync(new URL('../src/http/public/lib/auth.js', import.meta.url), 'utf8');

describe('OAuth callback route', () => {
  it('serves the app shell at the path Clerk redirects back to', () => {
    assert.match(server, /'\/sso-callback': 'index\.html'/);
  });

  it('points the client at that same path', () => {
    const declared = /const CALLBACK_PATH = '([^']+)'/.exec(auth)?.[1];
    assert.equal(declared, '/sso-callback');
  });

  it('does not put the callback behind a hash route', () => {
    // Clerk appends its parameters as a query string. On a '#/...' target they
    // land inside the fragment, location.search is empty, and the sign-in can
    // never be completed — which is exactly how the loop happened.
    assert.doesNotMatch(
      auth,
      /redirectUrl: window\.location\.origin \+ '\/#/,
      'redirectUrl must be a real path, not a hash route',
    );
    const url = new URL('http://x' + '/sso-callback' + '?__clerk_status=complete');
    assert.equal(url.search, '?__clerk_status=complete');
  });

  it('completes the redirect rather than only starting it', () => {
    // authenticateWithRedirect without a matching handleRedirectCallback is a
    // flow that nothing finishes: the browser returns holding a sign-in
    // attempt and no session.
    assert.match(auth, /handleRedirectCallback\(/);
  });
});

describe('no phone is asked for anywhere in sign-in', () => {
  const login = readFileSync(new URL('../src/http/public/views/login.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/http/public/app.js', import.meta.url), 'utf8');
  const session = readFileSync(new URL('../src/auth/session.ts', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

  it('the login view has no phone step left in it', () => {
    assert.doesNotMatch(login, /phone/i);
  });

  it('nothing throws or routes on 428 PHONE_REQUIRED', () => {
    // Prose about the old behaviour is fine; a live code path is not.
    assert.doesNotMatch(session, /throw new AuthError\(\s*428/);
    assert.doesNotMatch(app, /status === 428/);
  });

  it('users.phone is nullable, so an account can exist without one', () => {
    const col = /phone\s+text\s+UNIQUE(\s+NOT NULL)?/.exec(schema);
    assert.ok(col, 'users.phone column not found');
    assert.equal(col[1], undefined, 'users.phone must not be NOT NULL');
  });
});

describe('panels do not rebuild themselves on a token refresh', () => {
  // watchAuthState fires on every Clerk resource change, including the routine
  // token refresh that happens about once a minute. Both panels re-render the
  // current view from that callback, and those views start by clearing #view —
  // so without an identity guard, anything typed into a form is wiped roughly
  // every minute, which reads as the page reloading on its own.
  for (const panel of ['admin.js', 'business.js']) {
    it(`${panel} only re-renders when the identity actually changes`, () => {
      const src = readFileSync(new URL(`../src/http/public/${panel}`, import.meta.url), 'utf8');
      const handler = /watchAuthState\(async \(([^)]*)\) => \{([\s\S]*?)\n\}\)/.exec(src);
      assert.ok(handler, `${panel}: watchAuthState handler not found`);
      const args = handler[1] ?? '';
      const body = handler[2] ?? '';
      assert.notEqual(args.trim(), '', `${panel}: handler must receive the user to compare`);
      assert.match(
        body,
        /if \(userId === lastUserId\) return;/,
        `${panel}: handler must bail out when the user is unchanged`,
      );
      // The guard is worthless below the work it is meant to skip.
      assert.ok(
        body.indexOf('lastUserId) return') < body.indexOf('render()'),
        `${panel}: the guard must come before render()`,
      );
    });
  }
});

describe('both dashboards are reachable from the customer app', () => {
  const topbar = readFileSync(new URL('../src/http/public/components/TopBar.js', import.meta.url), 'utf8');
  const profile = readFileSync(new URL('../src/http/public/views/profile.js', import.meta.url), 'utf8');

  it('the top bar links each role to its panel', () => {
    assert.match(topbar, /'admin'.*'\/admin'/s);
    assert.match(topbar, /'business'.*'\/business'/s);
  });

  it('the profile list links an admin to /admin', () => {
    // This is the one that was missing: role 'admin' matched neither branch,
    // so the admin panel had no link anywhere in the app.
    assert.match(profile, /role === 'admin'/);
    assert.match(profile, /'\/admin'/);
  });
});

describe('no native browser dialogs', () => {
  // window.prompt() THROWS "prompt() is not supported." in sandboxed and
  // embedded contexts, and Chrome suppresses alert/confirm/prompt entirely
  // once a user ticks "prevent this page from creating additional dialogs".
  // Every call site sat in an onclick that ignored the returned promise, so
  // the throw became an unhandled rejection and the button silently did
  // nothing — that is how "Approve & activate" stopped working.
  const surfaces = [
    'admin.js',
    'business.js',
    'views/bookings.js',
  ];
  for (const file of surfaces) {
    it(`${file} uses the in-page dialog, not alert/confirm/prompt`, () => {
      const src = readFileSync(new URL(`../src/http/public/${file}`, import.meta.url), 'utf8');
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
        .replace(/^\s*\/\/.*$/gm, '');     // line comments
      for (const fn of ['alert', 'confirm', 'prompt']) {
        assert.doesNotMatch(
          code,
          new RegExp(`(^|[^.\\w])${fn}\\s*\\(`),
          `${file} still calls ${fn}() — it is unavailable in some contexts and fails silently`,
        );
      }
    });
  }

  it('the dialog module is actually served', () => {
    // loadAssets() takes an explicit allowlist; a module missing from it 404s
    // at import time and takes the whole panel down with it.
    assert.match(server, /'lib\/dialog\.js'/);
  });
});

describe('CSP', () => {
  const scriptSrc = /"script-src ([^"]+)"/.exec(middleware)?.[1] ?? '';
  const frameSrc = /"frame-src ([^"]+)"/.exec(middleware)?.[1] ?? '';

  it('allows Clerk bot protection as a script, not just as a frame', () => {
    // Turnstile is a script that then creates the frame. Trusting only the
    // frame blocks the script, and the sole symptom is that *sign-up* fails
    // with captcha_invalid while sign-in keeps working.
    assert.ok(frameSrc.includes('https://challenges.cloudflare.com'));
    assert.ok(
      scriptSrc.includes('https://challenges.cloudflare.com'),
      'challenges.cloudflare.com must be in script-src or new accounts cannot be created',
    );
  });

  it('still refuses eval', () => {
    assert.ok(!scriptSrc.includes('unsafe-eval'));
  });
});
