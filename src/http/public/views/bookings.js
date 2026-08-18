import { el } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { BookingCard } from '../components/BookingCard.js';
import { EmptyState } from '../components/EmptyState.js';
import { SkeletonList } from '../components/Skeleton.js';
import { Button } from '../components/Button.js';
import { Modal } from '../components/Modal.js';
import { ask } from '../lib/dialog.js';
import { dateLong, rupees, time } from '../lib/format.js';

const TABS = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'past', label: 'Past' },
  { id: 'cancelled', label: 'Cancelled' },
];

/**
 * Which tab a booking is in used to be a lookup on its status, which meant a
 * 'booked' row stayed under "Upcoming" forever: nothing moves a booking off
 * that list except a salon pressing [Complete], and a salon that never presses
 * it left yesterday's 10:00 appointment sitting above tomorrow's.
 *
 * So time decides instead, mirroring classifyBooking() on the server. Kept in
 * step with it by the API, which sends both its own verdict (`category`) and
 * the inputs — `serverNow` and `historyGraceMin` — so this can re-run the same
 * rule as the clock advances without asking again.
 */
const CANCELLED_LIKE = new Set([
  'cancelled_by_customer',
  'cancelled_by_salon',
  'rescheduled',
  'expired',
]);

/**
 * Outcomes the salon has already recorded. Historical on the strength of the
 * status alone — the grace period covers the gap before anyone says how the
 * visit went, and for these somebody has.
 */
const RESOLVED = new Set(['completed', 'no_show']);

/** Fallback only; the real value arrives with every response. */
const DEFAULT_GRACE_MIN = 30;

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
  // The server's clock, as an offset from this device's. The panel screen
  // already works this way (business.js) — a phone that is ten minutes out
  // would otherwise move bookings to Past ten minutes early or late, and a
  // customer looking at a booking that has "expired" on their own wrong clock
  // has no way to tell which of the two is lying.
  let clockSkewMs = 0;
  let graceMs = DEFAULT_GRACE_MIN * 60_000;
  let tickTimer = null;

  function serverNow() {
    return Date.now() + clockSkewMs;
  }

  /** end_at + grace: the instant this booking stops being current. */
  function historyAt(booking) {
    return Date.parse(booking.endAt) + graceMs;
  }

  /**
   * Same rule as classifyBooking() on the server, re-run against the current
   * clock. The server's own `category` is not used for the filtering — it was
   * true when the response was built, and this list may have been open for an
   * hour since — but it is what the first paint agrees with, because both are
   * computed from the same instant.
   */
  function categoryOf(booking) {
    if (CANCELLED_LIKE.has(booking.status)) return 'cancelled';
    if (RESOLVED.has(booking.status)) return 'past';
    // Only a booking still on the books is decided by the clock.
    return serverNow() >= historyAt(booking) ? 'past' : 'upcoming';
  }

  function absorb(payload) {
    bookings = payload.bookings ?? [];
    if (payload.serverNow) clockSkewMs = Date.parse(payload.serverNow) - Date.now();
    if (payload.historyGraceMin != null) graceMs = payload.historyGraceMin * 60_000;
  }

  try {
    absorb(await api('/api/me/bookings'));
  } catch (err) {
    list.innerHTML = '';
    list.append(EmptyState({ title: err.message || 'Could not load your bookings' }));
    return;
  }

  async function refresh() {
    absorb(await api('/api/me/bookings'));
    draw();
  }

  /**
   * One timer, armed for the next threshold any loaded booking will actually
   * cross — not a poll. A booking ending at 10:30 moves itself at 11:00 with a
   * single wakeup; a screen showing only next week's appointments sets no timer
   * at all.
   *
   * It refetches rather than just redrawing, because crossing the line changes
   * more than which list a row is in: the reschedule window and the verification
   * code are computed server-side too, and re-deriving them here would be a
   * second copy of those rules.
   */
  function scheduleTick() {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = null;

    // Only what is still current has a boundary left to cross. Asking
    // categoryOf rather than re-listing statuses here means the timer cannot
    // drift out of step with the classification it exists to refresh.
    const next = bookings
      .filter((b) => categoryOf(b) === 'upcoming')
      .map(historyAt)
      .filter((t) => t > serverNow())
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;

    // +1s so the wakeup lands just past the boundary rather than on it, and
    // clamped: setTimeout is a 32-bit signed millisecond count, so a booking
    // three months out would otherwise overflow and fire immediately.
    const delay = Math.min(next - serverNow() + 1000, 0x7fffffff);
    tickTimer = setTimeout(() => {
      // This view has been replaced (the router clears the container and
      // re-renders on every navigation, leaving this `list` detached). Nothing
      // to update, and refetching would be a request for a screen nobody is
      // looking at.
      if (!list.isConnected) return;
      refresh().catch(() => draw());
    }, delay);
  }

  // Background tabs get their timers throttled, so a phone left on this screen
  // in a pocket can wake up well past the threshold. Reclassifying on the way
  // back is cheap and covers the gap.
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (!list.isConnected) {
      document.removeEventListener('visibilitychange', onVisible);
      return;
    }
    refresh().catch(() => draw());
  };
  document.addEventListener('visibilitychange', onVisible);

  function draw() {
    list.innerHTML = '';
    const tab = TABS.find((t) => t.id === active);
    const filtered = bookings.filter((b) => categoryOf(b) === tab.id);
    scheduleTick();
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
                  const givingUpHold = target?.status === 'pending_payment';
                  const ok = await ask({
                    title: givingUpHold ? 'Give up this slot?' : 'Cancel this booking?',
                    message: givingUpHold
                      ? 'Nothing has been charged.'
                      : 'Under our terms a customer cancellation is not refunded, but you can reschedule it to another time free of charge for the next 36 hours.',
                    confirmLabel: givingUpHold ? 'Give up the slot' : 'Cancel booking',
                    cancelLabel: 'Keep it',
                    danger: true,
                  });
                  if (!ok) return;
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
  body.append(el('h2', null, 'Reschedule this booking'));
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
                ? 'The 36-hour window to reschedule this booking has closed.'
                : err.message;
          status.append(el('div', 'out bad', message || 'Could not reschedule the booking'));
        }
      };
      wrap.append(b);
    }
    slotBox.append(wrap);
  }
}
