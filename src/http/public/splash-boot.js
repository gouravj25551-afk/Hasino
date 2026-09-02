/*
 * Runs before app.js, as a classic (non-module) script so it executes during
 * head parsing — before the first paint and before the module graph loads. It
 * does three things the splash needs done that early, none of which can be an
 * inline script or handler because the app's CSP is `script-src 'self'` with no
 * 'unsafe-inline':
 *
 *   1. Applies the stored theme, so the splash paints in the right colour on
 *      launch instead of flashing the wrong one (mirrors lib/theme.js).
 *   2. Wires the retry button by delegation, so it works even when app.js is
 *      the thing that failed to load.
 *   3. Arms a watchdog: if the splash is still up after a while, turn it into a
 *      retry rather than a screen the user is stuck on. app.js clears it the
 *      instant it takes over.
 *
 * It adds no delay of its own — every branch is synchronous or a one-shot
 * timeout that only matters if the app never starts.
 */
(function () {
  try {
    var t = localStorage.getItem('hasino.theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute('data-theme', t);
      document.documentElement.style.colorScheme = t;
    }
  } catch (e) {
    // Private mode / storage disabled: fall through to the device theme, which
    // brand.css already follows via prefers-color-scheme.
  }

  // Delegated, because the button is parsed after this script runs and app.js
  // may never get the chance to bind it.
  document.addEventListener('click', function (e) {
    var el = e.target;
    if (el && el.closest && el.closest('#splash-error button')) location.reload();
  });

  window.__hasinoSplashWatchdog = setTimeout(function () {
    var s = document.getElementById('splash');
    if (s && !s.classList.contains('is-hiding')) s.classList.add('has-error');
  }, 12000);
})();
