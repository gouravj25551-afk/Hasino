/**
 * Android's system back button, for a web app that lives inside a WebView.
 *
 * Why this exists
 * ---------------
 * Capacitor's BridgeActivity does not handle back at all: the press reaches
 * the Activity's default handler and the Activity finishes. So every back
 * press quit the app — from a salon page, from checkout, from a half-filled
 * form, with an open confirmation dialog on screen. On Android that is not a
 * quirk, it is the app being broken, because back is how people navigate.
 *
 * The decision belongs here rather than in Java because only this side knows
 * what is on screen. A native `webView.canGoBack()` cannot tell an open modal
 * from a page, and it cannot tell the home route from a nested one. So the
 * shell asks, and this answers:
 *
 *   'handled' — something was closed or navigated; stay in the app
 *   'exit'    — nowhere left to go back to; the shell may finish the Activity
 *
 * Anything else (an exception, an older shell, this file not loaded yet) makes
 * the shell fall back to its own canGoBack/finish behaviour, so a failure here
 * degrades to the platform default rather than trapping the user in the app.
 *
 * In a desktop browser nothing calls window.hasinoBack and the browser's own
 * Back button keeps working exactly as before — this adds a hook, it does not
 * intercept navigation.
 */

/**
 * Close the topmost open overlay, if there is one.
 *
 * Done by clicking the backdrop rather than removing the node: that is the
 * path Modal, BottomSheet and dialog.js already treat as "dismissed", so the
 * dialog's promise resolves to null and its keydown listener is removed. A
 * yanked-out node would leave a caller awaiting a promise that never settles.
 */
function dismissTopOverlay() {
  const backdrops = document.querySelectorAll('.modal-backdrop');
  const top = backdrops[backdrops.length - 1];
  if (!top) return false;
  top.click();
  return true;
}

/**
 * @param {object} options
 * @param {() => boolean} options.isRoot   is the current route the app's home?
 * @param {string} options.homeHash        where "home" is, for a deep link with no history
 * @param {() => boolean} [options.dismissOverlay]
 */
export function installBackHandler({ isRoot, homeHash, dismissOverlay = dismissTopOverlay }) {
  /**
   * History entries this document has added since it loaded.
   *
   * Counted rather than read off `history.length`, which in a WebView also
   * includes entries from before this document and cannot be trusted to say
   * how far back we may go without leaving the app — or worse, landing on a
   * consumed OAuth callback URL. Counting from zero means history.back() can
   * only ever retrace steps this page took.
   */
  let depth = 0;

  /** Hash changes we caused, which must not be counted as new entries. */
  let expected = 0;

  window.addEventListener('hashchange', () => {
    if (expected > 0) {
      expected--;
      return;
    }
    depth++;
  });

  // A redirect that replaced the current entry rather than adding one — the
  // router's replace(), used when a protected route sends someone to sign in
  // and when the login page sends them on afterwards. The hashchange it
  // causes is not a step forward, and counting it as one would leave a press
  // going back to an entry the browser no longer has.
  window.addEventListener('hasino:replace', () => {
    expected++;
  });

  window.hasinoBack = () => {
    // A dialog on screen is what back closes first. Navigating out from under
    // an open confirmation would look like the app ignored the press.
    if (dismissOverlay()) return 'handled';

    // Retrace this document's own history: Home -> Salon -> Checkout walks
    // back one screen per press, exactly like a browser.
    if (depth > 0) {
      depth--;
      expected++;
      history.back();
      return 'handled';
    }

    // No history, but not at home either — the app was opened straight onto
    // this page (a shared salon link, the OAuth return, a redirect on launch).
    // Home is the meaningful "back" there; quitting is not.
    if (!isRoot()) {
      expected++;
      location.replace(homeHash);
      return 'handled';
    }

    return 'exit';
  };
}
