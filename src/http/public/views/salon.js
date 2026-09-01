import { el } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { dateLong, rupees, time } from '../lib/format.js';
import { ServiceCard } from '../components/ServiceCard.js';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { Modal } from '../components/Modal.js';
import { BottomSheet } from '../components/BottomSheet.js';
import { Stepper } from '../components/Stepper.js';
import { ImageCarousel } from '../components/ImageCarousel.js';
import { HeartButton } from '../components/HeartButton.js';
import { CategoryNav, scrollToSection } from '../components/CategoryNav.js';
import { cartFor, cartSalonId, cartTotals, clearCart, saveCart } from '../lib/cart.js';
import { loadFavorites } from '../lib/favorites.js';
import { iconEl } from '../lib/icons.js';

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
  // The saved list, from the one cache the cards share — so the heart here
  // and the heart on the card this page was opened from are the same fact.
  try {
    await loadFavorites({ signedIn: Boolean(app.session) });
  } catch {
    // favorites are a nice-to-have on this page; a failed fetch shouldn't block the page
  }

  const backBtn = el('a', 'btn sm', '← Back');
  backBtn.href = '#/explore';
  backBtn.style.marginBottom = '14px';
  backBtn.style.display = 'inline-block';
  container.append(backBtn);

  container.append(heroPanel(salon, app));

  if (replacedCart) {
    container.append(
      el('div', 'note', 'Your earlier selection was for a different salon, so this cart starts empty. '
        + 'One booking, one salon.'),
    );
  }

  // Where the customer is in the flow. The steps were always real — choose
  // services, choose a slot, review — but nothing said which one you were on,
  // so the flow had no shape and no end in sight.
  const steps = Stepper(['Services', 'Date & time', 'Confirm'], 0);
  container.append(steps);

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
      steps.update(0);
      stickyBar.style.display = 'none';
      reserveForCartBar(null);
      slotPanel.innerHTML = '';
      return;
    }
    // Something is in the cart, so step one is behind us and the slot grid
    // below is what the customer is being asked for next.
    steps.update(1);
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

    renderSlots(slotPanel, salon, cart, app, steps);
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

/**
 * The salon's photos, its name, and the two things you can do from the top of
 * the page: save it, or find it.
 *
 * The photo used to be a single static shot even when the salon had six. It is
 * a carousel now — automatic, swipeable, and only when there is more than one
 * picture to show. Nothing is stretched: every image is object-fit: cover
 * inside the same 21:9 box the page always used.
 */
