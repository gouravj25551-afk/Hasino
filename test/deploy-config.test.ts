/**
 * The deploy path, asserted as configuration rather than as prose.
 *
 * Two failures sat in this repo for weeks and neither one broke a test,
 * because both lived in files no test read:
 *
 *   - The gated deploy workflow could not release. It requires
 *     RENDER_DEPLOY_HOOK_URL and the secret was never added, so every push to
 *     main verified green and then failed at the last step. Production stayed
 *     current only because Render's own ungated auto-deploy was still on —
 *     the exact thing the gate exists to replace.
 *   - Migrations had no way to reach production at all. The Dockerfile goes
 *     straight to `node src/main.ts`, render.yaml has no pre-deploy command,
 *     and the workflow's migrate step is skipped unless an optional secret is
 *     set. The schema advanced only by hand.
 *
 * These are static checks — they read the config, boot nothing and need no
 * database — so they run everywhere and cost nothing. They cannot assert that
 * a secret exists in GitHub (nothing here can see that); they assert the
 * wiring that makes the secret the only missing piece.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const workflow = read('.github/workflows/deploy.yml');
const renderYaml = read('render.yaml');
const dockerfile = read('Dockerfile');
const mainTs = read('src/main.ts');

describe('the deploy workflow', () => {
  it('still references the deploy hook secret by the documented name', () => {
    // The name is what the operator types into GitHub. If this drifts, the
    // secret they added stops being read and the failure is a silent skip.
    assert.match(workflow, /secrets\.RENDER_DEPLOY_HOOK_URL/);
    assert.match(workflow, /RENDER_DEPLOY_HOOK_URL: \$\{\{ secrets\.RENDER_DEPLOY_HOOK_URL \}\}/);
  });

  it('never interpolates a secret into a shell script body', () => {
    // `${{ secrets.X }}` inside a `run:` block is pasted into the shell before
    // it executes, so the value is parsed as syntax rather than handled as
    // data. Through `env:` the shell sees an ordinary variable.
    const runBlocks = [...workflow.matchAll(/run: \|([\s\S]*?)(?=\n      - |\n  \w|\n\w|$)/g)]
      .map((m) => m[1]!);
    assert.ok(runBlocks.length > 0, 'expected to find run: | blocks');
    for (const block of runBlocks) {
      assert.doesNotMatch(
        block,
        /\$\{\{\s*secrets\./,
        `a run: block interpolates a secret directly:\n${block.trim().slice(0, 200)}`,
      );
    }
  });

  it('verifies before it releases', () => {
    // The whole point of the gate: deploy waits on the job that typechecks
    // and runs the suite. Dropping `needs` would make it a plain auto-deploy.
    assert.match(workflow, /deploy:\s*\n\s*needs: verify/);
    assert.match(workflow, /npm test/);
    assert.match(workflow, /npm run typecheck/);
  });

  it('does not race Render’s own auto-deploy', () => {
    // Every service must opt out, or Render fires on the raw push ahead of
    // the gate and the ungated build is the one that goes live. Asserted as
    // "one line per service, all false" rather than a fixed count, so adding a
    // service (the jobs cron) is a one-line render.yaml change, not a test
    // edit — but a service that forgets the opt-out still fails here.
    const services = (renderYaml.match(/^\s*- type:\s/gm) ?? []).length;
    const autoDeploys = [...renderYaml.matchAll(/^\s*autoDeploy:\s*(\S+)/gm)].map((m) => m[1]);
    assert.equal(autoDeploys.length, services, 'expected one autoDeploy line per service');
    for (const value of autoDeploys) assert.equal(value, 'false');
  });
});

describe('migrations reach production', () => {
  it('runs before the server listens, not after', () => {
    // Awaited, and above start(). A container serving requests while its
    // schema catches up is the window this closes.
    assert.match(mainTs, /await migrateOnBoot\(\)/);
    assert.ok(
      mainTs.indexOf('await migrateOnBoot()') < mainTs.indexOf('start()'),
      'migrateOnBoot must be awaited before start()',
    );
  });

  it('is enabled on the service that owns the schema', () => {
    assert.match(renderYaml, /- key: RUN_MIGRATIONS_ON_BOOT\s*\n\s*value: "true"/);
    // Once, not twice: the admin panel shares this database, and two services
    // racing for the same advisory lock is a boot ordering question nobody
    // should have to think about.
    assert.equal(
      (renderYaml.match(/RUN_MIGRATIONS_ON_BOOT/g) ?? []).length,
      1,
      'only the customer service should own the migration run',
    );
  });

  it('ships the script the boot path shells out to', () => {
    // src/db/migrate-on-boot.ts spawns scripts/migrate.ts. If the image stops
    // copying scripts/, boot fails at runtime on a path no build step checks.
    assert.match(dockerfile, /COPY scripts \.\/scripts/);
  });

  it('uses the project’s own migration implementation, not a second one', () => {
    const boot = read('src/db/migrate-on-boot.ts');
    assert.match(boot, /scripts\/migrate\.ts/);
    // No hand-rolled SQL here: the ledger, the advisory lock and the checksums
    // all live in that script and must not be reimplemented.
    assert.doesNotMatch(boot, /CREATE TABLE|INSERT INTO|ALTER TABLE/i);
  });

  it('is opt-in, so a developer’s machine never rewrites a shared database', () => {
    const boot = read('src/db/migrate-on-boot.ts');
    assert.match(boot, /RUN_MIGRATIONS_ON_BOOT'\] !== 'true'\) return/);
  });

  it('refuses to serve when a migration fails', async () => {
    const boot = read('src/db/migrate-on-boot.ts');
    // Exiting is what keeps the previous version live: Render only routes to a
    // container that passes its health check. Serving anyway would put the new
    // build against a schema it was not written for.
    assert.match(boot, /process\.exit\(1\)/);
  });

  it('does nothing at all when the flag is unset', async () => {
    // The default path, exercised for real rather than read: with the flag
    // absent this must return without needing DATABASE_URL or a database.
    const before = process.env['RUN_MIGRATIONS_ON_BOOT'];
    delete process.env['RUN_MIGRATIONS_ON_BOOT'];
    try {
      const { migrateOnBoot } = await import('../src/db/migrate-on-boot.ts');
      await migrateOnBoot(); // resolves, spawns nothing, throws nothing
    } finally {
      if (before !== undefined) process.env['RUN_MIGRATIONS_ON_BOOT'] = before;
    }
  });
});
