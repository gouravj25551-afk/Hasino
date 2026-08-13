/**
 * The admin panel is not part of the public application.
 *
 * These assertions are the architecture, written down. Every one of them is a
 * thing that would be easy to undo by accident — one line added back to PAGES,
 * one import restored, one convenience link in a nav — and none of them would
 * fail a normal test run or look wrong in review. What they protect is that
 * the operator's surface is not on the public internet at all, rather than
 * being on it behind a role check.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const publicServer = read('src/http/server.ts');
const adminServer = read('src/http/admin-server.ts');

describe('the public app has no admin surface', () => {
  it('serves no admin page', () => {
    const pages = /const PAGES: Record<string, string> = \{([\s\S]*?)\};/.exec(publicServer)?.[1] ?? '';
    assert.notEqual(pages, '', 'PAGES table not found');
    assert.doesNotMatch(pages, /admin/, 'the public server must not serve an admin shell');
  });

  it('serves no admin asset', () => {
    const assets = /const assets = loadAssets\([\s\S]*?\]\);/.exec(publicServer)?.[0] ?? '';
    assert.notEqual(assets, '', 'asset list not found');
    assert.doesNotMatch(assets, /admin\.(html|js)/, 'admin assets must not be served publicly');
  });

  it('mounts no admin API', () => {
    // The route table, not the prose explaining why it is absent.
    const code = publicServer.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /adminRoutes\(/, 'adminRoutes must not be mounted on the public server');
    assert.doesNotMatch(code, /seg\[1\] === 'admin'/, 'no /api/admin/* branch on the public server');
  });

  it('links to no admin panel from any customer or salon screen', () => {
    // A link is not a security boundary, but a public app that advertises an
    // internal tool is the opposite of what was asked for.
    for (const file of [
      'src/http/public/app.js',
      'src/http/public/components/TopBar.js',
      'src/http/public/views/profile.js',
      'src/http/public/business.js',
      'src/http/public/index.html',
      'src/http/public/business.html',
    ]) {
      const code = read(file).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.doesNotMatch(code, /['"`]\/admin['"`]/, `${file} still points at /admin`);
    }
  });
});

describe('each app tells Clerk its own routes', () => {
  // lib/auth.js is shared. Its defaults are the customer app's hash routes,
  // and the admin panel has none of them: Clerk would send the browser to
  // '#/login', the admin router would find no match and fall back to
  // '#/overview', and a sign-in would look like a button that does nothing.
  const auth = read('src/http/public/lib/auth.js');
  const admin = read('src/http/public/admin.js');

  it('the shared module takes its URLs from configuration, not literals', () => {
    const afterConfig = auth.slice(auth.indexOf('const routes ='));
    // The one literal allowed is the default table itself.
    const body = afterConfig.replace(/const routes = \{[^}]*\}/, '');
    assert.doesNotMatch(body, /signInUrl: '\/#/, 'signInUrl must come from the route table');
    assert.doesNotMatch(body, /redirectUrlComplete: window\.location\.origin \+ '\/#/,
      'the completion URL must come from the route table');
  });

  it('the admin panel configures its own before Clerk loads', () => {
    assert.match(admin, /configureAuthRoutes\(\{ signIn: '\/', home: '\/#\/overview' \}\)/);
    // Ordering is the whole point: load() takes these, so configuring after
    // Clerk has loaded would leave the SDK pointed at the other app.
    assert.ok(
      admin.indexOf('configureAuthRoutes(') < admin.indexOf('watchAuthState('),
      'routes must be configured before anything triggers Clerk to load',
    );
  });

  it('refuses a late configuration rather than silently ignoring it', () => {
    assert.match(auth, /must be called before Clerk loads/);
  });
});

describe('the admin panel is private by construction', () => {
  it('defaults to a loopback bind', () => {
    const host = /const HOST = process\.env\['ADMIN_HOST'\] \?\? \(PUBLIC \? '0\.0\.0\.0' : '([^']+)'\)/
      .exec(adminServer)?.[1];
    assert.equal(host, '127.0.0.1', 'the admin server must default to loopback');
  });

  it('reaches a routable interface only through ADMIN_PUBLIC', () => {
    // ADMIN_HOST alone can no longer do it, which is the point: a host name is
    // the shape a mistake takes, and a variable whose only meaning is "on the
    // internet" is the shape a decision takes.
    assert.match(adminServer, /const PUBLIC = process\.env\['ADMIN_PUBLIC'\] === 'true'/);
    assert.match(adminServer, /IS_PROD && !loopback && !PUBLIC/);
    assert.match(adminServer, /throw new Error\(/);
  });

  it('refuses to come up public with a hole in the perimeter', () => {
    // Public means Clerk and ADMIN_EMAILS are the only locks left, so each of
    // these is a boot failure rather than a service that comes up half-locked.
    // Listed explicitly: dropping any one of them is a one-line change that no
    // other test would notice.
    for (const guard of [
      /DEV_AUTH'\] === 'true' \|\| process\.env\['CI_SMOKE'\] === 'true'/,
      /!process\.env\['CLERK_SECRET_KEY'\]/,
      /!process\.env\['CLERK_PUBLISHABLE_KEY'\]/,
      /!\(process\.env\['ADMIN_EMAILS'\] \?\? ''\)\.trim\(\)/,
    ]) {
      assert.match(adminServer, guard);
    }
    assert.match(adminServer, /Refusing to start a public admin panel/);
  });

  it('rate limits when public, because the network no longer does', () => {
    // On loopback the operating system was the limit. On the internet an
    // unauthenticated caller can reach the door.
    assert.match(adminServer, /if \(PUBLIC\) limit\.check\(clientKey\(req, TRUST_PROXY\)\)/);
  });

  it('still authorises every request server-side', () => {
    // The network was never the authorisation — on loopback it was the second
    // lock, and public it is not there at all.
    assert.match(adminServer, /requireRole\(s, 'admin'\)/);
  });

  it('is started by its own entry point', () => {
    // Separate processes, so no configuration of the public app can also
    // start the admin panel.
    assert.match(read('src/admin-main.ts'), /startAdmin\(\)/);
    assert.doesNotMatch(read('src/main.ts'), /admin/i);
  });
});
