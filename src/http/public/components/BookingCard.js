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
 * Three states earn their own affordance rather than a generic status pill,
 * because each one has something the customer can do about it: an unpaid hold
 * (finish paying, before it lapses), a refund in flight (know it is coming
 * without contacting anyone), and a movable booking (§4's 36-hour window).
 */
export function BookingCard(booking, { timezone = 'Asia/Kolkata', onCancel, onPay, onReschedule } = {}) {
  const item = el('div', 'item');

  const when = el('div');
  when.append(el('div', 'when', `${time(booking.startAt, timezone)} – ${time(booking.endAt, timezone)}`));
  when.append(el('div', 'meta', dateLong(booking.startAt, timezone)));
  item.append(when);

  const grow = el('div', 'grow');
  grow.append(el('div', null, booking.salonName));
  grow.append(el('div', 'meta', booking.services.join(', ') || 'Service appointment'));

  if (booking.status === 'pending_payment' && booking.holdExpiresAt) {
    const left = new Date(booking.holdExpiresAt).getTime() - Date.now();
    grow.append(
      el(
        'div',
        'meta',
        left > 0
          ? `Slot held for another ${Math.max(1, Math.round(left / 60000))} min — finish paying to confirm.`
          : 'The hold on this slot has lapsed.',
      ),
    );
  }

  if (booking.refundStatus && booking.refundStatus !== 'none') {
    grow.append(el('div', 'meta', REFUND_LABEL[booking.refundStatus] ?? booking.refundStatus));
  }

  item.append(grow);

  // Withheld by the API until 15 minutes before the slot — absence here means "not yet", not an error.
  if (booking.verifyCode) {
    item.append(el('span', 'pill ok mono', 'CODE ' + booking.verifyCode));
  }

  item.append(el('strong', null, rupees(booking.amount)));
  item.append(
    Badge({
      text: STATUS_LABEL[booking.status] ?? statusLabel(booking.status),
      tone: STATUS_TONE[booking.status] ?? 'brand',
    }),
  );

  if (onPay && booking.status === 'pending_payment') {
    const payBtn = el('button', 'btn sm primary', 'Complete payment');
    payBtn.onclick = () => onPay(booking.id);
    item.append(payBtn);
  }

  // canReschedule is computed server-side from the §4 deadline and the §10 cap,
  // so the button and the endpoint cannot disagree about whether it will work.
  if (onReschedule && booking.canReschedule) {
    const rescheduleBtn = el('button', 'btn sm', 'Reschedule');
    rescheduleBtn.onclick = () => onReschedule(booking);
    item.append(rescheduleBtn);
  }

  if (onCancel && CANCELLABLE.has(booking.status)) {
    const cancelBtn = el('button', 'btn sm danger', 'Cancel');
    cancelBtn.onclick = () => onCancel(booking.id);
    item.append(cancelBtn);
  }

  return item;
}
