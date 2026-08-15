/**
 * Light and dark, chosen by the person using the app.
 *
 * The stylesheet already had a dark palette behind
 * `@media (prefers-color-scheme: dark)`, so the device decided and the customer
 * had no say. This adds the say without throwing that away:
 *
 *   nothing stored  -> whatever the device says, and it keeps following it
 *   'light'/'dark'  -> that, on every device, until they change it back
 *
 * The choice is written to `data-theme` on <html>, which is what brand.css
 * keys the explicit palettes off. It is applied before the first paint (this
 * module is imported at the top of app.js) so there is no flash of the wrong
 * theme on launch — which matters most in the Android app, where launching is
 * something people do many times a day.
 */

const STORAGE_KEY = 'hasino.theme';

/** @returns {'light'|'dark'|null} the stored preference, or null for "follow the device" */
export function storedTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    // Private mode, or a WebView with storage disabled. The app still works;
    // it just cannot remember, so it follows the device.
    return null;
  }
}

export function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** What is on screen right now, whether or not it was chosen. */
export function currentTheme() {
  return storedTheme() ?? systemTheme();
}

function apply(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // So form controls, scrollbars and the WebView's own background follow too —
  // without this the browser paints white behind a dark page during scroll
  // overshoot.
  document.documentElement.style.colorScheme = theme;
}

const listeners = new Set();

/** Called with the new theme whenever it changes. Returns an unsubscribe. */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not remembered, but still applied for this session.
  }
  apply(next);
  for (const fn of listeners) fn(next);
  return next;
}

export function toggleTheme() {
  return setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

/**
 * Apply the theme this app should be showing. Call once, as early as possible.
 *
 * When nothing is stored the device's setting is applied *and followed*: a
 * phone that switches to dark at sunset takes the app with it, which is what
 * someone who has never touched the toggle expects.
 */
export function initTheme() {
  apply(currentTheme());
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', (e) => {
    if (storedTheme() !== null) return; // they chose; the device does not overrule them
    const next = e.matches ? 'dark' : 'light';
    apply(next);
    for (const fn of listeners) fn(next);
  });
}
