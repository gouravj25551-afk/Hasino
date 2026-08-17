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

  it('every salon-owner form with a Save goes through it', () => {
    // Services: price, duration, buffer, live.
    assert.match(business, /watch: \[price, dur, buf, active\]/);
    // Timings: the whole day card, capacity and slot size included.
    assert.match(business, /watch: \[working, open, close, bs, be, cap, iv\]/);
    // Profile: the salon's details, and its chair count.
    assert.match(business, /watch: \[name, description, address, city, area, phone, salonEmail\]/);
    assert.match(business, /watch: \[chairs\]/);

    // And nothing hand-rolls a save button beside them: every "Save" label in
    // the panel comes from the helper, so none of them can drift into
    // announcing success before the server has agreed.
    const handRolled = business.match(/el\('button',[^)]*,\s*'Save[^']*'\)/g) ?? [];
    assert.deepEqual(handRolled, [], `hand-rolled save buttons: ${handRolled.join(', ')}`);
  });

  it('keeps what the owner typed when a save fails', () => {
    const helper = /function saveButton\([\s\S]*?\n}/.exec(business)?.[0] ?? '';
    // Nothing in the failure path clears or re-reads the inputs — the values
    // stay on screen so the owner can fix one field and press Save again.
    const failurePath = /catch \(err\) \{[\s\S]*?\n    \}/.exec(helper)?.[0] ?? '';
    assert.match(failurePath, /onError/);
    assert.doesNotMatch(failurePath, /\.value\s*=|innerHTML/);
  });

  it('saving a service no longer redraws the screen out from under it', () => {
    const row = /function myServiceRow\(s\) \{[\s\S]*?\n  \}/.exec(business)?.[0] ?? '';
    assert.notEqual(row, '', 'myServiceRow() not found');
    const saveBlock = /saveButton\(\{[\s\S]*?\}\);/.exec(row)?.[0] ?? '';
    assert.doesNotMatch(saveBlock, /servicesView\(\)/, 'a re-render would discard the Saved state');
  });
});

