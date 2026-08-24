/**
 * Saved salons, in one place.
 *
 * The endpoints already existed — GET/POST /api/me/favorites and
 * DELETE /api/me/favorites/:id — and the salon page was fetching the whole
 * list for itself on every open, while the discovery cards had no way to save
 * at all. Two hearts for the same salon on the same screen (a card and the
 * detail page reached from it) have to agree, and a list refetched per card
 * would be one request per salon.
 *
 * So: one cache of ids, filled once per signed-in session, written through on
 * every toggle, and a subscription so every heart showing that salon repaints
 * when any of them is pressed. Nothing is stored locally — the server is the
 * record, which is what makes the state survive a refresh and follow the
 * customer to another device.
 */
import { api } from './api.js';

/** Salon ids the signed-in customer has saved, or null before the first load. */
let saved = null;
let inflight = null;

const listeners = new Set();

/** Called with (salonId, isSaved) whenever a favorite changes anywhere. */
export function onFavoritesChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce(salonId, isSaved) {
  for (const fn of [...listeners]) fn(salonId, isSaved);
}

/**
 * Load the saved list once. Safe to call from several views at once — the
 * second caller joins the request the first one started.
 *
 * Callers pass `signedIn: false` for a visitor with no session: there is
 * nothing to fetch, and asking would 401 on every page load.
 */
export async function loadFavorites({ signedIn = true, force = false } = {}) {
  if (!signedIn) {
    replaceAll(new Set());
    return saved;
  }
  if (saved && !force) return saved;
  inflight ??= api('/api/me/favorites')
    .then(({ salonIds }) => {
      replaceAll(new Set(salonIds ?? []));
      return saved;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Swap the whole list, telling every heart on screen what changed.
 *
 * This is what makes a session that arrives *after* a screen has painted
 * correct rather than merely eventually correct: Clerk restores
 * asynchronously, so the home grid is often drawn before the app knows who is
 * looking at it, and without this every heart on it would stay an outline
 * until the customer navigated somewhere else.
 */
function replaceAll(next) {
  const before = saved ?? new Set();
  saved = next;
  for (const id of before) if (!next.has(id)) announce(id, false);
  for (const id of next) if (!before.has(id)) announce(id, true);
}

export function isFavorite(salonId) {
  return saved?.has(salonId) ?? false;
}

/** True once the list has been fetched; until then every heart is an outline. */
export function favoritesLoaded() {
  return saved !== null;
}

/**
 * Write one salon's saved state through to the server.
 *
 * The cache is updated only after the request succeeds, so a failed save
 * cannot leave a filled heart standing for a salon the server never recorded.
 * The caller paints optimistically and reverts on the rejection.
 */
export async function setFavorite(salonId, next) {
  if (next) {
    await api('/api/me/favorites', { method: 'POST', body: JSON.stringify({ salonId }) });
  } else {
    await api(`/api/me/favorites/${salonId}`, { method: 'DELETE' });
  }
  saved ??= new Set();
  if (next) saved.add(salonId);
  else saved.delete(salonId);
  announce(salonId, next);
  return next;
}

export function toggleFavorite(salonId) {
  return setFavorite(salonId, !isFavorite(salonId));
}

/**
 * Signing out ends the list: the next account's saves are not this one's, and
 * every heart still on screen goes back to an outline as it happens.
 */
export function forgetFavorites() {
  replaceAll(new Set());
  saved = null;
}