function heroPanel(salon, app) {
  const panel = el('div', 'panel salon-hero');
  panel.style.padding = '0';
  panel.style.overflow = 'hidden';

  const media = el('div', 'salon-hero-media');
  // cover_url first, then the gallery, with duplicates dropped — the API
  // already falls back to photos[0] for the cover, so without this a salon
  // with one gallery photo and no upload would show it twice.
  const shots = [...new Set([salon.coverImage, ...(salon.photos ?? [])].filter(Boolean))];
  media.append(ImageCarousel(shots, { alt: salon.name, aspect: 'cover', placeholder: salon.name }));

  // The heart rides on the photo, top right, where a save lives on every
  // other app people use. It is a button over a carousel: its own handlers
  // stop the press from reaching the swipe underneath.
  const heart = HeartButton(salon.id, {
    signedIn: Boolean(app.session),
    label: salon.name,
    size: 'lg',
    onRequireSignIn: () => app.signIn(),
  });
  const heartSlot = el('div', 'salon-hero-heart');
  heartSlot.append(heart);
  media.append(heartSlot);
  panel.append(media);

  const info = el('div', 'salon-hero-info');

  const titleRow = el('div', 'row');
  titleRow.style.justifyContent = 'space-between';
  titleRow.append(el('h1', null, salon.name));
  // "New" is not a score. Rendering it in the same green badge as ★4.8 made a
  // salon nobody had reviewed look like a well-rated one — the same fix the
  // discovery cards got.
  titleRow.append(
    salon.rating == null
      ? el('span', 'pill outline', 'New')
      : Badge({ text: `★ ${salon.rating.toFixed(1)} (${salon.reviewCount})`, tone: 'ok' }),
  );
  info.append(titleRow);

  // The facts under the name, on one line and at one weight, rather than an
  // address in grey with a status badge floating below it.
  const facts = el('div', 'row');
  facts.style.marginTop = 'var(--space-2)';
  facts.append(
    el(
      'span',
      'pill dot ' + (salon.openNow ? 'ok' : 'bad'),
      salon.openNow ? (salon.closesAt ? `Open till ${salon.closesAt}` : 'Open now') : 'Closed now',
    ),
  );
  const addressFact = el('span', 'meta');
  addressFact.append(iconEl('pin', { size: 15 }), document.createTextNode(salon.address));
  facts.append(addressFact);
  if (salon.fromPrice != null) facts.append(el('span', 'meta', `from ${rupees(salon.fromPrice)}`));
  info.append(facts);

  const actions = el('div', 'row');
  actions.style.marginTop = 'var(--space-4)';
  actions.append(Button({
    label: 'Directions',
    icon: 'navigation',
    size: 'sm',
    onClick: () => window.open(`https://maps.google.com/?q=${salon.lat},${salon.lng}`, '_blank', 'noopener'),
  }));
  // The heart above is the save. This is the same action named, for anyone who
  // does not read an icon as a control — it drives the very same button, so
  // there is one state and one request behind both.
  const saveText = el('button', 'btn sm salon-save-text');
  saveText.type = 'button';
  const paintSaveText = () => {
    const saved = heart.getAttribute('aria-pressed') === 'true';
    saveText.textContent = saved ? 'Saved' : 'Save';
    saveText.setAttribute('aria-pressed', String(saved));
  };
  paintSaveText();
  saveText.onclick = () => heart.click();
  // The heart repaints on its own — from this click, or from a card elsewhere
  // — so the label follows it rather than guessing.
  new MutationObserver(paintSaveText).observe(heart, { attributes: true, attributeFilter: ['aria-pressed'] });
  actions.append(saveText);
  info.append(actions);

  panel.append(info);
  return panel;
}

/**
 * The salon's menu: a sticky category bar, then one section per category.
 *
 * The categories are the salon's own — whatever `category` its active services
 * carry, in the order the API returns them (it orders by category, then name).
 * Nothing is hardcoded here, so a salon that only does facials gets one chip
 * and a category added to the catalogue needs no change in this file.
 */
function servicesPanel(salon, cart, onChange) {
  const panel = el('div', 'panel services-panel');

  const head = el('div', 'section-head');
  head.append(el('h2', null, 'Select services'));
  head.append(el('span', 'meta', `${salon.services.length} on the menu`));
  panel.append(head);

  const byCategory = new Map();
  for (const s of salon.services) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category).push(s);
  }

  const categories = [...byCategory.keys()];
  const idFor = (category) => `svc-${slug(category)}`;

  // One category is not a menu: a single chip that scrolls to the only
  // section on the page is decoration.
  let nav = null;
  if (categories.length > 1) {
    nav = CategoryNav(
      [
        { id: 'all', label: 'Services', count: salon.services.length },
        ...categories.map((c) => ({ id: idFor(c), label: labelFor(c), count: byCategory.get(c).length })),
      ],
      {
        onSelect: (id) => {
          // Clicking is a statement about where you want to be, so the
          // highlight moves immediately rather than waiting for the scroll to
          // arrive — and the observer below is muted while it travels.
          nav.setActive(id);
          suppressSpy();
          const target = id === 'all' ? panel : panel.querySelector(`#${id}`);
          if (target) scrollToSection(target, stickyOffset(nav));
        },
      },
    );
    panel.append(nav);
  }

  const sections = [];
  for (const [category, services] of byCategory) {
    const section = el('section', 'service-section');
    section.id = idFor(category);
    // Room for the sticky bar when the browser scrolls to this on its own
    // (an in-page link, a find-in-page hit).
    section.style.scrollMarginTop = 'calc(var(--app-header-height, 0px) + 88px)';
    const title = el('div', 'service-section-head');
    title.append(el('h3', null, labelFor(category)));
    title.append(el('span', 'meta', `${services.length} service${services.length > 1 ? 's' : ''}`));
    section.append(title);

    const list = el('div', 'list');
    for (const service of services) {
      list.append(ServiceCard(service, {
        selected: cart.has(service.serviceId),
        onToggle: (id, checked) => {
          checked ? cart.add(id) : cart.delete(id);
          onChange();
        },
      }));
    }
    section.append(list);
    panel.append(section);
    sections.push(section);
  }

  // ---- which section am I looking at ----
  let spySuppressedUntil = 0;
  const suppressSpy = () => { spySuppressedUntil = Date.now() + 900; };

  if (nav && typeof IntersectionObserver === 'function') {
    const visible = new Set();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        if (Date.now() < spySuppressedUntil) return;
        if (!nav.isConnected) {
          observer.disconnect();
          return;
        }
        // The topmost section still on screen, in menu order.
        const current = sections.map((s) => s.id).find((id) => visible.has(id));
        nav.setActive(current ?? 'all');
      },
      // A band just under the sticky bar: a section counts as "the one you are
      // reading" while its top is in the upper part of the viewport.
      { rootMargin: '-150px 0px -55% 0px', threshold: 0 },
    );
    for (const section of sections) observer.observe(section);
    nav.setActive('all');
  }

  return panel;
}

