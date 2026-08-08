import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { BookingCard } from '../components/BookingCard.js';
import { EmptyState } from '../components/EmptyState.js';
import { SkeletonList } from '../components/Skeleton.js';

const TABS = [
  { id: 'upcoming', label: 'Upcoming', statuses: ['booked', 'verified', 'in_progress'] },
  { id: 'past', label: 'Past', statuses: ['completed', 'no_show'] },
  { id: 'cancelled', label: 'Cancelled', statuses: ['cancelled_by_customer', 'cancelled_by_salon', 'rescheduled'] },
];

export async function renderBookings(container, app) {
  if (!app.requireSession()) return;
  container.innerHTML = '';

  container.append(el('h1', null, 'My bookings'));
  container.append(el('p', 'sub', 'Upcoming appointments, verification codes and past visits.'));

  const tabStrip = el('div', 'tab-strip');
  let active = 'upcoming';
  for (const tab of TABS) {
    const btn = el('button', 'tab-btn' + (tab.id === active ? ' active' : ''), tab.label);
    btn.onclick = () => {
      active = tab.id;
      for (const b of tabStrip.children) b.classList.remove('active');
      btn.classList.add('active');
      draw();
    };
    tabStrip.append(btn);
  }
  container.append(tabStrip);

  const list = el('div', 'list');
  container.append(list);
  list.append(SkeletonList(3));

  let bookings = [];
  try {
    ({ bookings } = await api('/api/me/bookings'));
  } catch (err) {
    list.innerHTML = '';
    list.append(EmptyState({ title: err.message || 'Could not load your bookings' }));
    return;
  }

  function draw() {
    list.innerHTML = '';
    const tab = TABS.find((t) => t.id === active);
    const filtered = bookings.filter((b) => tab.statuses.includes(b.status));
    if (!filtered.length) {
      list.append(EmptyState({ title: `No ${tab.label.toLowerCase()} bookings.`, action: 'Browse salons', onAction: () => app.navigate('#/explore') }));
      return;
    }
    for (const b of filtered) {
      list.append(
        BookingCard(b, {
          onCancel:
            tab.id === 'upcoming'
              ? async (id) => {
                  if (!confirm('Cancel this booking?')) return;
                  await api(`/api/me/bookings/${id}/cancel`, { method: 'POST' });
                  ({ bookings } = await api('/api/me/bookings'));
                  draw();
                }
              : undefined,
        }),
      );
    }
  }

  draw();
}
