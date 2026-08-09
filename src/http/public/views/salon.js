import { el } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { dateLong, rupees, time } from '../lib/format.js';
import { ServiceCard } from '../components/ServiceCard.js';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { Modal } from '../components/Modal.js';

export async function renderSalon(container, app, salonId) {
  container.innerHTML = '';
  const cart = new Set();

  const salon = await api(`/api/salons/${salonId}`);
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
  container.append(servicesPanel(salon, cart, updateStickyBar));

  const slotPanel = el('div', 'panel');
  slotPanel.id = 'slotPanel';
  container.append(slotPanel);

  const stickyBar = el('div', 'sticky-booking-bar');
  stickyBar.style.display = 'none';
  container.append(stickyBar);

  function updateStickyBar() {
    if (!cart.size) {
      stickyBar.style.display = 'none';
      slotPanel.innerHTML = '';
      return;
    }
    const picked = salon.services.filter((s) => cart.has(s.serviceId));
    const total = picked.reduce((sum, s) => sum + s.price, 0);

    stickyBar.style.display = 'flex';
    stickyBar.innerHTML = '';
    const info = el('div');
    info.append(el('div', null, `${picked.length} service${picked.length > 1 ? 's' : ''} selected`));
    info.append(el('strong', null, rupees(total)));
    const proceedBtn = Button({
      label: 'Pick date & time →',
      variant: 'primary',
      onClick: () => {
        renderSlots(slotPanel, salon, cart, app);
        slotPanel.scrollIntoView({ behavior: 'smooth' });
      },
    });
    stickyBar.append(info, proceedBtn);
    renderSlots(slotPanel, salon, cart, app);
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
    if (day.full.length) {
      const wrap = el('div', 'slots');
      for (const iso of day.full) {
        const b = el('button', 'slot', time(iso, avail.timezone));
        b.type = 'button';
        b.onclick = () => openConfirm({ iso, salon, picked, total, timezone: avail.timezone, app });
        wrap.append(b);
      }
      slotBox.append(wrap);
      return;
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
  details.append(el('div', 'meta', `SERVICES: ${picked.map((s) => s.name).join(', ')}`));
  const totalRow = el('div', 'row');
  totalRow.style.cssText = 'margin-top:10px; justify-content:space-between';
  totalRow.append(el('span', null, 'Total'), el('strong', null, rupees(total)));
  details.append(totalRow);
  body.append(details);

  body.append(
    el(
      'div',
      'note',
      'Continuing holds this slot for you for a few minutes while you pay. Nothing is charged until you complete payment on the next screen.',
    ),
  );

  const actions = el('div', 'row');
  actions.style.justifyContent = 'flex-end';
  const cancelBtn = Button({ label: 'Cancel', onClick: () => close() });
  const confirmBtn = Button({
    label: 'Continue to payment',
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

        if (!booking.checkout) {
          // A server with no Razorpay keys — development only; start() will not
          // boot without them in production.
          app.navigate('#/bookings');
          return;
        }
        app.navigate(`#/checkout/${booking.id}`);
      } catch (err) {
        const message =
          err instanceof ApiError && err.status === 409
            ? 'That slot was just taken — pick another time.'
            : err.message;
        body.append(el('div', 'out bad', message || 'Booking failed'));
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Continue to payment';
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