/** A category name as a chip label: 'hair' -> 'Hair', 'hair_color' -> 'Hair color'. */
function labelFor(category) {
  const words = String(category).replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Other';
}

/** A category name as an element id. Never interpolated into HTML. */
function slug(category) {
  return String(category).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
}

/**
 * How much is covering the top of the page: the app header, which is sticky
 * and wraps, plus the menu bar itself. Measured rather than assumed — the
 * header is taller on a phone with a notch and taller again when it wraps.
 */
function stickyOffset(nav) {
  const header = document.querySelector('.topbar');
  return (header?.offsetHeight ?? 0) + (nav?.offsetHeight ?? 0) + 12;
}

async function renderSlots(slotPanel, salon, cart, app, steps) {
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
            openConfirm({ iso: slot.at, salon, picked, total, timezone: avail.timezone, app, steps }),
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

function openConfirm({ iso, salon, picked, total, timezone, app, steps }) {
  // The last step, and the sheet says so. Picking a slot is what advances it;
  // backing out of the sheet without booking returns the customer to step two,
  // which is where they actually are again.
  steps?.update(2);

  const body = el('div');
  body.style.padding = 'var(--space-6)';
  body.append(el('h2', null, 'Review & confirm'));
  body.append(el('p', 'sub', `Step 3 of 3 · nothing is booked until you confirm.`));

  const details = el('div', 'panel');
  details.style.background = 'var(--surface-2)';

  // Label above value, rather than "SALON: Fade Room" run together on one
  // line. This is the last screen before a chair is held, so the two things a
  // customer actually re-reads — where, and when — are the two things set
  // largest.
  const factRow = (label, value) => {
    const row = el('div', 'review-fact');
    row.append(el('div', 'review-label', label));
    row.append(el('div', 'review-value', value));
    return row;
  };
  details.append(factRow('Salon', salon.name));
  details.append(factRow('When', `${dateLong(iso, timezone)} at ${time(iso, timezone)}`));

  // Every service, priced, rather than a comma-separated list of names. This
  // is the last screen before money moves and before a chair is held, so what
  // is being bought is itemised.
  details.append(el('div', 'review-label', 'Services'));
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
  // Backing out is not abandoning the booking — the cart and the slot grid are
  // still there — so the stepper goes back to where the customer now is.
  const cancelBtn = Button({ label: 'Back', onClick: () => { steps?.update(1); close(); } });
  const confirmBtn = Button({
    label: payments ? 'Continue to payment' : 'Confirm booking',
    variant: 'primary',
    onClick: async () => {
      if (!app.session) {
        close();
        app.navigate('#/login');
        return;
      }
      // The design system's loading state: the label stays, so the button
      // keeps its width and the row does not reflow mid-tap. Swapping the text
      // for "Holding your slot…" resized the button under the finger that had
      // just pressed it.
      confirmBtn.setLoading(true);
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
        confirmBtn.setLoading(false);
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
