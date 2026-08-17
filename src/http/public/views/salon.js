import { el } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { dateLong, rupees, time } from '../lib/format.js';
import { ServiceCard } from '../components/ServiceCard.js';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { Modal } from '../components/Modal.js';
import { BottomSheet } from '../components/BottomSheet.js';
import { cartFor, cartSalonId, cartTotals, clearCart, saveCart } from '../lib/cart.js';

export async function renderSalon(container, app, salonId) {
  container.innerHTML = '';

  const salon = await api(`/api/salons/${salonId}`);

  // The cart survives a reload and a walk to another page and back, but it
  // belongs to one salon: a booking is with one salon, so opening a different
  // one starts a new cart rather than mixing two menus. The customer is told
  // when that happened — a basket that empties itself with no explanation is
  // the version of this that reads as a bug.
  const previousSalon = cartSalonId();
  const replacedCart = previousSalon !== null && previousSalon !== salonId;
  const cart = new Set(cartFor(salonId));
  // Services the salon has since taken off its menu cannot be booked, so they
  // are dropped rather than carried into a checkout that would 400.
  for (const id of [...cart]) {
    if (!salon.services.some((s) => s.serviceId === id)) cart.delete(id);
  }
  const persist = () => saveCart(salonId, [...cart]);
  persist();
  let isFavorite = false;
  if (app.session) {
    try {
      const { salonIds } = await api('/api/me/favorites');
      isFavorite = salonIds.includes(salonId);
    } catch {
      // favorites are a nice-to-have on this page; a failed fetch shouldn't block the page
    }
  }

  const backBtn = el('a', 'btn sm', '← Back');
  backBtn.href = '#/explore';
  backBtn.style.marginBottom = '14px';
  backBtn.style.display = 'inline-block';
  container.append(backBtn);

  container.append(heroPanel(salon, app, () => isFavorite, (v) => (isFavorite = v)));

  if (replacedCart) {
    container.append(
      el('div', 'note', 'Your earlier selection was for a different salon, so this cart starts empty. '
        + 'One booking, one salon.'),
    );
  }

  const services = servicesPanel(salon, cart, onCartChange);
  container.append(services);

  const slotPanel = el('div', 'panel');
  slotPanel.id = 'slotPanel';
  container.append(slotPanel);

  const stickyBar = el('div', 'sticky-booking-bar');
  stickyBar.style.display = 'none';
  container.append(stickyBar);

  /** The services in the cart, in the salon's own menu order. */
  const picked = () => salon.services.filter((s) => cart.has(s.serviceId));

  function onCartChange() {
    persist();
    drawCartBar();
  }

  function drawCartBar() {
    if (!cart.size) {
      stickyBar.style.display = 'none';
      reserveForCartBar(null);
      slotPanel.innerHTML = '';
      return;
    }
    const chosen = picked();
    const totals = cartTotals(chosen);

    stickyBar.style.display = 'flex';
    stickyBar.innerHTML = '';

    const info = el('div');
    info.append(
      el('div', 'cart-bar-count',
        `${totals.count} service${totals.count > 1 ? 's' : ''} · ${rupees(totals.price)}`),
    );
    info.append(el('div', 'cart-bar-sub', `about ${totals.durationMin} min in the chair`));
    // The summary itself opens the cart: on a phone it is the biggest target
    // on the bar, and tapping what you just added to see it is the gesture
    // people already have.
    info.style.cursor = 'pointer';
    info.onclick = openCart;

    stickyBar.append(
      info,
      Button({ label: 'View cart →', variant: 'primary', onClick: openCart }),
    );

    // The bar is fixed over the bottom of the page, so the page has to end
    // above it. Measured rather than assumed: the bar wraps to two lines at
    // large text sizes, and the services and slot grid below it are exactly
    // what was being hidden.
    reserveForCartBar(stickyBar);

    renderSlots(slotPanel, salon, cart, app);
  }

  /** The review step: everything picked, what it costs, and how to change it. */
  function openCart() {
    const body = el('div');
    body.style.padding = 'var(--space-6)';
    body.append(el('h2', null, 'Your services'));
    body.append(el('p', 'sub', salon.name));

    const lines = el('div', 'cart-lines');
    body.append(lines);
    const totalsRow = el('div', 'cart-totals');
    body.append(totalsRow);

    const actions = el('div', 'row');
    actions.style.cssText = 'margin-top:var(--space-4); gap:10px; justify-content:flex-end; flex-wrap:wrap';

    const draw = () => {
      const chosen = picked();
      lines.innerHTML = '';

      if (chosen.length === 0) {
        lines.append(el('div', 'empty', 'Your cart is empty. Add a service to book.'));
        totalsRow.innerHTML = '';
        actions.style.display = 'none';
        return;
      }
      actions.style.display = 'flex';

      for (const service of chosen) {
        const line = el('div', 'cart-line');
        const grow = el('div', 'grow');
        grow.append(el('div', 'cart-name', service.name));
        grow.append(el('div', 'meta', `${service.durationMin} min · ${service.category}`));
        const remove = el('button', 'cart-remove', 'Remove');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove ${service.name}`);
        remove.onclick = () => {
          cart.delete(service.serviceId);
          onCartChange();
          // The row's own Add button has to stop saying "Added".
          syncServiceButtons(services, cart);
          draw();
        };
        line.append(grow, el('strong', null, rupees(service.price)), remove);
        lines.append(line);
      }

      const totals = cartTotals(chosen);
      totalsRow.innerHTML = '';
      const label = el('div');
      label.append(el('div', null, 'Total'));
      label.append(el('div', 'meta', `${totals.count} service${totals.count > 1 ? 's' : ''} · about ${totals.durationMin} min`));
      totalsRow.append(label, el('div', null, rupees(totals.price)));
    };

    actions.append(
      Button({ label: 'Add more', onClick: () => close() }),
      Button({
        label: 'Pick date & time →',
        variant: 'primary',
        onClick: () => {
          close();
          slotPanel.scrollIntoView({ behavior: 'smooth' });
        },
      }),
    );
    body.append(actions);

    draw();
    const close = BottomSheet(body);
  }

  drawCartBar();
}

/**
 * Tell the page how much room the cart bar is taking at the bottom.
 *
 * `.wrap` adds --cart-bar-height to its bottom padding, so this is what keeps
 * the end of the services list and the whole date-and-time grid scrollable
 * into view instead of stranded under a fixed bar. Pass null when the bar is
 * gone.
 *
 * The observer is here because the bar's height is not a constant: it wraps at
 * a large system font size, and Android's WebView reports a different height
 * once the safe-area insets resolve, which happens after the first paint.
 */
let cartBarObserver = null;

function reserveForCartBar(bar) {
  cartBarObserver?.disconnect();
  cartBarObserver = null;

  if (!bar) {
    document.documentElement.style.setProperty('--cart-bar-height', '0px');
    return;
  }

  const measure = () => {
    document.documentElement.style.setProperty('--cart-bar-height', `${bar.offsetHeight}px`);
  };
  measure();

  if (typeof ResizeObserver === 'function') {
    cartBarObserver = new ResizeObserver(measure);
    cartBarObserver.observe(bar);
  }
}

/**
 * Called when the customer leaves this screen: every other view has no cart
 * bar, and a reservation left behind would put an unexplained gap at the
 * bottom of all of them.
 */
export function releaseCartBarSpace() {
  reserveForCartBar(null);
}

/** Put every Add button back in step with the cart after a change made elsewhere. */
function syncServiceButtons(servicesPanelNode, cart) {
  for (const btn of servicesPanelNode.querySelectorAll('.add-btn[data-service]')) {
    const inCart = cart.has(btn.dataset.service);
    btn.textContent = inCart ? '✓ Added' : 'Add';
    btn.classList.toggle('added', inCart);
    btn.setAttribute('aria-pressed', String(inCart));
  }
}

function heroPanel(salon, app, getFavorite, setFavorite) {
  const panel = el('div', 'panel');
  panel.style.padding = '0';
  panel.style.overflow = 'hidden';

  const imgWrap = el('div', 'aspect cover' + (salon.coverImage ? '' : ' placeholder'));
  if (salon.coverImage) {
    const img = el('img');
    img.src = salon.coverImage;
    img.alt = salon.name;
    imgWrap.append(img);
  } else {
    imgWrap.append(document.createTextNode(salon.name.slice(0, 1).toUpperCase()));
  }
  panel.append(imgWrap);

  const info = el('div');
  info.style.padding = 'var(--space-5)';

  const titleRow = el('div', 'row');
  titleRow.style.justifyContent = 'space-between';
  titleRow.append(el('h1', null, salon.name));
  titleRow.append(
    Badge({
      text: salon.rating == null ? 'New' : `★ ${salon.rating.toFixed(1)} (${salon.reviewCount})`,
      tone: 'ok',
    }),
  );
  info.append(titleRow);

  info.append(el('div', 'meta', `📍 ${salon.address}`));
  info.append(
    Badge({
      text: salon.openNow ? (salon.closesAt ? `Open · closes ${salon.closesAt}` : 'Open') : 'Closed now',
      tone: salon.openNow ? 'ok' : 'bad',
    }),
  );

  const actions = el('div', 'row');
  actions.style.marginTop = 'var(--space-4)';
  const dirBtn = Button({
    label: '📍 Directions',
    size: 'sm',
    onClick: () => window.open(`https://maps.google.com/?q=${salon.lat},${salon.lng}`, '_blank', 'noopener'),
  });
  actions.append(dirBtn);

  if (app.session) {
    const favBtn = Button({
      label: getFavorite() ? '♥ Saved' : '♡ Save',
      size: 'sm',
      onClick: async () => {
        const next = !getFavorite();
        favBtn.disabled = true;
        try {
          if (next) await api('/api/me/favorites', { method: 'POST', body: JSON.stringify({ salonId: salon.id }) });
          else await api(`/api/me/favorites/${salon.id}`, { method: 'DELETE' });
          setFavorite(next);
          favBtn.textContent = next ? '♥ Saved' : '♡ Save';
        } finally {
          favBtn.disabled = false;
        }
      },
    });
    actions.append(favBtn);
  } else {
    actions.append(Button({ label: '♡ Save', size: 'sm', onClick: () => app.navigate('#/login') }));
  }
  info.append(actions);
  panel.append(info);
  return panel;
}

function servicesPanel(salon, cart, onChange) {
  const panel = el('div', 'panel');
  panel.append(el('h2', null, 'Select services'));

  const byCategory = new Map();
  for (const s of salon.services) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category).push(s);
  }

  const list = el('div', 'list');
  for (const [, services] of byCategory) {
    for (const service of services) {
      const row = ServiceCard(service, {
        selected: cart.has(service.serviceId),
        onToggle: (id, checked) => {
          checked ? cart.add(id) : cart.delete(id);
          onChange();
        },
      });
      list.append(row);
    }
  }
  panel.append(list);
  return panel;
}

