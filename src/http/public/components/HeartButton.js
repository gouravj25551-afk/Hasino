import { el } from '../lib/dom.js';
import { isFavorite, onFavoritesChanged, setFavorite } from '../lib/favorites.js';

/**
 * The heart: one shape, two states, and the same save behind both.
 *
 * An outline heart is "not saved" and a filled red one is "saved" — the pair
 * people already read everywhere else, which is why this replaced the "♡ Save"
 * / "♥ Saved" text buttons rather than sitting beside them. There is exactly
 * one save path in the app (lib/favorites.js, over the endpoints that already
 * existed), so a heart on a card and a heart on that salon's page are two
 * views of one fact and repaint together.
 *
 * On a card the heart sits *on* the photo, over a link that opens the salon.
 * Every event a press produces is stopped here — click, and the pointerdown /
 * keydown that a card also listens for — so saving never opens the salon by
 * accident.
 *
 * `onRequireSignIn` is what a signed-out visitor gets instead of a request
 * that would 401: the same heart, and a trip to the login page.
 */
export function HeartButton(salonId, {
  saved = null,
  signedIn = true,
  onRequireSignIn,
  onChange,
  label = 'salon',
  size = '',
} = {}) {
  const btn = el('button', ['heart-btn', size].filter(Boolean).join(' '));
  btn.type = 'button';
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<path d="M12 20.7 3.6 12.3a5.1 5.1 0 0 1 0-7.2 5.1 5.1 0 0 1 7.2 0l1.2 1.2 1.2-1.2a5.1 5.1 0 0 1 7.2 0 5.1 5.1 0 0 1 0 7.2Z"/>'
    + '</svg>';

  let on = saved ?? isFavorite(salonId);

  const paint = (next, { animate = false } = {}) => {
    on = next;
    btn.classList.toggle('is-saved', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? `Remove ${label} from saved` : `Save ${label}`);
    btn.title = on ? 'Saved' : 'Save';
    if (!animate) return;
    // Restart the pop rather than waiting out the previous one: a customer
    // tapping twice should see two taps.
    btn.classList.remove('pop');
    void btn.offsetWidth;
    btn.classList.add('pop');
  };
  paint(on);

  // Another heart for the same salon — the card behind this page, or a second
  // card in a list — pressed elsewhere.
  const stop = onFavoritesChanged((id, nowSaved) => {
    if (id !== salonId) return;
    if (!btn.isConnected) {
      stop();
      return;
    }
    if (nowSaved !== on) paint(nowSaved);
  });

  // The card underneath is a link and listens for these too.
  const swallow = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  });

  btn.onclick = async (e) => {
    swallow(e);
    if (!signedIn) {
      onRequireSignIn?.();
      return;
    }
    const next = !on;
    // Optimistic: the tap should feel instant. The revert below is what keeps
    // that honest when the request does not land.
    paint(next, { animate: next });
    btn.disabled = true;
    try {
      await setFavorite(salonId, next);
      onChange?.(next);
    } catch (err) {
      paint(!next);
      onChange?.(!next, err);
    } finally {
      btn.disabled = false;
    }
  };

  btn.setSaved = (next) => paint(next);
  return btn;
}
