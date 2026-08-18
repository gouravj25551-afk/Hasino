/**
 * Every module the browser asks for is actually served.
 *
 * The asset list in server.ts is explicit — loadAssets() reads exactly the
 * names it is given, which is deliberate (nothing is served that nobody
 * listed). The cost is that adding a file under public/ and importing it is
 * not enough: an unlisted file 404s, the import fails, and because a failed
 * ES module import takes the *whole* entry module down with it, the page
 * renders blank rather than degrading.
 *
 * That is exactly what happened when components/Toast.js was added: the salon
 * panel went entirely white, and the full test suite stayed green, because
 * nothing here connected an import to the list that makes it fetchable.
 *
 * These tests are static — they read the source rather than booting a server —
 * so they need no database and no network.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const publicDir = fileURLToPath(new URL('../src/http/public/', import.meta.url));
const serverSrc = readFileSync(new URL('../src/http/server.ts', import.meta.url), 'utf8');
/**
 * The operator panel is served by a *second*, separately-bound process
 * (admin-main.ts). Keeping admin.html/admin.js out of the customer server's
 * list is the point of that split — see admin-separation.test.ts — so the
 * "is it reachable at all" checks below have to consider both lists, while
 * the per-module import check stays scoped to the server that owns the file.
 */
const adminSrc = readFileSync(new URL('../src/http/admin-server.ts', import.meta.url), 'utf8');

/**
 * The names passed to loadAssets(), as written in server.ts.
 *
 * Sliced between the call and its closing `]);` rather than matched with one
 * regex: a lazy `[\s\S]*?` runs straight past the array's bracket and starts
 * collecting the quoted tokens of the CSP further down the file.
 */
function listedAssets(src: string, where: string): Set<string> {
  const start = src.indexOf('loadAssets(');
  assert.notEqual(start, -1, `could not find the loadAssets(...) call in ${where}`);
  const end = src.indexOf('\n]);', start);
  assert.notEqual(end, -1, `could not find the end of the loadAssets([...]) array in ${where}`);
  const body = src.slice(start, end);
  return new Set([...body.matchAll(/'([^']+\.(?:js|css|html))'/g)].map((m) => m[1]!));
}

/** Every file under public/, as paths relative to it, skipping dotfiles. */
function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

describe('static assets', () => {
  const listed = listedAssets(serverSrc, 'server.ts');
  const adminListed = listedAssets(adminSrc, 'admin-server.ts');
  const servedAnywhere = new Set([...listed, ...adminListed]);
  const onDisk = walk(publicDir);

  it('finds the asset list and the files it refers to', () => {
    assert.ok(listed.size > 20, `expected a real asset list, got ${listed.size}`);
    assert.ok(onDisk.length > 20, `expected files under public/, got ${onDisk.length}`);
  });

  it('serves every js/css/html file that exists under public/', () => {
    const servable = onDisk.filter((f) => /\.(js|css|html)$/.test(f));
    const missing = servable.filter((f) => !servedAnywhere.has(f));
    assert.deepEqual(
      missing,
      [],
      `these exist under public/ but are not in server.ts's asset list, so they 404:\n  ${missing.join('\n  ')}`,
    );
  });

  it('lists nothing that is not on disk', () => {
    // The other direction: loadAssets does readFileSync at boot, so a stale
    // name here is not a 404 — it is the server refusing to start.
    const onDiskSet = new Set(onDisk);
    const ghosts = [...servedAnywhere].filter((f) => !onDiskSet.has(f));
    assert.deepEqual(ghosts, [], `listed by a server but missing from public/:\n  ${ghosts.join('\n  ')}`);
  });

  it('serves every module the browser modules import from each other', () => {
    // The direct check: follow the relative imports rather than trusting that
    // "every file on disk" and "every file imported" are the same set.
    const problems: string[] = [];
    for (const file of onDisk.filter((f) => f.endsWith('.js'))) {
      // admin.js runs on the admin origin, so its imports must be in the admin
      // server's list, not the customer server's.
      const owner = file.startsWith('admin') ? adminListed : listed;
      const ownerName = file.startsWith('admin') ? 'admin-server.ts' : 'server.ts';
      const src = readFileSync(path.join(publicDir, file), 'utf8');
      for (const m of src.matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]!));
        if (!owner.has(target)) {
          problems.push(`${file} imports ${m[1]} -> ${target}, not listed in ${ownerName}`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('never caches the HTML shells, which name every other file', () => {
    // A stale shell pins a stale app forever, so this is the one thing in the
    // asset layer that must not be revalidate-cached.
    assert.match(
      readFileSync(new URL('../src/http/respond.ts', import.meta.url), 'utf8'),
      /ext === '\.html' \? 'no-store'/,
    );
  });
});
