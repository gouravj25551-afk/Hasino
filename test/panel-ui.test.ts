/**
 * Panel behaviours that are one careless edit from regressing, written down.
 *
 * These are source assertions in the style of admin-separation.test.ts: the
 * panels are browser modules with no build step and no DOM in the test runner,
 * so what can be protected here is the shape of the code — that the save
 * buttons go through the one helper that ties "Saved" to a response, that the
 * salon's no-show rate is not back on the owner's screen, and that the image
 * upload paths are the ones the server actually serves.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const business = read('src/http/public/business.js');
const admin = read('src/http/public/admin.js');
const server = read('src/http/server.ts');
const adminServer = read('src/http/admin-server.ts');

describe('salon panel — Save means saved', () => {
  it('the save state is set from the response, not from the click', () => {
    // The assignment that flips the button to "Saved" must sit after the await
    // on submit(), so a rejected save leaves it saying "Save".
    const helper = /function saveButton\([\s\S]*?\n}/.exec(business)?.[0] ?? '';
    assert.notEqual(helper, '', 'saveButton() not found');
    const submitAt = helper.indexOf('await submit()');
    const markAt = helper.indexOf('savedAt = attempted');
    assert.ok(submitAt > 0 && markAt > submitAt, '"Saved" must be set only after the API confirms');
    assert.match(helper, /catch \(err\)[\s\S]*?onError/, 'a failed save still reports the error');
  });

  it('editing a saved form puts it back to Save', () => {
    const helper = /function saveButton\([\s\S]*?\n}/.exec(business)?.[0] ?? '';
    assert.match(helper, /addEventListener\('input', paint\)/);
    assert.match(helper, /addEventListener\('change', paint\)/);
    assert.match(helper, /snapshot\(\) === savedAt/, 'saved-ness is a comparison against what was saved');
  });

  it('both salon settings forms use it', () => {
    // Services: price, duration, buffer, live.
    assert.match(business, /watch: \[price, dur, buf, active\]/);
    // Timings: the whole day card, capacity and slot size included.
    assert.match(business, /watch: \[working, open, close, bs, be, cap, iv\]/);
  });

  it('saving a service no longer redraws the screen out from under it', () => {
    const row = /function myServiceRow\(s\) \{[\s\S]*?\n  \}/.exec(business)?.[0] ?? '';
    assert.notEqual(row, '', 'myServiceRow() not found');
    const saveBlock = /saveButton\(\{[\s\S]*?\}\);/.exec(row)?.[0] ?? '';
    assert.doesNotMatch(saveBlock, /servicesView\(\)/, 'a re-render would discard the Saved state');
  });
});

describe('salon panel — no-show policy is not the salon owner’s to set', () => {
  it('the no-show rate tile is gone from the owner’s insights', () => {
    const insights = /async function insightsView\(\)[\s\S]*?\n}/.exec(business)?.[0] ?? '';
    assert.notEqual(insights, '', 'insightsView() not found');
    const code = insights.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /noShowRate/, 'the salon panel must not display a no-show rate');
  });

  it('the panel offers no way to configure a no-show refund', () => {
    const code = business.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /noShowRefund|no_show_refund|refundRate/i);
  });

  it('the server still computes it, for the people it is for', () => {
    // Removing the tile must not remove the fraud counter: admins use it.
    assert.match(read('src/business/repo.ts'), /noShowRate/);
  });

  it('the 15-minute grace period is still enforced on the write', () => {
    const status = read('src/booking/status.ts');
    assert.match(status, /NO_SHOW_GRACE_MIN = 15/);
    assert.match(status, /NoShowTooEarlyError/);
  });
});

describe('salon image — the panels and the server agree on the paths', () => {
  it('the owner uploads to a route that names no salon', () => {
    assert.match(business, /'\/api\/business\/image'/);
    assert.match(read('src/http/routes-business.ts'), /tail\[0\] === 'image'/);
  });

  it('the admin uploads against a salon id', () => {
    assert.match(admin, /\/api\/admin\/\$\{salonId\}\/image|api\/admin\/salons\/\$\{salonId\}\/image/);
    assert.match(read('src/http/routes-admin.ts'), /rest\[0\] === 'image'/);
  });

  it('both servers serve the bytes back', () => {
    for (const [name, source] of [['public', server], ['admin', adminServer]] as const) {
      assert.match(source, /serveSalonImage\(/, `the ${name} server must serve salon images`);
    }
  });

  it('the panels check type and size before sending anything', () => {
    for (const [name, source] of [['owner', business], ['admin', admin]] as const) {
      assert.match(source, /image\/jpeg', 'image\/png', 'image\/webp/, `${name} panel: type allowlist`);
      assert.match(source, /MAX_IMAGE_MB/, `${name} panel: size limit`);
    }
  });

  it('the preview is the stored URL, never a local blob', () => {
    // A blob: preview looks identical whether or not the upload landed.
    assert.doesNotMatch(business, /createObjectURL/);
    assert.doesNotMatch(admin, /createObjectURL/);
  });
});
