import { el } from '../lib/dom.js';

const ITEMS = [
  { key: 'home', label: 'Home', hash: '#/home', icon: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z' },
  {
    key: 'explore',
    label: 'Explore',
    hash: '#/explore',
    icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
  },
  {
    key: 'bookings',
    label: 'Bookings',
    hash: '#/bookings',
    icon: 'M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z',
  },
  {
    key: 'profile',
    label: 'Profile',
    hash: '#/profile',
    icon: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  },
];

export function BottomNav(activeKey) {
  const nav = el('div', 'bottom-nav');
  for (const item of ITEMS) {
    const a = el('a', 'nav-item' + (item.key === activeKey ? ' active' : ''));
    a.href = item.hash;
    a.innerHTML = `<svg viewBox="0 0 24 24"><path d="${item.icon}"/></svg><span>${item.label}</span>`;
    nav.append(a);
  }
  return nav;
}