async function renderSlots(slotPanel, salon, cart, app) {
  slotPanel.innerHTML = '';
  const picked = salon.services.filter((s) => cart.has(s.serviceId));
  const total = picked.reduce((sum, s) => sum + s.price, 0);
  panelLoading(slotPanel);

  let avail;
  try {
    avail = await api(`/api/salons/${salon.id}/availability`, {
      method: 'POST',
      body: JSON.stringify({ serviceIds: [...cart] }),
    });
  } catch (err) {
    slotPanel.innerHTML = '';
    slotPanel.append(el('div', 'out bad', err.message || 'Could not load availability'));
    return;
  }

  slotPanel.innerHTML = '';
  slotPanel.append(el('h2', null, 'Pick date & time'));

  const infoRow = el('div', 'row');
  infoRow.style.marginBottom = 'var(--space-4)';
  infoRow.append(Badge({ text: `${picked.length} service${picked.length > 1 ? 's' : ''}`, tone: 'brand' }));
  infoRow.append(Badge({ text: `${avail.requiredMin} min` }));
  infoRow.append(el('strong', null, rupees(total)));
  slotPanel.append(infoRow);

  let day = avail.days.find((d) => d.state === 'full') || avail.days[0];

  const strip = el('div', 'strip');
  slotPanel.append(strip);
  const slotBox = el('div');
  slotBox.style.marginTop = 'var(--space-4)';
  slotPanel.append(slotBox);

  function drawDays() {
    strip.innerHTML = '';
    for (const d of avail.days) {
      const dt = new Date(d.date + 'T00:00:00Z');
      const dead = d.state === 'closed' || d.state === 'none';
      const b = el('button', 'day');
      b.type = 'button';
      b.disabled = dead;
      b.append(el('div', 'dow', ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()]));
      b.append(el('div', 'num', String(dt.getUTCDate())));
      const label =
        d.state === 'closed'
          ? d.closedReason === 'holiday'
            ? 'holiday'
            : 'closed'
          : d.state === 'none'
            ? 'full'
            : d.state === 'partial'
              ? 'partial'
              : `${d.full.length} slots`;
      const st = el('div', 'st', label);
      st.style.color = d.state === 'full' ? 'var(--ok)' : d.state === 'partial' ? 'var(--warn)' : 'var(--dim)';
      b.append(st);
      b.setAttribute('aria-label', `${d.date}, ${label}`);
      b.setAttribute('aria-pressed', String(day.date === d.date));
      if (!dead) b.onclick = () => { day = d; drawDays(); drawDayDetail(); };
      strip.append(b);
    }
  }

  function drawDayDetail() {
    slotBox.innerHTML = '';
    if (day.state === 'closed') {
      slotBox.append(el('div', 'empty', day.closedReason === 'holiday' ? 'Closed for a holiday.' : 'Closed this day.'));
      return;
    }

    // Every start time the cart fits into, taken ones included. A slot the
    // salon has already sold out is shown as sold out rather than hidden —
    // hiding it looks like the salon does not work at that hour, and the
    // customer cannot tell "3 chairs, all busy" from "closed".
    if (day.slots?.length) {
      if (day.capacity > 1) {
        slotBox.append(
          el('div', 'meta', `${day.capacity} chairs — each time can take ${day.capacity} bookings at once.`),
        );
      }
      const wrap = el('div', 'slots');
      for (const slot of day.slots) {
        wrap.append(
          slotButton(slot, day.capacity, avail.timezone, () =>
            openConfirm({ iso: slot.at, salon, picked, total, timezone: avail.timezone, app }),
          ),
        );
      }
      slotBox.append(wrap);
      if (day.full.length) return;
      // Sold out at every time the cart fits — but there may still be a gap
      // that one of the picked services would fit into, and that is worth
      // offering rather than an apology.
      if (!day.partial.length) {
        slotBox.append(el('div', 'note', 'Every chair is taken at every time on this day. Try another date.'));
        return;
      }
    }

    // Nothing fits the whole cart today — the honest fallback from spec §2, not an empty screen.
    if (day.partial.length) {
      const box = el('div', 'note');
      box.append(el('div', null, 'Nothing on this day fits everything you picked.'));
      for (const p of day.partial) {
        box.append(el('div', null, `${time(p.at, avail.timezone)} — only ${p.suggest.name} (${rupees(p.suggest.price)}) would fit, ${p.freeMin} min free`));
      }
      const next = avail.days.find((d) => d.state === 'full');
      if (next) box.append(el('div', null, `Full booking available on ${dateLong(next.date + 'T00:00:00Z', avail.timezone)}.`));
      slotBox.append(box);
      return;
    }
    slotBox.append(el('div', 'empty', 'No slots available on this date.'));
  }

  drawDays();
  drawDayDetail();
}

