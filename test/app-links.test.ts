/**
 * The OAuth return leg: Chrome finishes the sign-in, the app gets it back.
 *
 * Google refuses OAuth inside a WebView, so the Google step happens in the
 * real browser and that is not going to change. What must not happen is the
 * browser *keeping* the result: it completes the handshake in its own cookie
 * jar and the app the user started from is still signed out, because a WebView
 * shares no storage with Chrome.
 *
 * Two mechanisms bring it back, and the whole point of these tests is that the
 * second one exists because the first one can be switched off by a missing
 * environment variable on a server:
 *
 *   1. App Links — Android hands https://<host>/sso-callback straight to the
 *      app, but only if /.well-known/assetlinks.json vouches for the APK's
 *      signing certificate. Unset fingerprints => 404 => no verification =>
 *      Chrome keeps the link. That is what was happening in production.
 *   2. The hand-off page — the callback page, when it finds itself in an
 *      Android browser, offers the sign-in back to the app by intent: URL.
 *      Nothing about it depends on server configuration.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const { assetLinkStatements } = await import('../src/http/server.ts');

const FINGERPRINT = '74:32:7B:37:93:45:EE:A9:4D:D6:F3:66:DD:CD:1B:30:FE:66:C0:03:80:43:96:7F:4E:B9:66:C4:ED:9C:45:1F';

describe('assetlinks — what makes Android trust the app with these links', () => {
  const saved = process.env['ANDROID_CERT_FINGERPRINTS'];

  beforeEach(() => {
    delete process.env['ANDROID_CERT_FINGERPRINTS'];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['ANDROID_CERT_FINGERPRINTS'];
    else process.env['ANDROID_CERT_FINGERPRINTS'] = saved;
  });

  it('declares nothing when no fingerprint is configured — which is what broke the flow', () => {
    // Null is a 404 at the route. It must not be an empty list: an empty
    // `relation` is a positive statement that NO app may handle these links,
    // and Android caches that answer.
    assert.equal(assetLinkStatements(), null);
  });

  it('serves a declaration Android can verify once the fingerprint is set', () => {
    process.env['ANDROID_CERT_FINGERPRINTS'] = FINGERPRINT;
    const statements = assetLinkStatements() as Array<{
      relation: string[];
      target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
    }>;
    assert.equal(statements.length, 1);
    const [statement] = statements;
    assert.deepEqual(statement!.relation, ['delegate_permission/common.handle_all_urls']);
    assert.equal(statement!.target.namespace, 'android_app');
    // Must match the applicationId in android/app/build.gradle, or Android
    // verifies a statement about a different app and the link stays in Chrome.
    assert.equal(statement!.target.package_name, 'com.hasino.app');
    assert.deepEqual(statement!.target.sha256_cert_fingerprints, [FINGERPRINT]);
  });

  it('takes more than one fingerprint, because debug and release differ', () => {
    const release = 'AA:BB:' + FINGERPRINT.slice(6);
    process.env['ANDROID_CERT_FINGERPRINTS'] = `${FINGERPRINT}, ${release}`;
    const statements = assetLinkStatements() as Array<{ target: { sha256_cert_fingerprints: string[] } }>;
    assert.deepEqual(statements[0]!.target.sha256_cert_fingerprints, [FINGERPRINT, release]);
  });

  it('is asked for by the deployment blueprint', () => {
    // The variable existed and nothing ever prompted for it, so the endpoint
    // 404'd in production and App Links never verified.
    const render = read('render.yaml');
    assert.match(render, /ANDROID_CERT_FINGERPRINTS/);
    assert.match(render, /ANDROID_PACKAGE/);
  });
});

describe('the app claims exactly the callback it is sent to', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const buildGradle = read('android/app/build.gradle');
  const auth = read('src/http/public/lib/auth.js');

  it('claims the https callback path, and verifies it', () => {
    assert.match(manifest, /android:autoVerify="true"/);
    assert.match(manifest, /android:scheme="https"/);
    assert.match(manifest, /android:path="\/sso-callback"/);
  });

  it('takes the host from the same config the WebView loads', () => {
    // A hardcoded host would disagree with HASINO_APP_URL the moment either
    // moved, and the symptom of that disagreement is Chrome keeping the user.
    assert.match(manifest, /android:host="\$\{hasinoAppHost\}"/);
    assert.match(buildGradle, /capacitor\.config\.json/);
    assert.match(buildGradle, /manifestPlaceholders = \[hasinoAppHost: hasinoAppHost\]/);
  });

  it('also claims the scheme that needs no verification', () => {
    assert.match(manifest, /android:scheme="hasino"/);
    assert.match(manifest, /android:host="sso-callback"/);
  });

  it('and the page it lands on is the app shell, which finishes the handshake', () => {
    assert.match(read('src/http/server.ts'), /'\/sso-callback'/);
    assert.match(auth, /export function isRedirectCallback/);
  });
});

describe('the hand-off back to the app', () => {
  const app = read('src/http/public/app.js');
  const auth = read('src/http/public/lib/auth.js');

  it('offers an intent: URL, which is the form Chrome honours', () => {
    // A scripted navigation to a bare custom scheme is routinely refused by
    // Chrome, silently — which leaves the user parked on the callback page.
    assert.match(auth, /export function nativeCallbackIntentUrl/);
    assert.match(auth, /intent:\/\//);
    assert.match(auth, /package=com\.hasino\.app/);
    assert.match(app, /nativeCallbackIntentUrl\(\)/);
  });

  it('does not depend on ?native=1 surviving Clerk and Google', () => {
    // The flag is the precise signal, but if it is dropped anywhere on the
    // round trip the browser silently keeps the session. An Android browser on
    // the callback page is enough to offer the hand-off.
    assert.match(app, /callbackWantsNativeApp\(\) \|\| isAndroidBrowser\(\)/);
    assert.match(auth, /export function isAndroidBrowser/);
  });

  it('never offers it inside the app itself', () => {
    // The app IS where the callback should land; handing it to itself would
    // be a loop.
    assert.match(app, /!isNativeApp\(\) && \(/);
  });

  it('leaves a way to finish in the browser, for a phone with no app', () => {
    assert.match(app, /Continue in this browser instead/);
    const handoff = /function handOffToNativeApp\(\)[\s\S]*?\n}/.exec(app)?.[0] ?? '';
    assert.match(handoff, /completeRedirectCallback\(\)/);
  });

  it('marks a sign-in that started in the app', () => {
    assert.match(auth, /isNativeApp\(\) \? `\?\$\{NATIVE_FLAG\}=1` : ''/);
  });

  it('recognises the app by the user agent the shell appends', () => {
    // The site is loaded from the network, so Capacitor never injects its
    // bridge and window.Capacitor does not exist — the UA is the only signal.
    assert.match(auth, /HasinoApp\\\//);
    assert.match(read('capacitor.config.ts'), /appendUserAgent: 'HasinoApp\/1'/);
  });
});

describe('an already signed-in launch stays in the app', () => {
  const app = read('src/http/public/app.js');
  const login = read('src/http/public/views/login.js');

  it('sign-in is only ever started by a tap', () => {
    // Anything that called signInWithGoogle() on load would send a
    // already-signed-in user out to Chrome every time they opened the app.
    // signInWithGoogle() is reachable only from start(), and start() only
    // from an onclick. Anything calling it at render time would send an
    // already-signed-in user out to Chrome every time they opened the app.
    assert.match(login, /customerBtn\.onclick = \(\) => start\(/);
    assert.match(login, /salonBtn\.onclick = \(\) => start\(/);
    const calls = login.match(/signInWithGoogle\(\)/g) ?? [];
    assert.equal(calls.length, 1, 'exactly one call site, inside start()');
    const startFn = /const start = async \([\s\S]*?\n  \};/.exec(login)?.[0] ?? '';
    assert.match(startFn, /await signInWithGoogle\(\)/, 'and it is that one');
  });

  it('a restored session routes by role, in the app', () => {
    assert.match(app, /routeOnOpen\(\)/);
    assert.match(app, /if \(app\.session\?\.role === 'business'\) return '\/business'/);
  });

  it("the owner's panel is a path on the same origin, so it stays in the WebView", () => {
    // '/business' is same-origin; only the admin panel is a different host,
    // and capacitor.config.ts adds it to allowNavigation when it is set.
    assert.match(read('capacitor.config.ts'), /allowNavigation/);
    assert.match(read('capacitor.config.ts'), /HASINO_ADMIN_URL/);
  });
});
