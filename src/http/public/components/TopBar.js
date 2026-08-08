import { el } from '../lib/dom.js';
import { Avatar } from './Avatar.js';
import { Button } from './Button.js';

/**
 * `user` is a Session shape ({name, email, avatarUrl}) or null when signed
 * out. `onLocationClick` is a no-op hook — there is no real location search
 * yet, only the label the customer flow already shows.
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
