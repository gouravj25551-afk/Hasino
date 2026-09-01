import { el } from '../lib/dom.js';
import { iconEl, hasIcon } from '../lib/icons.js';

/**
 * An empty screen is where a product either explains itself or looks broken.
 *
 * The old version rendered one line of grey text in a dashed box, which reads
 * as "something failed" rather than "there is nothing here yet". This takes an
 * icon, a title, an optional sentence of context and the action that resolves
 * the emptiness.
 *
 * `title` alone still works — every existing caller passes exactly that and
 * keeps rendering, just better.
 */
export function EmptyState({ title, body, icon = 'inbox', action, onAction } = {}) {
  const box = el('div', 'empty-state');
  // `icon` is a name from the icon set (lib/icons.js). Anything unknown — a
  // stray glyph a caller still passes — falls back to rendering as text, so no
  // caller breaks while the set fills in.
  if (icon) {
    const wrap = el('div', 'empty-icon');
    if (hasIcon(icon)) wrap.append(iconEl(icon, { size: 24 }));
    else wrap.textContent = icon;
    box.append(wrap);
  }
  box.append(el('div', 'empty-title', title));
  if (body) box.append(el('div', 'empty-body', body));
  if (action && onAction) {
    const btn = el('button', 'btn primary', action);
    btn.onclick = onAction;
    box.append(btn);
  }
  return box;
}

/**
 * The salon grid with nothing in it.
 *
 * Discovery is filtered to one city and there is no fallback behind it, so
 * "no salons" is a normal, permanent-feeling state for a city Hasino has not
 * reached yet — not an error and not a blank screen. It names the city,
 * because "no salons found" next to a header reading Jind leaves the customer
 * wondering whether the app is broken or the town is empty.
 *
 * `filtered` separates the two ways a city comes back empty: a search or
 * category that matched nothing here, which a different search fixes, and a
 * city with no salons at all, which nothing the customer does will fix. The
 * second is the one that gets the "we're working on it" line; offering it for
 * a misspelled search would be a non-sequitur.
 */
export function NoSalonsState({ city, filtered = false, onClear } = {}) {
  if (filtered) {
    return EmptyState({
      icon: 'search',
      title: city ? `Nothing matches that search in ${city}.` : 'Nothing matches that search.',
      body: city ? `Try another service or salon name — you're browsing ${city}.` : undefined,
      ...(onClear ? { action: 'Clear search', onAction: onClear } : {}),
    });
  }
  return EmptyState({
    icon: 'pin',
    title: city ? `No salons available in ${city} yet.` : 'No salons available yet.',
    body: "We're working on bringing more salons to your area.",
  });
}
