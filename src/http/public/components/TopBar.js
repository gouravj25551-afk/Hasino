import { el } from '../lib/dom.js';
import { Avatar } from './Avatar.js';
import { Button } from './Button.js';

/**
 * The salon panel link, for an approved owner.
 *
 * There is deliberately no admin link. The admin panel is not part of this
 * application — it is a separate process on the operator's own machine, bound
 * to loopback, and this app has no route to it. See src/http/admin-server.ts.
 */
function panelFor(role) {
  if (role === 'business') return { href: '/business', label: 'Salon panel' };
  return null;
}

/**
 * `user` is a Session shape ({name, email, avatarUrl, role}) or null when
 * signed out.
 *
 * locationLabel has no default city. It used to read 'Bengaluru' for
 * everybody, which told a customer in Sonipat they were somewhere else and
 * made the chip look like a fact rather than a choice. With nothing chosen it
 * invites one.
 */
export function TopBar({ user, locationLabel, onLocationClick, onSignIn } = {}) {
  const bar = el('div', 'topbar');

  const logo = el('a', 'lockup');
  logo.href = '#/home';
  logo.innerHTML = '<span class="wordmark">has<span class="i">i</span>no</span>';
  bar.append(logo);

  const location = el('div', 'location-chip');
  location.append(document.createTextNode('📍 '));
  // textContent, not innerHTML: this string comes from a geocoder, and a
  // place name is not markup.
  location.append(Object.assign(el('b'), { textContent: locationLabel || 'Select location' }));
  location.append(document.createTextNode(' ▾'));
  location.title = locationLabel ? 'Change location' : 'Choose your location';
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
