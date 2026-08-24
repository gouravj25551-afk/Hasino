/**
 * Android's back button.
 *
 * Capacitor handles back not at all, so the press reached the Activity's
 * default handler and quit the app — from a salon page, from checkout, with a
 * confirmation dialog open. The fix has two halves and both are easy to break
 * silently: the page answers what back means (lib/backbutton.js), and the
 * shell acts on the answer (MainActivity.java).
 *
 * The first half is tested by driving it with stub globals — it is browser
 * code, but it is only decisions. The second half cannot be run here, so what
 * is asserted is that the wiring exists at all: a missing call is exactly how
 * this regresses back to "every press exits".
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/**
 * Enough of a browser for a hash router: a hashchange listener, a history
 * stack this document pushed, and a location whose hash can move.
 */
function fakeBrowser(startHash = '#/home') {
  const listeners: Array<() => void> = [];
  const stack = [startHash];
  const state = {
    get hash() {
      return stack[stack.length - 1]!;
    },
    /** a link click or router.go() */
    navigate(hash: string) {
      stack.push(hash);
      for (const fn of listeners) fn();
    },
    exited: false,
    /**
     * The app walking its own history back — router.back(), which the login
     * page's Back control uses. The event first, then the movement, exactly
     * as the router does it.
     */
    appBack() {
      const w = (globalThis as unknown as { window: { dispatchEvent(e: { type: string }): boolean } }).window;
      w.dispatchEvent({ type: 'hasino:back' });
      if (stack.length > 1) stack.pop();
      for (const fn of listeners) fn();
    },
  };

  /** Listeners for the events the app dispatches at lib/backbutton.js. */
  const appEvents = new Map<string, Array<() => void>>();
  (globalThis as Record<string, unknown>)['window'] = {
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'hashchange') listeners.push(fn);
      else {
        if (!appEvents.has(type)) appEvents.set(type, []);
        appEvents.get(type)!.push(fn);
      }
    },
    /** What router.back() and router.replace() do before they move. */
    dispatchEvent: (event: { type: string }) => {
      for (const fn of appEvents.get(event.type) ?? []) fn();
      return true;
    },
    history: {
      get length() {
        return stack.length;
      },
    },
  };
  (globalThis as Record<string, unknown>)['history'] = {
    back: () => {
      if (stack.length > 1) stack.pop();
      for (const fn of listeners) fn();
    },
  };
  (globalThis as Record<string, unknown>)['location'] = {
    replace: (hash: string) => {
      stack[stack.length - 1] = hash;
      for (const fn of listeners) fn();
    },
  };
  return state;
}

const win = () => (globalThis as Record<string, unknown>)['window'] as { hasinoBack: () => string };

/**
 * Loaded through a variable specifier on purpose: tsconfig covers src/**\/*.ts
 * and test/**\/*.ts only, so the browser modules under src/http/public are not
 * part of the program and a literal import would fail the typecheck with
 * TS7016 rather than tell us anything about the code. The shape used here is
 * asserted by the tests themselves.
 */
const backbuttonModule = '../src/http/public/lib/backbutton.js';
const { installBackHandler } = (await import(backbuttonModule)) as {
  installBackHandler: (opts: {
    isRoot: () => boolean;
    homeHash: string;
    dismissOverlay: () => boolean;
  }) => void;
};