describe('salon panel — Save sits beside Remove, not above it', () => {
  const css = read('src/http/public/brand.css');

  it('the service row puts both actions in one flex row', () => {
    const row = /function myServiceRow\(s\) \{[\s\S]*?\n  \}/.exec(business)?.[0] ?? '';
    assert.match(row, /el\('div', 'row-actions'\)/);
    assert.match(row, /pair\.append\(save, remove\)/);
    // The old version spaced them with a margin and let the cell wrap.
    assert.doesNotMatch(row, /remove\.style\.marginLeft/);
  });

  it('and that row refuses to wrap', () => {
    const rule = /\.row-actions \{[^}]*\}/.exec(css)?.[0] ?? '';
    assert.notEqual(rule, '', '.row-actions rule not found');
    assert.match(rule, /display: flex/);
    assert.match(rule, /flex-wrap: nowrap/);
    assert.match(rule, /gap:/);
    assert.match(rule, /align-items: center/);
  });

  it('tightens on a narrow phone instead of stacking', () => {
    const narrow = /@media \(max-width: 560px\) \{\s*\.row-actions[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    assert.notEqual(narrow, '', 'no narrow-screen rule for .row-actions');
    assert.match(narrow, /padding-left|padding-right|font-size/);
    // Smaller, but never below a thumb: the base rule keeps the hit area.
    assert.match(css, /\.row-actions \.btn \{[^}]*min-height: 40px/);
  });

  it('keeps Remove visually distinct without making it loud', () => {
    const row = /function myServiceRow\(s\) \{[\s\S]*?\n  \}/.exec(business)?.[0] ?? '';
    assert.match(row, /'btn sm danger', 'Remove'/);
    assert.match(css, /\.btn\.danger \{/);
  });

  it('and Saved reads as a state rather than a dead button', () => {
    assert.match(css, /\.btn\.is-saved/);
    assert.match(business, /classList\.toggle\('is-saved', saved\)/);
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

/**
 * The No-show button, driven at the boundary.
 *
 * business.js is a browser module with a dozen imports and no DOM here, so the
 * one function under test is lifted out of the source and given stubs. That is
 * uglier than an import and worth it: the alternative is asserting on the
 * shape of the code, and what matters about this button is what it says at
 * 10:14:59 versus 10:15:00.
 *
 * The server is the enforcement — test/no-show-grace.test.ts drives that, and
 * the API refuses an early call whatever this button does. This is the other
 * half of the promise: that the salon is not shown an action it may not take.
 */
function loadNoShowButton() {
  const source = read('src/http/public/business.js');
  const fn = /function noShowButton\([\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(fn, 'noShowButton() not found in business.js');

  const el = (tag: string, cls?: string, txt?: string) => {
    const node = {
      tagName: tag,
      className: cls ?? '',
      textContent: txt ?? '',
      disabled: false,
      title: '',
      isConnected: true,
      onclick: null as unknown,
      style: {} as Record<string, string>,
      removeAttribute() {
        this.title = '';
      },
    };
    return node;
  };
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  const ask = async () => true;

  // eslint-disable-next-line no-new-func -- see the comment above.
  return new Function('el', 'time', 'ask', 'setInterval', 'setTimeout', 'clearInterval', `${fn}; return noShowButton;`)(
    el,
    time,
    ask,
    // The timers are what arm the button without a reload. They are not what
    // this test is about, and left live they would hold the run open.
    () => 0,
    () => 0,
    () => {},
  ) as (
    booking: { id: string; noShowAvailableAt: string },
    serverTime: () => number,
    graceMin: number,
    send: () => void,
  ) => { textContent: string; disabled: boolean };
}

describe('salon panel — the No-show button at the 15-minute line', () => {
  const noShowButton = loadNoShowButton();
  /** 10:00 IST on the fixture day, as the server would state it. */
  const start = Date.parse('2026-08-17T04:30:00.000Z');
  const booking = { id: 'b', noShowAvailableAt: new Date(start + 15 * 60_000).toISOString() };
  /** A clock reading `mins`:`secs` past the booking's start. */
  const at = (mins: number, secs = 0) => () => start + mins * 60_000 + secs * 1000;
  const render = (clock: () => number) => noShowButton(booking, clock, 15, () => {});

  it('is disabled before the booking has started', () => {
    const btn = render(at(-1));
    assert.equal(btn.disabled, true);
    assert.match(btn.textContent, /No-show in 16 min/);
  });

  it('is disabled at the scheduled minute', () => {
    const btn = render(at(0));
    assert.equal(btn.disabled, true);
    assert.match(btn.textContent, /No-show in 15 min/);
  });

  it('counts down while the customer is merely late', () => {
    const btn = render(at(7));
    assert.equal(btn.disabled, true);
    assert.equal(btn.textContent, 'No-show in 8 min');
  });

  it('is still disabled one second short of the line', () => {
    const btn = render(at(14, 59));
    assert.equal(btn.disabled, true, '10:14:59 is not 10:15');
    assert.equal(btn.textContent, 'No-show in 1 min');
  });

  it('is the live action at exactly 15 minutes past', () => {
    const btn = render(at(15));
    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, 'No-show');
  });

  it('and stays available after that', () => {
    const btn = render(at(30));
    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, 'No-show');
  });

  it('reads the server’s clock, never the device’s', () => {
    const business = read('src/http/public/business.js');
    // serverNow comes with the bookings list; clockSkewMs corrects a shop
    // phone that is minutes out, in either direction.
    assert.match(business, /const clockSkewMs = serverNow \? Date\.parse\(serverNow\) - Date\.now\(\) : 0/);
    assert.match(business, /const serverTime = \(\) => Date\.now\(\) \+ clockSkewMs/);
    assert.match(business, /noShowButton\(b, serverTime,/);
    assert.match(read('src/http/routes-business.ts'), /serverNow: new Date\(\)\.toISOString\(\)/);
  });

  it('is only offered for a booking that is still merely booked', () => {
    // Not for verified — a customer who read their code out is standing there,
    // and the server refuses that transition outright.
    const business = read('src/http/public/business.js');
    const bookedBranch = /if \(b\.status === 'booked'\) \{[\s\S]*?\n    \}/.exec(business)?.[0] ?? '';
    assert.match(bookedBranch, /noShowButton\(/);
    const verifiedBranch = /if \(b\.status === 'verified'\) \{[\s\S]*?\n    \}/.exec(business)?.[0] ?? '';
    assert.doesNotMatch(verifiedBranch, /noShowButton\(/);
    assert.match(read('src/booking/status.ts'), /verified: \['in_progress', 'cancelled_by_salon'\]/);
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
