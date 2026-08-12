import { el } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { dateLong, rupees, time } from '../lib/format.js';
import { Button } from '../components/Button.js';
import { Badge } from '../components/Badge.js';
import {
  CheckoutDismissed,
  CheckoutFailed,
  confirmPayment,
  openRazorpayCheckout,
  waitForConfirmation,
} from '../lib/payments.js';

/**
 * The payment screen.
 *
 * It exists as a route rather than a modal for one reason: the chair is already
 * held by the time the customer gets here, and a hold has a deadline. A modal
 * disappears on a stray backdrop click, taking the countdown with it and
 * leaving the customer with a booking they do not know they have. A URL can be
 * reloaded, shared to a second device, and reopened from the bookings list.
 *
 * Everything on this screen is a re-read from the server. There is no state
 * passed in from the salon page, because the interesting failures — the hold
 * expiring, the payment already having gone through via the webhook — all
 * happen server-side.
 */
export async function renderCheckout(container, app, bookingId) {
  if (!app.requireSession()) return;
  container.innerHTML = '';

  const panel = el('div', 'panel');
  container.append(panel);
  panel.append(el('div', 'empty', 'Opening checkout…'));

  let checkout;
  let booking;
  try {
    const { bookings } = await api('/api/me/bookings');
    booking = bookings.find((b) => b.id === bookingId);
    if (!booking) return renderGone(panel, app, 'This booking is no longer available.');

    if (booking.status !== 'pending_payment') return renderAlreadyDone(panel, app, booking);

    checkout = await api(`/api/bookings/${bookingId}/checkout`, { method: 'POST' });
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'NOT_PAYABLE' || err.status === 404)) {
      return renderGone(panel, app, err.message);
    }
    if (err instanceof ApiError && err.code === 'PAYMENTS_DISABLED') {
      // Not an error the customer caused, and not a broken deployment: Hasino
      // has not turned payments on yet. The booking above this is already
      // reserved, so the honest message is "nothing to pay", not "failed".
      return renderGone(
        panel,
        app,
        'Online payment is coming soon. Your booking is reserved — pay at the salon for now.',
      );
    }
    panel.innerHTML = '';
    panel.append(el('div', 'out bad', err.message || 'Could not open checkout'));
    return;
  }

  draw(panel, app, booking, checkout);
}

