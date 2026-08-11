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

  // One entry per role. Admin used to fall through both branches and get
  // nothing, which left the admin panel with no link anywhere in the app.
  const panelItem = (label, href) => {
    const a = el('a', 'item', label);
    a.href = href;
    a.style.cssText = 'text-decoration:none; color:inherit';
    return a;
  };

  if (session.role === 'admin') {
    list.append(panelItem('🛡️ Admin dashboard', '/admin'));
  } else if (session.role === 'business') {
    // Salon owners already have a salon; sending them to apply would only 409.
    list.append(panelItem('💈 My salon panel', '/business'));
  } else {
    // A customer who has already applied gets the state of that application,
    // not an invitation to apply again. Applying creates the salon, so the
    // second attempt is a 409 either way.
    const pending = session.salon?.status === 'pending';
    const label = pending
      ? '💈 Salon application — under review'
      : session.salon?.status === 'rejected'
        ? '💈 Salon application — not approved'
        : '💈 List your salon on Hasino';
    const apply = el('div', 'item', label);
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
