/** Hash router. Views register a pattern + handler; nothing here knows what a view is. */

const routes = [];
let fallback = '#/home';

export function register(pattern, handler) {
  routes.push([pattern, handler]);
}

export function setFallback(hash) {
  fallback = hash;
}

export function currentHash() {
  return location.hash || fallback;
}

/** The top-level path segment, for nav highlighting: "#/salon/123" -> "salon". */
export function activeSection() {
  return currentHash().replace(/^#\//, '').split('/')[0] || '';
}

async function dispatch() {
  const hash = currentHash();
  for (const [pattern, handler] of routes) {
    const m = hash.match(pattern);
    if (m) return handler(...m.slice(1));
  }
  location.hash = fallback;
}

let lastOnError = null;

/** Wires hashchange and runs the first route. `onError` sees any handler rejection. */
export function start(onError) {
  lastOnError = onError;
  const run = () => Promise.resolve(dispatch()).catch((err) => onError?.(err));
  window.addEventListener('hashchange', run);
  return run();
}

/** Re-runs the current route's handler without changing the hash (e.g. after switching identity). */
export function reload() {
  return Promise.resolve(dispatch()).catch((err) => lastOnError?.(err));
}

export function go(hash) {
  location.hash = hash;
}

/**
 * Go somewhere *instead of* here, rather than after here.
 *
 * `location.hash = ...` pushes a history entry, which is right for a link and
 * wrong for a redirect: a protected route that bounced the visitor to sign in
 * must not sit behind the login page, or Back lands on it and it bounces them
 * forward again — the loop this exists to remove. Same for the login page
 * itself once the sign-in succeeds.
 *
 * The event tells lib/backbutton.js that this movement replaced a step
 * instead of adding one, so Android's back button does not have to walk
 * through entries that are no longer there.
 */
export function replace(hash) {
  if (currentHash() === hash) return;
  window.dispatchEvent(new Event(REPLACED_EVENT));
  location.replace(hash);
}

/** Dispatched just before a history-replacing navigation. */
export const REPLACED_EVENT = 'hasino:replace';

/** Dispatched just before the app walks its own history backwards. */
export const RETREAT_EVENT = 'hasino:back';

/**
 * Go back one entry, the way the app's own Back controls do.
 *
 * `history.back()` on its own is not enough. lib/backbutton.js counts the
 * entries this document has pushed so it can tell Android's system back button
 * how far it may retrace, and it learns about movement from `hashchange` — in
 * which a retreat and an advance look identical. So a Back button that called
 * history.back() directly was counted as a step *forward*, and the system back
 * button then believed there were more app screens behind it than there were,
 * walking past the app's own first entry.
 *
 * The event is what tells it otherwise. In a desktop browser nothing listens
 * and this is exactly history.back().
 *
 * `fallbackHash` is where to go when there is no history to walk — the app was
 * opened straight onto this screen. Replaced rather than pushed, so the next
 * press does not come back here.
 */
export function back(fallbackHash) {
  if (window.history.length > 1) {
    window.dispatchEvent(new Event(RETREAT_EVENT));
    window.history.back();
    return;
  }
  if (fallbackHash) replace(fallbackHash);
}
