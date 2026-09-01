import { el } from '../lib/dom.js';
import { Avatar } from '../components/Avatar.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/EmptyState.js';
import { currentTheme, toggleTheme } from '../lib/theme.js';
import { dateLong } from '../lib/format.js';
import { iconEl } from '../lib/icons.js';

/**
 * The state of this account's salon request, for an account that has one.
 *
 * There is deliberately no invitation here any more. "Become a Hasino Salon"
 * sat on every customer's profile page and was the main way anyone reached the
 * application form — which is exactly what a customer should not be offered:
 * a customer account is a customer account, and listing a salon is a separate
 * thing a person chooses to start from outside the customer app (the sign-in
 * screen's "List your salon"). Removing it here is not a cosmetic change; the
 * form and the API behind it are unchanged and still refuse to grant anyone
 * anything without an admin.
 *
 * What remains is the state of a request this account already made, which is
 * the customer's own business and the only place they can see it: pending,
 * turned down, or approved. Returns null when there is nothing to report,
 * and the caller renders no section at all.
 */
function salonSection(app, session) {
  const salon = session.salon;
  // A plain customer with no request. Nothing about salons belongs on their
  // profile — not a panel, not a heading, not a link.
  if (!salon) return null;

  const panel = el('div', 'panel');

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

  if (salon.status === 'pending') {
    panel.append(el('h2', null, 'Salon listing request'));
    panel.append(el('div', null, salon.name));
    panel.append(el('div', 'pill warn', '⏳ Under review'));
    if (salon.submittedAt) {
      panel.append(el('div', 'meta', `Submitted ${dateLong(salon.submittedAt, undefined)}`));
    }
    panel.append(el('div', 'note',
      'A Hasino admin is reviewing it. Your salon dashboard unlocks as soon as it is approved. '
      + 'Until then this account is a customer account, which is why nothing else has changed.'));
    return panel;
  }

  if (salon.status === 'rejected') {
    panel.append(el('h2', null, 'Salon listing request'));
    panel.append(el('div', null, salon.name));
    panel.append(el('div', 'pill bad', 'Not approved'));
    // The admin's reason, where the owner is standing. Same field the apply
    // screen shows; both read it from /api/me rather than keeping a copy.
    if (salon.rejectionReason) {
      const why = el('div', 'out bad');
      why.style.whiteSpace = 'pre-line';
      why.textContent = `Reason given: ${salon.rejectionReason}`;
      panel.append(why);
    }
    panel.append(el('div', 'note',
      'You can update the details and submit it again — it goes back for review.'));
    // Not an invitation to a customer, which is what the removed section was:
    // this is the way back into a request this account has already made.
    panel.append(Button({ label: 'View my request', onClick: () => app.navigate('#/apply') }));
    return panel;
  }

  // suspended, banned, or anything else the server may add later.
  panel.append(el('h2', null, 'Salon listing request'));
  panel.append(el('div', null, `${salon.name} is ${salon.status}`));
  panel.append(el('div', 'note', 'Contact Hasino support if you think this is wrong.'));
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
  const bookingsLink = el('a', 'item');
  bookingsLink.append(iconEl('calendar', { size: 19 }), el('span', 'grow', 'My bookings'));
  bookingsLink.href = '#/bookings';
  bookingsLink.style.cssText = 'text-decoration:none; color:inherit';
  list.append(bookingsLink);

  const notifications = el('div', 'item');
  notifications.append(iconEl('bell', { size: 19 }), el('span', 'grow', 'Notifications'));
  notifications.onclick = () => notifications.replaceWith(EmptyState({ title: 'No notifications yet.' }));
  list.append(notifications);

  // The same switch as the one in the account menu, for someone who came
  // looking for it under settings. Both read and write lib/theme.js, so
  // whichever is used, the other is right the next time it is drawn.
  const theme = el('div', 'item');
  const themeLabel = el('span', 'grow', 'Appearance');
  const themeValue = el('span', 'pill brand');
  const paintTheme = () => {
    const dark = currentTheme() === 'dark';
    themeIcon.replaceWith((themeIcon = iconEl(dark ? 'moon' : 'sun', { size: 19 })));
    themeValue.textContent = dark ? 'Dark' : 'Light';
  };
  let themeIcon = iconEl('sun', { size: 19 });
  theme.append(themeIcon);
  paintTheme();
  theme.style.cursor = 'pointer';
  theme.onclick = () => { toggleTheme(); paintTheme(); };
  theme.append(themeLabel, themeValue);
  list.append(theme);

  container.append(list);

  // The state of a salon request this account has already made, if it has
  // made one. A customer who has not is shown nothing — there is no "list your
  // salon" invitation on a customer's profile, by design.
  //
  // There is deliberately no admin entry either: the admin panel is a separate
  // private process, not a page of this app, and an operator opens it on their
  // own machine.
  const salonState = salonSection(app, session);
  if (salonState) container.append(salonState);

  container.append(
    Button({
      label: 'Sign out',
      variant: 'danger',
      onClick: () => app.signOut(),
    }),
  );
}
