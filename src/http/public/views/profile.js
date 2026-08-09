import { el } from '../lib/dom.js';
import { Avatar } from '../components/Avatar.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/EmptyState.js';

export function renderProfile(container, app) {
  const session = app.requireSession();
  if (!session) return;
  container.innerHTML = '';

  container.append(el('h1', null, 'Profile'));

  const card = el('div', 'profile-header-card');
  card.append(Avatar({ src: session.avatarUrl, name: session.name, size: 'lg' }));
  const info = el('div', 'profile-info');
  info.append(el('h2', null, session.name || 'Customer'));
  info.append(el('p', null, [session.email, session.phone].filter(Boolean).join(' · ') || 'Signed in'));
  card.append(info);
  container.append(card);

  const list = el('div', 'list');
  const bookingsLink = el('a', 'item', '📅 My bookings');
  bookingsLink.href = '#/bookings';
  bookingsLink.style.cssText = 'text-decoration:none; color:inherit';
  list.append(bookingsLink);

  const notifications = el('div', 'item', '🔔 Notifications');
  notifications.onclick = () => notifications.replaceWith(EmptyState({ title: 'No notifications yet.' }));
  list.append(notifications);

  list.append(el('div', 'item', '⚙️ Account settings — coming soon'));

  // Salon owners already have a salon; sending them here would only 409.
  if (session.role === 'business') {
    const panel = el('a', 'item', '💈 My salon panel');
    panel.href = '/business';
    panel.style.cssText = 'text-decoration:none; color:inherit';
    list.append(panel);
  } else if (session.role === 'customer') {
    const apply = el('div', 'item', '💈 List your salon on Hasino');
    apply.style.cursor = 'pointer';
    apply.onclick = () => app.navigate('#/apply');
    list.append(apply);
  }

  container.append(list);

  container.append(
    Button({
      label: 'Sign out',
      variant: 'danger',
      onClick: () => app.signOut(),
    }),
  );
}
