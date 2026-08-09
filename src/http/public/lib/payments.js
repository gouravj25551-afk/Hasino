/**
 * Razorpay Checkout, from the browser's side.
 *
 * The flow is deliberately two calls to our own API with Razorpay's sheet in
 * between:
 *
 *   POST /api/bookings          -> takes the chair, returns an order
 *   [Razorpay sheet]            -> the customer pays
 *   POST /api/bookings/:id/confirm -> we verify the signature, booking goes live
 *
 * Nothing here is trusted by the server. The handler response is signed by
 * Razorpay and re-verified server-side, and the server independently asks
 * Razorpay what the payment's real status was. This file could be rewritten by
 * a customer with devtools open and the worst they could do is fail their own
 * checkout.
 */
import { api, ApiError } from './api.js';

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

let loader = null;

/** Load checkout.js once, lazily. It is ~100KB and most visits never book. */
export function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loader) return loader;

  loader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () =>
      window.Razorpay
        ? resolve(window.Razorpay)
        : reject(new Error('Razorpay loaded but did not register'));
    script.onerror = () => {
      loader = null; // let a later attempt retry rather than caching the failure
      reject(new Error('Could not reach Razorpay. Check your connection and try again.'));
    };
    document.head.append(script);
  });
  return loader;
}

/** The customer closed the sheet without paying. Not an error — a decision. */
export class CheckoutDismissed extends Error {
  constructor() {
    super('Payment cancelled');
    this.name = 'CheckoutDismissed';
  }
}

/** The bank or card declined. Distinct from dismissal so the UI can say so. */
export class CheckoutFailed extends Error {
  constructor(message, code) {
    super(message || 'Payment failed');
    this.name = 'CheckoutFailed';
    this.code = code;
  }
}

/**
 * Open the sheet and resolve with the signed handler response.
 *
 * `ondismiss` and `handler` are mutually exclusive in practice but Razorpay
 * calls neither if the tab is closed — which is exactly why the server has a
 * webhook. A customer who closes the tab mid-payment still gets their booking.
 */
export function openRazorpayCheckout(checkout) {
  return loadRazorpay().then(
    (Razorpay) =>
      new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, value) => {
          if (settled) return;
          settled = true;
          fn(value);
        };

        const rzp = new Razorpay({
          key: checkout.keyId,
          amount: checkout.amount,
          currency: checkout.currency,
          order_id: checkout.orderId,
          name: 'Hasino',
          description: checkout.salonName,
          prefill: {
            name: checkout.prefill?.name ?? '',
            email: checkout.prefill?.email ?? '',
            contact: checkout.prefill?.contact ?? '',
          },
          notes: { booking_id: checkout.bookingId },
          theme: { color: '#111111' },
          retry: { enabled: false }, // our hold has a TTL; Razorpay's retry loop outlives it
          handler: (response) => done(resolve, response),
          modal: {
            escape: true,
            ondismiss: () => done(reject, new CheckoutDismissed()),
          },
        });

        rzp.on('payment.failed', (event) => {
          const err = event?.error ?? {};
          done(reject, new CheckoutFailed(err.description, err.code));
        });

        rzp.open();
      }),
  );
}

/**
 * The whole payment step for a booking that is already holding its chair.
 *
 * Resolves with the confirm response. `outcome: 'refunding'` is a success from
 * the network's point of view and a failure from the customer's — the money
 * arrived after the slot was gone — so callers must check it rather than
 * assuming a resolved promise means "booked".
 */
export async function payForBooking(booking) {
  const checkout = booking.checkout ?? (await api(`/api/bookings/${booking.id}/checkout`, { method: 'POST' }));
  const signed = await openRazorpayCheckout(checkout);
  return confirmPayment(booking.id, signed);
}

export async function confirmPayment(bookingId, signed) {
  return api(`/api/bookings/${bookingId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({
      razorpay_order_id: signed.razorpay_order_id,
      razorpay_payment_id: signed.razorpay_payment_id,
      razorpay_signature: signed.razorpay_signature,
    }),
  });
}

/**
 * Retry confirmation for a payment that went through while our confirm call
 * did not — a 503 from `VERIFY_UNAVAILABLE`, or a dropped connection.
 *
 * Polls the booking list rather than re-posting the signature, because by now
 * the webhook has probably done the job already and posting again would be a
 * second capture attempt against a booking that is live.
 */
export async function waitForConfirmation(bookingId, { attempts = 6, intervalMs = 2500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const { bookings } = await api('/api/me/bookings');
      const booking = bookings.find((b) => b.id === bookingId);
      if (!booking) return { status: 'expired' };
      if (booking.status !== 'pending_payment') return { status: booking.status };
    } catch (err) {
      if (err instanceof ApiError && err.status >= 500) continue;
      throw err;
    }
  }
  return { status: 'pending_payment' };
}