describe('back button — what the page tells the shell', () => {
  let browser: ReturnType<typeof fakeBrowser>;
  let overlayOpen: boolean;

  beforeEach(() => {
    browser = fakeBrowser();
    overlayOpen = false;
    installBackHandler({
      isRoot: () => browser.hash === '#/home',
      homeHash: '#/home',
      dismissOverlay: () => {
        if (!overlayOpen) return false;
        overlayOpen = false;
        return true;
      },
    });
  });

  it('exits only at home with nothing behind it', () => {
    assert.equal(win().hasinoBack(), 'exit');
  });

  it('walks back one screen per press: home -> salon -> checkout', () => {
    browser.navigate('#/salon/abc');
    browser.navigate('#/checkout/def');

    assert.equal(win().hasinoBack(), 'handled');
    assert.equal(browser.hash, '#/salon/abc');

    assert.equal(win().hasinoBack(), 'handled');
    assert.equal(browser.hash, '#/home');

    // ...and only then does it quit.
    assert.equal(win().hasinoBack(), 'exit');
  });

  it('closes an open dialog before it navigates anywhere', () => {
    browser.navigate('#/salon/abc');
    overlayOpen = true;

    assert.equal(win().hasinoBack(), 'handled');
    assert.equal(browser.hash, '#/salon/abc', 'the confirm dialog closed, the page did not move');
    assert.equal(overlayOpen, false);

    assert.equal(win().hasinoBack(), 'handled');
    assert.equal(browser.hash, '#/home');
  });

  it('sends a deep link home rather than quitting', () => {
    // The app opened straight onto a shared salon link: nothing to go back
    // through, but quitting is not what back means here either.
    const deep = fakeBrowser('#/salon/shared');
    installBackHandler({
      isRoot: () => deep.hash === '#/home',
      homeHash: '#/home',
      dismissOverlay: () => false,
    });

    assert.equal(win().hasinoBack(), 'handled');
    assert.equal(deep.hash, '#/home');
    // Home was reached by replacing the entry, not stacking one, so the next
    // press is the last one.
    assert.equal(win().hasinoBack(), 'exit');
  });

  it('the app\u2019s own Back control is a retreat, not another step forward', () => {
    // The login page has a Back button, and it moves through router.back().
    // A bare history.back() would fire a hashchange that looks identical to a
    // forward move from in here — so the count would go up, and the system
    // back button would then believe there were more app screens behind it
    // than there are and walk out past this document's first entry.
    browser.navigate('#/login');
    browser.appBack();
    assert.equal(browser.hash, '#/home', 'it went back');
    assert.equal(win().hasinoBack(), 'exit', 'and nothing is left to walk back through');
  });

  it('several of them in a row still leave the count honest', () => {
    browser.navigate('#/explore');
    browser.navigate('#/bookings');
    browser.appBack();
    browser.appBack();
    assert.equal(browser.hash, '#/home');
    assert.equal(win().hasinoBack(), 'exit');
  });

  it('does not deepen the stack on the way back', () => {
    browser.navigate('#/explore');
    browser.navigate('#/bookings');
    win().hasinoBack();
    win().hasinoBack();
    assert.equal(browser.hash, '#/home');
    assert.equal(win().hasinoBack(), 'exit', 'the presses that went back must not count as forward moves');
  });
});

describe('back button — the native shell is wired to ask', () => {
  const mainActivity = read('android/app/src/main/java/com/hasino/app/MainActivity.java');

  it('registers a back callback instead of letting the Activity finish', () => {
    assert.match(mainActivity, /OnBackPressedCallback/);
    assert.match(mainActivity, /getOnBackPressedDispatcher\(\)\.addCallback\(this, backCallback\)/);
  });

  it('asks the page first', () => {
    assert.match(mainActivity, /window\.hasinoBack/);
    assert.match(mainActivity, /evaluateJavascript/);
  });

  it('falls back to WebView history when the page does not answer', () => {
    // Without this the fix would depend on the deployed site being new enough,
    // and an old cached page would trap the user in the app.
    assert.match(mainActivity, /canGoBack\(\)/);
    assert.match(mainActivity, /goBack\(\)/);
  });

  it('the module is actually served', () => {
    // loadAssets() takes an explicit allowlist. A module missing from it 404s
    // at import time and takes the whole page down with it — a back-button fix
    // that blanks the app is worse than the bug.
    assert.match(read('src/http/server.ts'), /'lib\/backbutton\.js'/);
  });

  it('is installed on both the customer app and the salon panel', () => {
    for (const file of ['src/http/public/app.js', 'src/http/public/business.js']) {
      const source = read(file);
      assert.match(source, /installBackHandler\(/, `${file} must install the back handler`);
      assert.match(source, /from '\.\/lib\/backbutton\.js'/, `${file} must import it`);
    }
  });
});
