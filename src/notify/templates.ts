/**
 * Notification bodies.
 *
 * Plain functions over a payload, not a template engine — there are six of
 * them, they are the only place customer-facing copy lives, and a rendering
 * bug here is a wrong time in a booking confirmation. Everything they need is
 * frozen into the payload at enqueue time, so re-sending a three-week-old row
 * cannot render it against changed data.
 */

export interface Rendered {
  subject: string;
  text: string;
}

type Payload = Record<string, unknown>;

const s = (p: Payload, k: string, fallback = ''): string => {
  const v = p[k];
  return typeof v === 'string' ? v : fallback;
};

/** Paise -> "₹1,250". Booking amounts are whole rupees in practice; show paise only when they exist. */
export function rupees(paise: unknown): string {
  const n = typeof paise === 'number' ? paise : Number(paise ?? 0);
  const whole = n / 100;
  return (
    '₹' +
    whole.toLocaleString('en-IN', {
      minimumFractionDigits: n % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    })
  );
}

/**
 * The salon's local time, formatted for a human.
 *
 * The instant and the zone both come from the payload rather than from the
 * salon row at send time: a salon that later corrects its timezone must not
 * retroactively change what a sent email said.
 */
export function whenText(iso: unknown, timezone: unknown): string {
  const t = typeof iso === 'string' ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return 'your booked time';
  const zone = typeof timezone === 'string' && timezone ? timezone : 'Asia/Kolkata';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(t);
}

const sign = (name: string) => `\n\n— ${name}\nHasino`;

export const TEMPLATES: Record<string, (p: Payload) => Rendered> = {
  booking_confirmed: (p) => ({
    subject: `Booked: ${s(p, 'salonName', 'your salon')}, ${whenText(p['startAt'], p['timezone'])}`,
    text:
      `Hi ${s(p, 'customerName', 'there')},\n\n` +
      `Your booking at ${s(p, 'salonName')} is confirmed.\n\n` +
      `When:     ${whenText(p['startAt'], p['timezone'])}\n` +
      `Services: ${s(p, 'services')}\n` +
      `Paid:     ${rupees(p['amount'])}\n` +
      `Where:    ${s(p, 'salonAddress')}\n\n` +
      `Show your 6-digit code at the counter. It appears in the app 15 minutes ` +
      `before your slot.` +
      sign(s(p, 'salonName', 'Hasino')),
  }),

  booking_cancelled_by_salon: (p) => ({
    subject: `Cancelled: ${s(p, 'salonName')}, ${whenText(p['startAt'], p['timezone'])}`,
    text:
      `Hi ${s(p, 'customerName', 'there')},\n\n` +
      `${s(p, 'salonName')} has had to cancel your ${whenText(p['startAt'], p['timezone'])} ` +
      `booking.\n\n` +
      `A full refund of ${rupees(p['amount'])} is on its way back to the method you ` +
      `paid with. Banks usually take 5-7 working days.\n\n` +
      `You can rebook any time in the app.` +
      sign('Hasino'),
  }),

  booking_cancelled_by_customer: (p) => ({
    subject: `Cancelled: your ${whenText(p['startAt'], p['timezone'])} booking`,
    text:
      `Hi ${s(p, 'customerName', 'there')},\n\n` +
      `Your booking at ${s(p, 'salonName')} is cancelled.\n\n` +
      `You can reschedule it to another time free of charge until ` +
      `${whenText(p['rescheduleDeadline'], p['timezone'])} — open the booking in the ` +
      `app and pick a new slot.` +
      sign('Hasino'),
  }),

  booking_rescheduled: (p) => ({
    subject: `Rescheduled: ${s(p, 'salonName')}, now ${whenText(p['startAt'], p['timezone'])}`,
    text:
      `Hi ${s(p, 'customerName', 'there')},\n\n` +
      `Your booking at ${s(p, 'salonName')} has been rescheduled.\n\n` +
      `Was: ${whenText(p['previousStartAt'], p['timezone'])}\n` +
      `Now: ${whenText(p['startAt'], p['timezone'])}\n\n` +
      `Nothing more to pay.` +
      sign('Hasino'),
  }),

  booking_reminder: (p) => ({
    subject: `Today: ${s(p, 'salonName')} at ${whenText(p['startAt'], p['timezone'])}`,
    text:
      `Hi ${s(p, 'customerName', 'there')},\n\n` +
      `Reminder — you are booked at ${s(p, 'salonName')} ` +
      `${whenText(p['startAt'], p['timezone'])}.\n\n` +
      `${s(p, 'salonAddress')}\n\n` +
      `Your check-in code is in the app.` +
      sign('Hasino'),
  }),

  refund_processed: (p) => ({
    subject: `Refunded: ${rupees(p['amount'])}`,
    text:
      `Hi ${s(p, 'customerName', 'there')},\n\n` +
      `${rupees(p['amount'])} has been refunded for your ` +
      `${whenText(p['startAt'], p['timezone'])} booking at ${s(p, 'salonName')}.\n\n` +
      `It goes back to the method you paid with. Banks usually take 5-7 working ` +
      `days to show it.` +
      sign('Hasino'),
  }),

  salon_new_booking: (p) => ({
    subject: `New booking: ${whenText(p['startAt'], p['timezone'])}`,
    text:
      `${s(p, 'customerName', 'A customer')} booked ${s(p, 'services')} for ` +
      `${whenText(p['startAt'], p['timezone'])}.\n\n` +
      `Amount: ${rupees(p['amount'])}\n` +
      `Contact: ${s(p, 'customerPhone') || s(p, 'customerEmail', 'none on file')}\n\n` +
      `It is already on your Today screen.` +
      sign('Hasino'),
  }),

  // To ADMIN_EMAILS. An approval queue nobody is told about is a queue nobody
  // empties, and the applicant is sitting behind a "under review" screen.
  salon_application: (p) => ({
    subject: `Salon application: ${s(p, 'salonName')}`,
    text:
      `${s(p, 'salonName')} applied to list on Hasino.\n\n` +
      `City:    ${s(p, 'city')}\n` +
      `Address: ${s(p, 'address')}\n` +
      `Owner:   ${s(p, 'ownerName', 'unknown')} · ${s(p, 'ownerPhone', 'no phone')}\n` +
      `Email:   ${s(p, 'ownerEmail', 'none')}\n\n` +
      `It is pending and invisible to customers until approved.\n` +
      `Review it at /admin#/salon/${s(p, 'salonId')}` +
      sign('Hasino'),
  }),
};

export function render(template: string, payload: Payload): Rendered {
  const fn = TEMPLATES[template];
  if (!fn) throw new Error(`unknown notification template: ${template}`);
  return fn(payload);
}
