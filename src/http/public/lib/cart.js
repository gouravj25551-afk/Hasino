/**
 * The services a customer has picked, for one salon.
 *
 * Kept outside the view so that walking to the salon's photos and back — or
 * reloading the page inside the Android app — does not silently empty the
 * basket. sessionStorage rather than localStorage: a cart is about this visit,
 * and one restored a week later would quote prices and durations the salon has
 * since changed.
 *
 * One cart, and it carries the salon it belongs to. A booking is with one
 * salon by construction — booking_slots and the availability engine are both
 * per salon — so opening a different salon's page replaces the cart rather
 * than mixing two menus that cannot be booked together. The customer is told
 * this happened rather than left wondering; see renderSalon().
 */

const KEY = 'hasino.cart';

function read() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.salonId !== 'string' || !Array.isArray(parsed.serviceIds)) return null;
    return { salonId: parsed.salonId, serviceIds: parsed.serviceIds.filter((s) => typeof s === 'string') };
  } catch {
    // Storage disabled, or someone else's JSON under our key. Either way the
    // cart starts empty rather than the page failing to render.
    return null;
  }
}

/** What is in the cart for this salon. Empty when the cart belongs to another one. */
export function cartFor(salonId) {
  const stored = read();
  return stored && stored.salonId === salonId ? stored.serviceIds : [];
}

/** The salon whose cart is stored, if any — so a view can say what it replaced. */
export function cartSalonId() {
  return read()?.salonId ?? null;
}

export function saveCart(salonId, serviceIds) {
  try {
    if (serviceIds.length === 0) return clearCart();
    sessionStorage.setItem(KEY, JSON.stringify({ salonId, serviceIds: [...serviceIds] }));
  } catch {
    // Not remembered across a reload; still correct for this page.
  }
}

export function clearCart() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

/** Money and time for a set of picked services. Durations are the salon's own. */
export function cartTotals(services) {
  return {
    count: services.length,
    price: services.reduce((sum, s) => sum + s.price, 0),
    durationMin: services.reduce((sum, s) => sum + s.durationMin, 0),
  };
}
