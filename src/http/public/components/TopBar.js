import { el } from '../lib/dom.js';
import { Avatar } from './Avatar.js';
import { Button } from './Button.js';

/**
 * The panel a signed-in user is entitled to, or null for a plain customer.
 *
 * Showing this is a convenience, not a permission check — /admin and /business
 * are public shells and every byte of data behind them is authorised
 * server-side on each request. Hiding the link protects nothing; it just keeps
 * a door out of sight of the people it would only 403 for.
 *
 * Roles do not nest (see requireRole in src/auth/session.ts), so an admin gets
 * the admin panel and nothing else — /business would find no salon they own.
 */
function panelFor(role) {
  if (role === 'admin') return { href: '/admin', label: 'Admin' };
  if (role === 'business') return { href: '/business', label: 'Salon panel' };
  return null;
}

/**
 * `user` is a Session shape ({name, email, avatarUrl, role}) or null when
 * signed out. `onLocationClick` is a no-op hook — there is no real location
 * search yet, only the label the customer flow already shows.
 */
export function TopBar({ user, locationLabel = 'Bengaluru', onLocationClick, onSignIn } = {}) {
  const bar = el('div', 'topbar');

  const logo = el('a', 'lockup');
  logo.href = '#/home';
  logo.innerHTML = '<span class="wordmark">has<span class="i">i</span>no</span>';
  bar.append(logo);

  const location = el('div', 'location-chip');
  location.innerHTML = `📍 <b>${locationLabel}</b> ▾`;
  if (onLocationClick) location.onclick = onLocationClick;
  bar.append(location);

  const nav = el('nav', 'desktop-nav');
  nav.innerHTML = `
    <a href="#/home" data-nav="home">Home</a>
    <a href="#/explore" data-nav="explore">Explore</a>
    <a href="#/bookings" data-nav="bookings">My Bookings</a>
  `;
  bar.append(nav);

  bar.append(el('span', 'spacer'));

  const widget = el('div', 'row');
  if (user) {
    // Sits next to the avatar so it is reachable from every customer page.
    // Both panels link back with "← Customer app", closing the round trip.
    const panel = panelFor(user.role);
    if (panel) {
      const panelLink = el('a', 'btn sm', panel.label);
      panelLink.href = panel.href;
      widget.append(panelLink);
    }

    const link = el('a', 'row');
    link.href = '#/profile';
    link.style.textDecoration = 'none';
    link.style.color = 'inherit';
    link.append(Avatar({ src: user.avatarUrl, name: user.name }), el('span', null, user.name || 'You'));
    widget.append(link);
  } else {
    widget.append(Button({ label: 'Sign in', variant: 'primary', size: 'sm', onClick: onSignIn }));
  }
  bar.append(widget);

  return bar;
}

/** Call after inserting the bar (or on every route change) to reflect the active section. */
export function highlightTopBarNav(bar, section) {
  for (const a of bar.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === section) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}
