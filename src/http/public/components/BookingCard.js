import { el } from '../lib/dom.js';
import { dateLong, rupees, statusLabel, time } from '../lib/format.js';
import { Badge } from './Badge.js';

const STATUS_TONE = {
  completed: 'ok',
  verified: 'brand',
  booked: 'brand',
  in_progress: 'brand',
  rescheduled: 'warn',
  no_show: 'bad',
  cancelled_by_customer: 'bad',
  cancelled_by_salon: 'bad',
};

const CANCELLABLE = new Set(['booked', 'verified']);

/** `booking` matches listCustomerBookings()'s shape. `timezone` renders the slot in the salon's own zone. */
export function BookingCard(booking, { timezone = 'Asia/Kolkata', onCancel } = {}) {
  const item = el('div', 'item');

  const when = el('div');
  when.append(el('div', 'when', `${time(booking.startAt, timezone)} – ${time(booking.endAt, timezone)}`));
  when.append(el('div', 'meta', dateLong(booking.startAt, timezone)));
  item.append(when);

  const grow = el('div', 'grow');
  grow.append(el('div', null, booking.salonName));
  grow.append(el('div', 'meta', booking.services.join(', ') || 'Service appointment'));
  item.append(grow);

  // Withheld by the API until 15 minutes before the slot — absence here means "not yet", not an error.
  if (booking.verifyCode) {
    item.append(el('span', 'pill ok mono', 'CODE ' + booking.verifyCode));
  }

  item.append(el('strong', null, rupees(booking.amount)));
  item.append(Badge({ text: statusLabel(booking.status), tone: STATUS_TONE[booking.status] ?? 'brand' }));

  if (onCancel && CANCELLABLE.has(booking.status)) {
    const cancelBtn = el('button', 'btn sm danger', 'Cancel');
    cancelBtn.onclick = () => onCancel(booking.id);
    item.append(cancelBtn);
  }

  return item;
}
