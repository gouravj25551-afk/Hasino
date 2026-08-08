/**
 * Payment seam. POST /api/bookings creates an unpaid booking today — Razorpay
 * (build order steps 4-5) is not built, and the API says so on every response
 * (`paid: false` + a warning string). This function is where a real payment
 * sheet will be triggered from, called from exactly one place
 * (views/booking.js). Until then it resolves immediately so the booking flow
 * has something to await without pretending money moved.
 */
export async function payForBooking(_booking) {
  return { paid: false };
}