function draw(panel, app, booking, checkout) {
  panel.innerHTML = '';
  panel.append(el('h1', null, 'Confirm and pay'));
  panel.append(el('p', 'sub', `${booking.salonName} · ${booking.services.join(', ')}`));

  const summary = el('div', 'panel');
  summary.style.background = 'var(--surface-2)';
  summary.append(row('When', `${dateLong(booking.startAt)} at ${time(booking.startAt)}`));
  summary.append(row('Services', booking.services.join(', ') || 'Appointment'));
  const total = el('div', 'row');
  total.style.cssText = 'justify-content:space-between; margin-top:10px';
  total.append(el('strong', null, 'Total'), el('strong', null, rupees(booking.amount)));
  summary.append(total);
  panel.append(summary);

  // The countdown is the honest version of what the server is already doing.
  // Hiding it would mean a customer typing an OTP watches the button stop
  // working for no visible reason.
  const timerBox = el('div', 'note');
  panel.append(timerBox);

  const status = el('div');
  panel.append(status);

  const actions = el('div', 'row');
  actions.style.marginTop = 'var(--space-4)';
  const payBtn = Button({ label: `Pay ${rupees(booking.amount)}`, variant: 'primary' });
  const backBtn = Button({ label: 'Choose another time', onClick: () => app.navigate(`#/salon/${booking.salonId}`) });
  actions.append(payBtn, backBtn);
  panel.append(actions);

  panel.append(
    el(
      'div',
      'meta',
      'Payments are processed by Razorpay. Hasino never sees your card or UPI details.',
    ),
  );

  const deadline = checkout.holdExpiresAt ? new Date(checkout.holdExpiresAt).getTime() : null;
  let expired = false;

  const tick = () => {
    if (!deadline) {
      timerBox.textContent = 'Your slot is held while you pay.';
      return;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      expired = true;
      clearInterval(timer);
      timerBox.className = 'out bad';
      timerBox.textContent =
        'The hold on this slot has expired and it may have been taken. If your payment already went through you will be refunded automatically.';
      payBtn.disabled = true;
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    timerBox.textContent = `Your slot is held for ${m}:${String(s).padStart(2, '0')} while you pay.`;
  };

  const timer = setInterval(tick, 1000);
  tick();
  // A route change must not leave a timer writing into a detached node.
  window.addEventListener('hashchange', () => clearInterval(timer), { once: true });

  payBtn.onclick = async () => {
    if (expired) return;
    status.innerHTML = '';
    payBtn.disabled = true;
    payBtn.textContent = 'Opening Razorpay…';

    try {
      const signed = await openRazorpayCheckout(checkout);
      payBtn.textContent = 'Confirming…';
      const result = await confirmPayment(booking.id, signed);
      clearInterval(timer);

      if (result.outcome === 'refunding') {
        // Paid, but too late. Say so plainly — a generic error here would have
        // the customer paying again for a slot they cannot have.
        panel.innerHTML = '';
        panel.append(el('h1', null, 'Refund on its way'));
        panel.append(el('div', 'out bad', result.message));
        panel.append(
          el(
            'p',
            'sub',
            'Your payment went through a moment after someone else took the slot. The full amount is being returned to the method you paid with — banks usually take 5-7 working days.',
          ),
        );
        panel.append(Button({ label: 'Find another time', variant: 'primary', onClick: () => app.navigate(`#/salon/${booking.salonId}`) }));
        return;
      }

      renderDone(panel, app, booking);
    } catch (err) {
      payBtn.disabled = false;
      payBtn.textContent = `Pay ${rupees(booking.amount)}`;

      if (err instanceof CheckoutDismissed) {
        status.append(
          el('div', 'note', 'Payment cancelled. Your slot is still held — you can try again above.'),
        );
        return;
      }
      if (err instanceof CheckoutFailed) {
        status.append(el('div', 'out bad', `${err.message}. Nothing was charged — try another method.`));
        return;
      }
      // The money may have moved even though our confirm call did not land.
      // Never tell the customer it failed until we have asked the server.
      if (err instanceof ApiError && (err.code === 'VERIFY_UNAVAILABLE' || err.status >= 500)) {
        payBtn.disabled = true;
        status.append(el('div', 'note', 'Payment received. Confirming your booking…'));
        const settled = await waitForConfirmation(booking.id);
        if (settled.status === 'booked') return renderDone(panel, app, booking);
        status.innerHTML = '';
        status.append(
          el(
            'div',
            'note',
            'Still confirming. Your payment is safe — check My Bookings in a minute, and you will be refunded automatically if the slot could not be held.',
          ),
        );
        return;
      }
      status.append(el('div', 'out bad', err.message || 'Payment failed'));
    }
  };
}

function renderDone(panel, app, booking) {
  panel.innerHTML = '';
  panel.append(el('h1', null, 'Booked'));
  panel.append(Badge({ text: 'Payment successful', tone: 'ok' }));
  panel.append(
    el('p', 'sub', `${booking.salonName}, ${dateLong(booking.startAt)} at ${time(booking.startAt)}.`),
  );
  panel.append(
    el(
      'div',
      'note',
      'Your 6-digit check-in code appears in My Bookings 15 minutes before your slot. Show it at the counter.',
    ),
  );
  const actions = el('div', 'row');
  actions.append(
    Button({ label: 'View my bookings', variant: 'primary', onClick: () => app.navigate('#/bookings') }),
    Button({ label: 'Browse salons', onClick: () => app.navigate('#/explore') }),
  );
  panel.append(actions);
}

function renderAlreadyDone(panel, app, booking) {
  if (booking.status === 'booked' || booking.status === 'verified' || booking.status === 'in_progress') {
    return renderDone(panel, app, booking);
  }
  return renderGone(panel, app, `This booking is ${booking.status.replace(/_/g, ' ')}.`);
}

function renderGone(panel, app, message) {
  panel.innerHTML = '';
  panel.append(el('h1', null, 'Nothing to pay'));
  panel.append(el('div', 'note', message));
  panel.append(
    Button({ label: 'Back to my bookings', variant: 'primary', onClick: () => app.navigate('#/bookings') }),
  );
}

function row(label, value) {
  const node = el('div', 'meta');
  node.textContent = `${label.toUpperCase()}: ${value}`;
  return node;
}
