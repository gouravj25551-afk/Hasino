import { el } from '../lib/dom.js';
import { Avatar } from '../components/Avatar.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/EmptyState.js';
import { currentTheme, toggleTheme } from '../lib/theme.js';

/**
 * What this account's salon is, if anything.
 *
 * One section with five states rather than one link with a changing label,
 * because they are genuinely different things: an invitation, an application
 * in progress, a refusal, a live salon, and a suspended one. Showing "list
 * your salon" to someone who applied last week — or to an approved owner —
 * is the version of this that reads as the product having forgotten them.
 *
 * Approval is what turns the invitation into a dashboard. Nothing here can
 * grant it; the server decides and this only reports.
 */
function salonSection(app, session) {
  const panel = el('div', 'panel');
  const salon = session.salon;

  // Approved. role and salon.status move together — changeSalonStatus sets
  // both in one transaction — but the dashboard is offered on the role, which
  // is what /api/business/* actually checks.
  if (session.role === 'business' && salon) {
    panel.append(el('h2', null, 'My Salon'));
    panel.append(el('div', null, salon.name));
    if (salon.status !== 'active') {
      panel.append(el('div', 'note',
        salon.status === 'suspended'
          ? 'Suspended — not taking bookings. Contact Hasino support.'
          : `Status: ${salon.status}.`));
    }
    const open = el('a', 'btn primary', 'Open Salon Dashboard');
    open.href = '/business';
    panel.append(open);
    return panel;
  }

  if (salon?.status === 'pending') {
    panel.append(el('h2', null, 'Salon Application'));
    panel.append(el('div', null, salon.name));
    panel.append(el('div', 'pill warn', '⏳ Under review'));
    panel.append(el('div', 'note',
      'A Hasino admin is reviewing it. Your salon dashboard unlocks as soon as it is approved.'));
    return panel;
  }

  if (salon?.status === 'rejected') {
    panel.append(el('h2', null, 'Salon Application'));
    panel.append(el('div', null, salon.name));
    panel.append(el('div', 'pill bad', 'Not approved'));
    panel.append(el('div', 'note',
      'You can update the details and submit it again — it goes back for review.'));
    const again = Button({ label: 'View / reapply', onClick: () => app.navigate('#/apply') });
    panel.append(again);
    return panel;
  }

  // Never applied.
  panel.append(el('h2', null, 'Become a Hasino Salon'));
  panel.append(el('p', 'sub',
    'Take bookings from customers near you. Applications are reviewed by a Hasino admin.'));
  panel.append(Button({
    label: 'Apply as a Salon',
    variant: 'primary',
    onClick: () => app.navigate('#/apply'),
  }));
  return panel;
}

export function renderProfile(container, app) {
  const session = app.requireSession();
  if (!session) return;
  container.innerHTML = '';

  container.append(el('h1', null, 'Profile'));

  // Who you are, stated once and quietly. The name is the header's job now —
  // it sits in the account menu in the top-right corner, where an account
  // belongs — so this is a line of detail rather than a banner with the
  // customer's own name across the middle of the screen.
  const card = el('div', 'profile-header-card');
  card.append(Avatar({ src: session.avatarUrl, name: session.name }));
  const info = el('div', 'profile-info');
  info.append(el('div', null, session.name || 'Customer'));
  info.append(el('p', 'meta', [session.email, session.phone].filter(Boolean).join(' · ') || 'Signed in'));
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

  // The same switch as the one in the account menu, for someone who came
  // looking for it under settings. Both read and write lib/theme.js, so
  // whichever is used, the other is right the next time it is drawn.
  const theme = el('div', 'item');
  const themeLabel = el('div', 'grow');
  const themeValue = el('span', 'pill brand');
  const paintTheme = () => {
    const dark = currentTheme() === 'dark';
    themeLabel.textContent = '🌗 Appearance';
    themeValue.textContent = dark ? 'Dark' : 'Light';
  };
  paintTheme();
  theme.style.cursor = 'pointer';
  theme.onclick = () => { toggleTheme(); paintTheme(); };
  theme.append(themeLabel, themeValue);
  list.append(theme);

  container.append(list);

  // The salon story, whatever stage it is at. There is deliberately no admin
  // entry: the admin panel is a separate private process, not a page of this
  // app, and an operator opens it on their own machine.
  container.append(salonSection(app, session));

  container.append(
    Button({
      label: 'Sign out',
      variant: 'danger',
      onClick: () => app.signOut(),
    }),
  );
}
