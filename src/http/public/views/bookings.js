import { el } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { BookingCard } from '../components/BookingCard.js';
import { EmptyState } from '../components/EmptyState.js';
import { SkeletonList } from '../components/Skeleton.js';
import { Button } from '../components/Button.js';
import { Modal } from '../components/Modal.js';
import { dateLong, rupees, time } from '../lib/format.js';

const TABS = [
  {
    id: 'upcoming',
    label: 'Upcoming',
    // pending_payment first: it is the only tab where the customer has
    // something time-limited to do, and burying it under "Past" is how an
    // abandoned checkout becomes a support ticket.
    statuses: ['pending_payment', 'booked', 'verified', 'in_progress'],
  },
  { id: 'past', label: 'Past', statuses: ['completed', 'no_show'] },
  {
    id: 'cancelled',
    label: 'Cancelled',
    statuses: ['cancelled_by_customer', 'cancelled_by_salon', 'rescheduled'],
  },
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

  async function refresh() {
    ({ bookings } = await api('/api/me/bookings'));
    draw();
  }

  function draw() {
    list.innerHTML = '';
    const tab = TABS.find((t) => t.id === active);
    const filtered = bookings.filter((b) => tab.statuses.includes(b.status));
    if (!filtered.length) {
      list.append(
        EmptyState({
          title: `No ${tab.label.toLowerCase()} bookings.`,
          action: 'Browse salons',
          onAction: () => app.navigate('#/explore'),
        }),
      );
      return;
    }
    for (const b of filtered) {
      list.append(
        BookingCard(b, {
          onPay: (id) => app.navigate(`#/checkout/${id}`),
          onReschedule: (booking) => openReschedule(booking, app, refresh),
          onCancel:
            tab.id === 'upcoming'
              ? async (id) => {
                  const target = bookings.find((x) => x.id === id);
                  const message =
                    target?.status === 'pending_payment'
                      ? 'Give up this slot? Nothing has been charged.'
                      : 'Cancel this booking? Under our terms a customer cancellation is not refunded, but you can move it to another time free of charge for the next 36 hours.';
                  if (!confirm(message)) return;
                  await api(`/api/me/bookings/${id}/cancel`, { method: 'POST' });
                  await refresh();
                }
              : undefined,
        }),
      );
    }
  }

  draw();
}

/**
 * §4's reschedule, as a slot picker over the same availability endpoint the
 * salon page uses.
 *
 * The cart is the booking's own services, so the availability returned is for
 * exactly the duration that already has a chair paid for. There is no payment
 * step — the money moved once, and moving a booking does not move it again.
 */
async function openReschedule(booking, app, onDone) {
  const body = el('div');
  body.style.padding = 'var(--space-6)';
  body.append(el('h2', null, 'Move this booking'));
  body.append(
    el(
      'p',
      'sub',
      `${booking.salonName} · ${booking.services.join(', ')} · ${rupees(booking.amount)} already paid`,
    ),
  );

  const status = el('div');
  const slotBox = el('div');
  slotBox.append(el('div', 'empty', 'Loading available times…'));
  body.append(slotBox, status);

  const actions = el('div', 'row');
  actions.style.justifyContent = 'flex-end';
  actions.append(Button({ label: 'Keep as is', onClick: () => close() }));
  body.append(actions);

  const close = Modal(body);

  let avail;
  try {
    const detail = await api(`/api/salons/${booking.salonId}`);
    const serviceIds = detail.services
      .filter((s) => booking.services.includes(s.name))
      .map((s) => s.serviceId);
    avail = await api(`/api/salons/${booking.salonId}/availability`, {
      method: 'POST',
      body: JSON.stringify({ serviceIds }),
    });
  } catch (err) {
    slotBox.innerHTML = '';
    slotBox.append(el('div', 'out bad', err.message || 'Could not load availability'));
    return;
  }

  slotBox.innerHTML = '';
  const openDays = avail.days.filter((d) => d.full.length > 0);
  if (!openDays.length) {
    slotBox.append(
      el('div', 'note', 'This salon has nothing free in the next 7 days. Your original booking is unchanged.'),
    );
    return;
  }

  for (const day of openDays) {
    slotBox.append(el('div', 'meta', dateLong(day.date + 'T00:00:00Z', avail.timezone)));
    const wrap = el('div', 'slots');
    for (const iso of day.full) {
      const b = el('button', 'slot', time(iso, avail.timezone));
      b.type = 'button';
      b.onclick = async () => {
        status.innerHTML = '';
        for (const btn of slotBox.querySelectorAll('button')) btn.disabled = true;
        try {
          await api(`/api/me/bookings/${booking.id}/reschedule`, {
            method: 'POST',
            body: JSON.stringify({ startAt: iso }),
          });
          close();
          await onDone();
        } catch (err) {
          for (const btn of slotBox.querySelectorAll('button')) btn.disabled = false;
          const message =
            err instanceof ApiError && err.status === 409
              ? 'That slot went while you were choosing. Pick another.'
              : err instanceof ApiError && err.status === 410
                ? 'The 36-hour window to move this booking has closed.'
                : err.message;
          status.append(el('div', 'out bad', message || 'Could not move the booking'));
        }
      };
      wrap.append(b);
    }
    slotBox.append(wrap);
  }
}
