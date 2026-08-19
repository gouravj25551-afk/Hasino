import { el } from '../lib/dom.js';
import { dateLong, rupees, statusLabel, time } from '../lib/format.js';
import { Badge } from './Badge.js';

const STATUS_TONE = {
  completed: 'ok',
  verified: 'brand',
  booked: 'brand',
  in_progress: 'brand',
  pending_payment: 'warn',
  rescheduled: 'warn',
  no_show: 'bad',
  expired: 'bad',
  cancelled_by_customer: 'bad',
  cancelled_by_salon: 'bad',
};

const STATUS_LABEL = {
  pending_payment: 'awaiting payment',
};

const REFUND_LABEL = {
  pending: 'refund on its way',
  processed: 'refunded',
  failed: 'refund failed — we are on it',
};

const CANCELLABLE = new Set(['booked', 'verified', 'pending_payment']);

/**
 * `booking` matches listCustomerBookings()'s shape. `timezone` renders the slot
 * in the salon's own zone.
 *
 * Rebuilt around what a customer is actually scanning for. The old card was a
 * flat row — time, salon, price, status, buttons, all at one weight — so an
 * appointment tomorrow morning and a haircut from March looked identical, and
 * the two facts anyone opens this screen for (when, and where) had to be
 * hunted for among five other things.
 *
 * Now the date and time lead, the salon and its services sit beside them, and
 * everything else is secondary. `variant: 'past'` steps the whole card back
 * without hiding anything: history stays legible and stays actionable, it just
 * stops competing with what is coming up.
 *
 * Three states keep their own affordance rather than a generic status pill,
 * because each one has something the customer can do about it: an unpaid hold
 * (finish paying, before it lapses), a refund in flight (know it is coming
 * without contacting anyone), and a movable booking (§4's 36-hour window).
 */
export function BookingCard(
  booking,
  { timezone = 'Asia/Kolkata', variant = '', onCancel, onPay, onReschedule } = {},
) {
  const card = el('div', ['booking-card', variant === 'past' ? 'is-past' : ''].filter(Boolean).join(' '));

  // ---- when: the reason this screen gets opened ----
  const when = el('div', 'booking-when');
  when.append(el('div', 'booking-time', `${time(booking.startAt, timezone)}`));
  when.append(el('div', 'booking-date', dateLong(booking.startAt, timezone)));
  when.append(el('div', 'booking-until', `until ${time(booking.endAt, timezone)}`));
  card.append(when);

  // ---- what and where ----
  const main = el('div', 'booking-main');
  main.append(el('div', 'booking-salon', booking.salonName));
  main.append(el('div', 'booking-services', booking.services.join(', ') || 'Service appointment'));

  if (booking.status === 'pending_payment' && booking.holdExpiresAt) {
    const left = new Date(booking.holdExpiresAt).getTime() - Date.now();
    main.append(
      el(
        'div',
        'booking-note',
        left > 0
          ? `Slot held for another ${Math.max(1, Math.round(left / 60000))} min — finish paying to confirm.`
          : 'The hold on this slot has lapsed.',
      ),
    );
  }

  if (booking.refundStatus && booking.refundStatus !== 'none') {
    main.append(el('div', 'booking-note', REFUND_LABEL[booking.refundStatus] ?? booking.refundStatus));
  }
  card.append(main);

  // ---- status, price, and the code ----
  const side = el('div', 'booking-side');
  side.append(
    Badge({
      text: STATUS_LABEL[booking.status] ?? statusLabel(booking.status),
      tone: STATUS_TONE[booking.status] ?? 'brand',
    }),
  );
  side.append(el('strong', 'booking-amount', rupees(booking.amount)));

  // This booking's own code, from this booking's own row. Withheld by the API
  // until 15 minutes before the slot (§4), which used to render as nothing at
  // all — indistinguishable from a code that had gone missing, especially for
  // a customer holding several bookings at once. So the card says which of the
  // two it is, per booking.
  if (booking.verifyCode) {
    side.append(el('span', 'pill ok mono', 'CODE ' + booking.verifyCode));
  } else if (booking.verifyCodeAt) {
    const at = el('span', 'pill outline', `code at ${time(booking.verifyCodeAt, timezone)}`);
    at.title = 'Your code appears 15 minutes before this booking, so a screenshot taken today is not a key to it.';
    side.append(at);
  }
  card.append(side);

  // ---- actions ----
  const actions = el('div', 'booking-actions');

  if (onPay && booking.status === 'pending_payment') {
    const payBtn = el('button', 'btn sm primary', 'Complete payment');
    payBtn.onclick = () => onPay(booking.id);
    actions.append(payBtn);
  }

  // canReschedule is computed server-side from the §4 deadline and the §10 cap,
  // so the button and the endpoint cannot disagree about whether it will work.
  if (onReschedule && booking.canReschedule) {
    const rescheduleBtn = el('button', 'btn sm', 'Reschedule');
    rescheduleBtn.onclick = () => onReschedule(booking);
    actions.append(rescheduleBtn);
  }

  if (onCancel && CANCELLABLE.has(booking.status)) {
    const cancelBtn = el('button', 'btn sm danger', 'Cancel');
    cancelBtn.onclick = () => onCancel(booking.id);
    actions.append(cancelBtn);
  }

  if (actions.children.length) card.append(actions);

  return card;
}
