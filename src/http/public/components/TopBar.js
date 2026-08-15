import { el } from '../lib/dom.js';
import { Avatar } from './Avatar.js';
import { Button } from './Button.js';
import { currentTheme, toggleTheme } from '../lib/theme.js';

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
 * Who you are, and the handful of things that belong to being you.
 *
 * One control in the top-right corner rather than a name printed across the
 * page: sign-out, the theme, and the way to your profile are all account
 * business, and account business lives where people look for it. On a phone
 * the trigger narrows to the avatar alone — the name is inside, where there is
 * room for it.
 */
function AccountMenu({ user, onSignOut }) {
  const root = el('div', 'account');

  const trigger = el('button', 'account-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', `Account: ${user.name || 'signed in'}`);
  trigger.append(
    Avatar({ src: user.avatarUrl, name: user.name }),
    el('span', 'account-name', user.name || 'You'),
    el('span', null, '▾'),
  );
  root.append(trigger);

  let menu = null;

  const close = () => {
    menu?.remove();
    menu = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('keydown', onKey);
  };

  // Capture phase: the menu must close on a click anywhere, including on a
  // link that is about to navigate.
  const onDocumentClick = (e) => {
    if (!root.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  const open = () => {
    menu = el('div', 'account-menu');
    menu.setAttribute('role', 'menu');

    const who = el('div', 'who');
    who.append(el('div', 'name', user.name || 'Signed in'));
    if (user.email) who.append(el('div', 'sub', user.email));
    menu.append(who);

    const profile = el('a', null, 'Profile');
    profile.href = '#/profile';
    profile.setAttribute('role', 'menuitem');
    profile.onclick = close;
    menu.append(profile);

    const bookings = el('a', null, 'My bookings');
    bookings.href = '#/bookings';
    bookings.setAttribute('role', 'menuitem');
    bookings.onclick = close;
    menu.append(bookings);

    const panel = panelFor(user.role);
    if (panel) {
      const link = el('a', null, panel.label);
      link.href = panel.href;
      link.setAttribute('role', 'menuitem');
      menu.append(link);
    }

    // The theme lives here because this is where "settings" are on a screen
    // that has no settings page. It says what it will do, not what it is.
    const themeItem = el('button', null);
    themeItem.type = 'button';
    themeItem.setAttribute('role', 'menuitem');
    const paintTheme = () => {
      themeItem.innerHTML = '';
      const dark = currentTheme() === 'dark';
      themeItem.append(
        el('span', null, dark ? '☀️ Light mode' : '🌙 Dark mode'),
        el('span', 'value', dark ? 'Dark' : 'Light'),
      );
    };
    paintTheme();
    themeItem.onclick = (e) => {
      e.stopPropagation();
      toggleTheme();
      paintTheme();
    };
    menu.append(themeItem);

    const out = el('button', 'danger', 'Sign out');
    out.type = 'button';
    out.setAttribute('role', 'menuitem');
    out.onclick = () => {
      close();
      onSignOut?.();
    };
    menu.append(out);

    root.append(menu);
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', onKey);
  };

  trigger.onclick = (e) => {
    e.stopPropagation();
    menu ? close() : open();
  };

  return root;
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
export function TopBar({ user, locationLabel, onLocationClick, onSignIn, onSignOut } = {}) {
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

  if (user) {
    bar.append(AccountMenu({ user, onSignOut }));
  } else {
    const widget = el('div', 'account');
    widget.append(Button({ label: 'Sign in', variant: 'primary', size: 'sm', onClick: onSignIn }));
    bar.append(widget);
  }

  return bar;
}

/** Call after inserting the bar (or on every route change) to reflect the active section. */
export function highlightTopBarNav(bar, section) {
  for (const a of bar.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === section) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}
