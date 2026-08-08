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