/**
 * One start time, and how much of the salon is still free at it.
 *
 * A one-chair salon says nothing on an open slot — "1 left" on every button is
 * noise when one is all there ever is. It says "Full" when the chair is gone,
 * because that is the whole story. A salon with chairs to spare counts them
 * down, so a customer can see a popular time filling up before it closes.
 */
function slotButton(slot, capacity, timezone, onPick) {
  const soldOut = slot.state === 'full';
  const label = time(slot.at, timezone);
  const b = el('button', `slot ${slot.state}`);
  b.type = 'button';
  b.append(el('span', 'slot-time', label));

  const caption = soldOut ? 'Full' : capacity > 1 ? `${slot.remaining} of ${capacity} free` : '';
  if (caption) b.append(el('span', 'slot-cap', caption));

  b.disabled = soldOut;
  b.setAttribute(
    'aria-label',
    `${label} — ${soldOut ? 'fully booked' : `${slot.remaining} of ${capacity} chairs free`}`,
  );
  if (!soldOut) b.onclick = onPick;
  return b;
}

function panelLoading(slotPanel) {
  slotPanel.append(el('div', 'empty', 'Loading availability…'));
}

function openConfirm({ iso, salon, picked, total, timezone, app }) {
  const body = el('div');
  body.style.padding = 'var(--space-6)';
  body.append(el('h2', null, 'Confirm booking'));
  body.append(el('p', 'sub', 'Review the details before confirming.'));

  const details = el('div', 'panel');
  details.style.background = 'var(--surface-2)';
  details.append(el('div', 'meta', `SALON: ${salon.name}`));
  details.append(el('div', 'meta', `WHEN: ${dateLong(iso, timezone)} at ${time(iso, timezone)}`));

  // Every service, priced, rather than a comma-separated list of names. This
  // is the last screen before money moves and before a chair is held, so what
  // is being bought is itemised.
  details.append(el('div', 'meta', 'SERVICES'));
  const lines = el('div', 'cart-lines');
  for (const service of picked) {
    const line = el('div', 'cart-line');
    const grow = el('div', 'grow');
    grow.append(el('div', 'cart-name', service.name));
    grow.append(el('div', 'meta', `${service.durationMin} min`));
    line.append(grow, el('strong', null, rupees(service.price)));
    lines.append(line);
  }
  details.append(lines);

  const totals = cartTotals(picked);
  const totalRow = el('div', 'cart-totals');
  const totalLabel = el('div');
  totalLabel.append(el('div', null, 'Total'));
  totalLabel.append(
    el('div', 'meta', `${totals.count} service${totals.count > 1 ? 's' : ''} · about ${totals.durationMin} min`),
  );
  totalRow.append(totalLabel, el('div', null, rupees(total)));
  details.append(totalRow);
  body.append(details);

  // Whether there is a payment step at all is the server's answer, not a
  // guess: /api/config reports it, and POST /api/bookings 503s when payments
  // are off and unpaid bookings are not allowed either.
  const payments = app.config?.razorpay?.enabled === true;

  body.append(
    el(
      'div',
      'note',
      payments
        ? 'Continuing holds this slot for you for a few minutes while you pay. Nothing is charged until you complete payment on the next screen.'
        : 'Payment is not enabled on this deployment, so this booking is confirmed without charge. The salon is expecting you.',
    ),
  );

  const actions = el('div', 'row');
  actions.style.justifyContent = 'flex-end';
  const cancelBtn = Button({ label: 'Cancel', onClick: () => close() });
  const confirmBtn = Button({
    label: payments ? 'Continue to payment' : 'Confirm booking',
    variant: 'primary',
    onClick: async () => {
      if (!app.session) {
        close();
        app.navigate('#/login');
        return;
      }
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Holding your slot…';
      try {
        // The chair is taken here, not on the payment screen. A booking that
        // reaches checkout is one nobody else can take out from under it.
        // Idempotency-Key means a retry on a flaky connection replays this
        // response instead of holding a second chair.
        const booking = await api('/api/bookings', {
          method: 'POST',
          headers: { 'idempotency-key': idempotencyKey(salon.id, picked, iso) },
          body: JSON.stringify({ salonId: salon.id, serviceIds: picked.map((s) => s.serviceId), startAt: iso }),
        });
        close();
        // The cart has been spent: these services are on a booking now, and a
        // basket still sitting there afterwards invites booking them twice.
        clearCart();

        if (!booking.checkout) {
          // No payment provider is configured, so the booking is already
          // reserved and there is nothing to pay. There
          // is no Pay screen to send them to, and pretending otherwise is how
          // a customer ends up believing they paid.
          app.navigate('#/bookings');
          return;
        }
        app.navigate(`#/checkout/${booking.id}`);
      } catch (err) {
        const message =
          err instanceof ApiError && err.status === 409
            ? 'That slot was just taken — pick another time.'
            : err instanceof ApiError && err.code === 'PAYMENTS_DISABLED'
              ? 'This deployment cannot take bookings yet — payments are not set up.'
              : err.message;
        body.append(el('div', 'out bad', message || 'Booking failed'));
        confirmBtn.disabled = false;
        confirmBtn.textContent = payments ? 'Continue to payment' : 'Confirm booking';
      }
    },
  });
  actions.append(cancelBtn, confirmBtn);
  body.append(actions);

  const close = Modal(body);
}

/**
 * Stable for the same cart at the same slot, so a double-tap or a retry is one
 * booking — and different the moment the customer changes anything, so a
 * genuine second booking is never swallowed.
 */
function idempotencyKey(salonId, picked, iso) {
  return [salonId, iso, ...picked.map((s) => s.serviceId).sort()].join('|');
}
