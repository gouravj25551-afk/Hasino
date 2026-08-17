/**
 * business.html's shell.
 *
 * External rather than inline because the CSP is `script-src 'self'`
 * with no 'unsafe-inline' — an inline module script is blocked outright,
 * which renders the page blank. Keeping the strict policy and moving the
 * code out is the right trade; the alternative weakens CSP for every page
 * to save one file.
 */
import { currentIdToken, watchAuthState, signOut } from './lib/auth.js';
import { ask } from './lib/dialog.js';
import { installBackHandler } from './lib/backbutton.js';

const $  = (s, r = document) => r.querySelector(s);
const el = (t, cls, txt) => { const n = document.createElement(t); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const rupees = p => '₹' + (p / 100).toLocaleString('en-IN');
const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

let tz = 'Asia/Kolkata';
const time = iso => new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });

/**
 * Every /api/business/* route resolves the salon from the signed-in owner, so
 * there is no salon id to pass and no identity to pick — you are whoever
 * Google says you are.
 */
async function api(path, opts = {}) {
  let token = null;
  try { token = await currentIdToken(); } catch { /* Clerk unconfigured — request goes out unauthenticated and 401s honestly */ }
  const res = await fetch(path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body, status: res.status });
  return body;
}

/**
 * Gate the panel on a signed-in owner. /api/me tells us who they are; the
 * role check is the server's, not ours — every /api/business/* route runs
 * requireRole(s, 'business') before it does anything.
 */
async function initIdentity() {
  const who = $('#whoami');
  const exit = $('#exit');
  exit.innerHTML = '';

  /**
   * The way out of this panel, for people it does not belong to.
   *
   * A salon account does not get one. The server already knows this account is
   * a salon — `role` on /api/me, derived from the owner_id relationship, not
   * from anything about the email — so offering "← Customer app" beside the
   * dashboard presents a choice of panels where there is no choice to make.
   * Someone signed out, or signed in without a salon, is looking at a panel
   * that is genuinely not theirs and does need the door.
   */
  const showExit = () => {
    const link = el('a', 'btn sm', '← Customer app');
    link.href = '/';
    exit.append(link);
  };

  try {
    const me = await api('/api/me');
    who.innerHTML = '';
    who.append(el('span', 'meta', me.name || me.email || me.phone));
    const out = el('button', 'btn sm', 'Sign out');
    out.onclick = async () => { await signOut(); location.reload(); };
    who.append(out);
    if (me.role !== 'business') showExit();
    return me;
  } catch (err) {
    who.innerHTML = '';
    const link = el('a', 'btn sm primary', 'Sign in');
    link.href = '/#/login';
    who.append(link);
    showExit();
    return null;
  }
}

/** Shown instead of the panel when the caller is not a salon owner. */
function renderNotAnOwner(err) {
  const view = $('#view');
  view.innerHTML = '';
  const box = el('div', 'panel');
  if (err && err.status === 403) {
    box.append(el('h1', null, 'This account does not manage a salon'));
    box.append(el('p', 'sub',
      'The salon panel is for salon owners. If you have applied to list a salon, it is waiting for review.'));
  } else if (err && (err.status === 401 || err.body?.code === 'NO_TOKEN')) {
    box.append(el('h1', null, 'Sign in to manage your salon'));
    box.append(el('p', 'sub', 'Use the Google account your salon was registered with.'));
    const link = el('a', 'btn primary', 'Sign in');
    link.href = '/#/login';
    box.append(link);
  } else {
    box.append(el('h1', null, 'Could not load the panel'));
    box.append(el('p', 'sub', err?.message || 'Unknown error'));
  }
  view.append(box);
}

const routes = {
  '#/today': todayView, '#/services': servicesView, '#/timings': timingsView,
  '#/insights': insightsView, '#/payouts': payoutsView,
};

/**
 * Android's back button. Today is this panel's root: an owner is sent straight
 * here on launch, so there is no customer app behind it to go back to — the
 * press exits, as it would from any app's first screen. From Services,
 * Timings, Insights or Payouts it walks back through the panel instead of
 * quitting, which is what it used to do.
 */
installBackHandler({
  isRoot: () => (location.hash || '#/today') === '#/today',
  homeHash: '#/today',
});

function render() {
  const hash = location.hash || '#/today';
  for (const a of document.querySelectorAll('[data-nav]')) a.removeAttribute('aria-current');
  $(`[data-nav="${hash.slice(2)}"]`)?.setAttribute('aria-current', 'page');
  (routes[hash] || todayView)().catch(showError);
}

function showError(err) {
  $('#view').innerHTML = '';
  $('#view').append(el('div', 'out bad', `${err.status || ''} ${err.body?.code || ''}\n${err.message}`));
}

/**
 * A Save button that says whether what is on screen has actually been saved.
 *
 * "Saved" is written by the response, never by the click: the label changes
 * only after the API has answered, and the values it answered for are recorded
 * as the baseline. Touch any field afterwards and it is "Save" again, because
 * what is on screen is no longer what the salon's customers would see.
 *
 * @param {object} opts
 * @param {string} opts.label            what it says with unsaved changes
 * @param {HTMLElement[]} opts.watch     fields whose edits un-save it
 * @param {() => string} opts.snapshot   the values, as a comparable string
 * @param {() => Promise<void>} opts.submit
 * @param {(err: Error) => void} opts.onError
 */
function saveButton({ label = 'Save', className = 'btn primary', watch, snapshot, submit, onError }) {
  const btn = el('button', className, label);
  let savedAt = null; // the snapshot the server last confirmed

  const paint = () => {
    const saved = savedAt !== null && snapshot() === savedAt;
    btn.textContent = saved ? 'Saved' : label;
    btn.disabled = saved;
    btn.classList.toggle('is-saved', saved);
  };

  for (const node of watch) {
    // 'input' covers typing; 'change' covers checkboxes, selects and the date
    // pickers, which do not fire 'input' everywhere.
    node.addEventListener('input', paint);
    node.addEventListener('change', paint);
  }

  btn.onclick = async () => {
    const attempted = snapshot();
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await submit();
      // Only now. A failed save must leave the button saying Save.
      savedAt = attempted;
    } catch (err) {
      onError?.(err);
    } finally {
      paint();
    }
  };

  paint();
  return btn;
}

function toast(node, msg, bad) {
  const box = el('div', 'out ' + (bad ? 'bad' : 'ok'), msg);
  node.append(box);
  setTimeout(() => box.remove(), 3200);
}

/**
 * [No-show], and the customer's grace period in front of it.
 *
 * A no-show costs the customer the whole amount and counts toward a 30-day
 * block, so the salon may not declare one until the customer is 15 minutes
 * late. The server decides that — this button only draws the decision, using
 * `noShowAvailableAt` from the booking and the server's clock, never the shop
 * phone's. Pressing it early is refused by the API regardless (409
 * NO_SHOW_TOO_EARLY); a disabled button is the courtesy, not the control.
 *
 * The button arms itself when the minute arrives rather than waiting for a
 * reload: a barber standing at the counter at 10:14 should not have to work
 * out that they need to refresh.
 */
function noShowButton(booking, serverTime, graceMin, send) {
  const availableAt = Date.parse(booking.noShowAvailableAt);
  const ns = el('button', 'btn sm danger');

  const arm = () => {
    ns.textContent = 'No-show';
    ns.disabled = false;
    ns.removeAttribute('title');
    ns.onclick = async () => {
      const ok = await ask({
        title: 'Mark as a no-show?',
        message: 'The customer is not refunded.',
        confirmLabel: 'Mark no-show',
        danger: true,
      });
      if (ok) send('no-show');
    };
  };

  if (!Number.isFinite(availableAt) || serverTime() >= availableAt) {
    arm();
    return ns;
  }

  ns.disabled = true;
  ns.title = `A customer gets ${graceMin} minutes past their booking time before they can be marked absent.`;

  // Counted down, not just stated: a barber standing at the counter wants to
  // know how long, and "in 8 min" answers that where a clock time makes them
  // work it out. Far-off bookings get the time instead — "in 214 min" is not
  // an answer anybody wanted.
  const paint = () => {
    const leftMs = availableAt - serverTime();
    if (leftMs <= 0) return arm();
    const mins = Math.ceil(leftMs / 60_000);
    ns.textContent = mins <= 60 ? `No-show in ${mins} min` : `No-show after ${time(booking.noShowAvailableAt)}`;
  };
  paint();

  // Ticks while the wait is short enough to be watched, and arms itself on the
  // minute — the barber should not have to reload the screen to be allowed to
  // do the thing the screen is telling them they may do shortly.
  const wait = availableAt - serverTime();
  if (wait <= 60 * 60_000) {
    const tick = setInterval(() => {
      if (!ns.isConnected) return clearInterval(tick);
      if (availableAt - serverTime() <= 0) {
        clearInterval(tick);
        arm();
        return;
      }
      paint();
    }, 15_000);
    setTimeout(() => {
      clearInterval(tick);
      arm();
    }, wait + 1000);
  }
  return ns;
}

/* ---------- screen 3+4: today's bookings ---------- */
const STATUS_PILL = {
  booked: 'brand', verified: 'brand', in_progress: 'warn', completed: 'ok',
  no_show: 'bad', cancelled_by_salon: 'bad', cancelled_by_customer: 'bad', rescheduled: '',
};

let currentDate = null;

async function todayView() {
  const view = $('#view');
  view.innerHTML = '';

  const overview = await api('/api/business/overview');
  tz = overview.salon.timezone;
  if (!currentDate) currentDate = overview.today;

  view.append(el('h1', null, overview.salon.name));
  view.append(el('p', 'sub', `${overview.salon.status} · ${tz}`));

  const ctrl = el('div', 'row');
  ctrl.style.marginBottom = '16px';
  const date = el('input');
  date.type = 'date';
  date.value = currentDate;
  date.style.maxWidth = '190px';
  date.onchange = () => { currentDate = date.value; todayView(); };
  ctrl.append(date);

  const close = el('button', 'btn danger', 'Close for this day');
  close.onclick = async () => {
    const ok = await ask({
      title: `Close for ${currentDate}?`,
      message: 'Every booking on this day is cancelled and refunds are queued. This cannot be undone.',
      confirmLabel: 'Close for the day',
      danger: true,
    });
    if (!ok) return;
    const r = await api('/api/business/close-today', { method: 'POST', body: JSON.stringify({ date: currentDate }) });
    toast(view, `Cancelled ${r.cancelled} booking(s).\n${r.refunds}`);
    todayView();
  };
  ctrl.append(close);
  view.append(ctrl);

  // The salon's own photo lives on the screen the owner opens every morning.
  // Buried behind a nav item, a salon with no picture stays a salon with no
  // picture.
  view.append(salonImagePanel(overview.salon));

  const { bookings, serverNow, noShowGraceMin } = await api('/api/business/bookings?date=' + currentDate);
  // How far this device's clock is from the server's. Every "is it time yet?"
  // below is asked through this, because the no-show gate is enforced against
  // the server's clock and a shop phone is often minutes out.
  const clockSkewMs = serverNow ? Date.parse(serverNow) - Date.now() : 0;
  const serverTime = () => Date.now() + clockSkewMs;
  if (!bookings.length) { view.append(el('div', 'empty', 'No bookings on this day.')); return; }

  const list = el('div', 'list');
  for (const b of bookings) {
    const item = el('div', 'item');

    const when = el('div');
    when.append(el('div', 'when', time(b.startAt) + '–' + time(b.endAt)));
    when.append(el('div', 'meta', rupees(b.amount)));
    item.append(when);

    const grow = el('div', 'grow');
    grow.append(el('div', null, b.customerName || 'Customer'));
    // Google sign-in carries no phone, so most customers have none on file.
    const contact = b.customerPhone || b.customerEmail || 'no contact on file';
    grow.append(el('div', 'meta', `${contact} · ${b.services.join(', ') || '—'}`));
    item.append(grow);

    if (b.refundStatus !== 'none') item.append(el('span', 'pill warn', 'refund ' + b.refundStatus));
    item.append(el('span', 'pill ' + (STATUS_PILL[b.status] ?? ''), b.status.replace(/_/g, ' ')));

    const act = el('div', 'row');
    const send = async (action, body) => {
      try {
        await api(`/api/business/bookings/${b.id}/${action}`, { method: 'POST', body: JSON.stringify(body || {}) });
        todayView();
      } catch (err) { toast(view, `${err.body?.code || ''} ${err.message}`, true); }
    };

    if (b.status === 'booked') {
      const verify = el('button', 'btn sm primary', 'Verify code');
      verify.onclick = async () => {
        const answer = await ask({
          title: 'Verify booking',
          message: `${b.customerName || 'The customer'} reads you the code from their booking.`,
          confirmLabel: 'Verify',
          input: { label: "Customer's 6-digit code", placeholder: '123456', type: 'text' },
        });
        if (answer?.value) send('verify', { code: answer.value });
      };
      act.append(verify);
      act.append(noShowButton(b, serverTime, noShowGraceMin ?? 15, send));
    }
    if (b.status === 'verified') {
      const start = el('button', 'btn sm primary', 'Start');
      start.onclick = () => send('start');
      act.append(start);
    }
    if (b.status === 'in_progress') {
      const done = el('button', 'btn sm primary', 'Complete');
      done.onclick = () => send('complete');
      act.append(done);
    }
    if (['booked', 'verified', 'in_progress'].includes(b.status)) {
      const cancel = el('button', 'btn sm', 'Cancel');
      cancel.onclick = async () => {
        const ok = await ask({
          title: 'Cancel this booking?',
          message: 'A refund is queued for the customer.',
          confirmLabel: 'Cancel booking',
          cancelLabel: 'Keep it',
          danger: true,
        });
        if (ok) send('cancel');
      };
      act.append(cancel);
    }
    item.append(act);
    list.append(item);
  }
  view.append(list);
}

/* ---------- the salon's storefront photo ---------- */

/** What the upload route will accept. Stated here so the phone says no first. */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_MB = 2;

/**
 * Send the file itself as the request body.
 *
 * No multipart and no base64: the server wants bytes, and a raw PUT is the
 * shortest path from a phone's photo picker to them. The salon is not in the
 * URL — /api/business/image resolves it from the signed-in owner — so there is
 * nothing here an owner could point at somebody else's salon.
 */
async function uploadSalonImage(file, path = '/api/business/image') {
  if (!IMAGE_TYPES.includes(file.type)) {
    throw new Error('Please choose a JPEG, PNG or WebP image.');
  }
  if (file.size > MAX_IMAGE_MB * 1024 * 1024) {
    throw new Error(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_IMAGE_MB} MB.`);
  }
  return api(path, { method: 'PUT', body: file, headers: { 'content-type': file.type } });
}

/**
 * The picture customers see on the salon's card, and the way to change it.
 *
 * The preview is the real URL the server returned, not a local object URL: a
 * blob: preview looks identical and hides the case where the upload never
 * landed, which is the one failure worth seeing.
 */
function salonImagePanel(salon) {
  const panel = el('div', 'panel');
  panel.append(el('h2', null, 'Salon photo'));
  panel.append(el('p', 'sub', 'The picture customers see on your card and at the top of your page.'));

  const row = el('div', 'row');
  row.style.cssText = 'gap:16px; align-items:flex-start; flex-wrap:wrap';

  const frame = el('div');
  frame.style.cssText =
    'width:180px; height:120px; border-radius:12px; overflow:hidden; flex:0 0 auto; ' +
    'border:1px solid var(--line); background:var(--surface-2); display:grid; place-items:center';

  const img = el('img');
  img.alt = salon.name;
  img.style.cssText = 'width:100%; height:100%; object-fit:cover; display:none';
  const placeholder = el('div', 'meta', 'No photo yet');
  frame.append(img, placeholder);

  const show = (url) => {
    if (!url) return;
    img.src = url;
    img.style.display = 'block';
    placeholder.style.display = 'none';
  };
  show(salon.coverImage);

  const side = el('div', 'grow');
  const file = el('input');
  file.type = 'file';
  file.accept = IMAGE_TYPES.join(',');
  file.style.display = 'none';

  const status = el('div');
  const pick = el('button', 'btn primary', salon.coverImage ? 'Replace photo' : 'Add salon image');
  pick.onclick = () => file.click();

  file.onchange = async () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    status.innerHTML = '';
    pick.disabled = true;
    pick.textContent = 'Uploading…';
    try {
      const { coverImage } = await uploadSalonImage(chosen);
      // The URL carries a hash of the bytes, so this never shows a cached
      // copy of the photo it just replaced.
      show(coverImage);
      salon.coverImage = coverImage;
      pick.textContent = 'Replace photo';
      status.append(el('div', 'out ok', 'Saved. Customers see this photo now.'));
    } catch (err) {
      pick.textContent = salon.coverImage ? 'Replace photo' : 'Add salon image';
      status.append(el('div', 'out bad', err.message || 'Upload failed'));
    } finally {
      pick.disabled = false;
      // So choosing the same file again after a failure still fires onchange.
      file.value = '';
    }
  };

  side.append(pick, file, status);
  side.append(el('div', 'note',
    `JPEG, PNG or WebP, up to ${MAX_IMAGE_MB} MB. A wide shot of the storefront or the chairs works best — `
    + 'it is cropped to a card, so keep the important part in the middle.'));

  row.append(frame, side);
  panel.append(row);
  return panel;
}

/* ---------- screen 1: service setup ---------- */
async function servicesView() {
  const view = $('#view');
  view.innerHTML = '';
  view.append(el('h1', null, 'Services'));
  view.append(el('p', 'sub', 'Your price and your duration. Both are per-salon — the same haircut can be 30 minutes here and 45 next door.'));

  const { services } = await api('/api/business/services');

  /**
   * Two lists, because they answer different questions.
   *
   * `mine` is this salon's menu — what a customer sees, what earns money, and
   * the only thing most visits to this screen are about. It used to be mixed
   * into one table with every service Hasino has ever heard of, priced rows
   * and blank rows together, so "what do I actually offer?" meant reading the
   * whole catalogue. Worse, an unseeded catalogue made the screen blank: no
   * rows at all, and no way to add one, which is what "services are missing"
   * turned out to mean.
   *
   * `rest` is the catalogue as a shortcut for adding something Hasino already
   * knows a name for. It is optional now — the add form below can create a
   * service that is not in it — so an empty catalogue is no longer a dead end.
   */
  const mine = services.filter((s) => s.offered);
  const rest = services.filter((s) => !s.offered);

  /** One row of the owner's own menu: edit in place, or take it off. */
  function myServiceRow(s) {
    const tr = el('tr');
    const name = el('td');
    name.append(el('div', null, s.name));
    name.append(el('div', 'meta', s.category));
    tr.append(name);

    const price = el('input'); price.type = 'number'; price.min = '0';
    price.value = s.price / 100;

    const dur = el('input'); dur.type = 'number'; dur.min = '1';
    dur.value = s.durationMin ?? '';

    const buf = el('input'); buf.type = 'number'; buf.min = '0';
    buf.value = s.bufferMin ?? 10;

    const active = el('input'); active.type = 'checkbox'; active.checked = s.active;

    for (const node of [price, dur, buf]) { const td = el('td'); td.append(node); tr.append(td); }
    const tdA = el('td'); tdA.append(active); tr.append(tdA);

    const actions = el('td');
    // No re-render on success: redrawing the screen would throw away the
    // "Saved" state the owner just earned, which is the whole point of it.
    const save = saveButton({
      className: 'btn sm primary',
      watch: [price, dur, buf, active],
      snapshot: () => [price.value, dur.value, buf.value, active.checked].join('|'),
      submit: async () => {
        if (!price.value || !dur.value) throw new Error('Price and duration are required.');
        await api('/api/business/services/' + s.serviceId, {
          method: 'PUT',
          body: JSON.stringify({
            price: Math.round(Number(price.value) * 100),
            durationMin: Number(dur.value),
            bufferMin: Number(buf.value || 0),
            active: active.checked,
          }),
        });
      },
      onError: (err) => toast(view, err.message, true),
    });

    const remove = el('button', 'btn sm', 'Remove');
    remove.style.marginLeft = '8px';
    remove.onclick = async () => {
      // Removing a service is not the same as unticking Live, and the
      // difference is worth one question: Live keeps the price for later,
      // Remove does not.
      const yes = await ask({
        title: `Remove ${s.name}?`,
        message: 'It comes off your menu and customers stop seeing it. Your price and duration '
          + 'for it are not kept. Bookings already made are unaffected.',
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!yes) return;
      try {
        await api('/api/business/services/' + s.serviceId, { method: 'DELETE' });
        toast(view, `${s.name} removed.`);
        servicesView();
      } catch (err) { toast(view, err.message, true); }
    };

    actions.append(save, remove);
    tr.append(actions);
    return tr;
  }

  // ---- your menu ----
  view.append(el('h2', null, 'Your services'));
  if (mine.length === 0) {
    const empty = el('div', 'panel');
    empty.append(el('p', 'sub',
      'Nothing on your menu yet. Add your first service below — customers see it as soon as you do.'));
    view.append(empty);
  } else {
    const panel = el('div', 'panel scroll-x');
    const table = el('table');
    table.innerHTML = `<thead><tr>
      <th>Service</th><th>Price (₹)</th><th>Duration</th><th>Buffer</th><th>Live</th><th></th>
    </tr></thead>`;
    const tbody = el('tbody');
    for (const s of mine) tbody.append(myServiceRow(s));
    table.append(tbody);
    panel.append(table);
    view.append(panel);
    view.append(el('div', 'note',
      'Buffer is turnaround time after the service. A booking reserves duration + one buffer, '
      + 'sized by the longest buffer in the cart. Untick Live to hide a service without losing '
      + 'its price.'));
  }

  // ---- add ----
  view.append(el('h2', null, 'Add a service'));
  const addPanel = el('div', 'panel');
  const form = el('div', 'form-row');
  form.style.cssText = 'display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end';

  const field = (label, node) => {
    const wrap = el('div');
    wrap.style.cssText = 'display:flex; flex-direction:column; gap:6px';
    wrap.append(el('label', 'meta', label), node);
    return wrap;
  };

  const nameIn = el('input');
  nameIn.type = 'text';
  nameIn.placeholder = 'Haircut';
  nameIn.maxLength = 60;
  // The catalogue as suggestions, not as a constraint: typing a name Hasino
  // has never seen is allowed and creates it. A <datalist> keeps the shared
  // spelling likely without making the field a dropdown that cannot be
  // escaped — which is what left an unseeded deployment with no way forward.
  const list = el('datalist');
  list.id = 'catalogue-names';
  for (const s of rest) list.append(Object.assign(document.createElement('option'), { value: s.name }));
  nameIn.setAttribute('list', list.id);

  const catIn = el('input');
  catIn.type = 'text';
  catIn.placeholder = 'hair';
  catIn.maxLength = 30;

  const priceIn = el('input'); priceIn.type = 'number'; priceIn.min = '0'; priceIn.placeholder = '250';
  const durIn = el('input'); durIn.type = 'number'; durIn.min = '1'; durIn.placeholder = '30';

  const add = el('button', 'btn primary', 'Add service');
  add.onclick = async () => {
    if (!nameIn.value.trim()) { toast(view, 'A service needs a name.', true); return; }
    if (!priceIn.value || !durIn.value) { toast(view, 'Price and duration are required.', true); return; }
    add.disabled = true;
    try {
      const created = await api('/api/business/services', {
        method: 'POST',
        body: JSON.stringify({
          name: nameIn.value.trim(),
          category: catIn.value.trim() || 'other',
          price: Math.round(Number(priceIn.value) * 100),
          durationMin: Number(durIn.value),
        }),
      });
      toast(view, `${created.name} added.`);
      servicesView();
    } catch (err) {
      toast(view, err.message, true);
      add.disabled = false;
    }
  };

  form.append(
    field('Service name', nameIn),
    field('Category', catIn),
    field('Price (₹)', priceIn),
    field('Duration (min)', durIn),
    add,
  );
  addPanel.append(form, list);
  addPanel.append(el('div', 'note',
    'Hasino keeps one shared list of service names so customers searching for a haircut find '
    + 'every salon that does one. If the name you type is already on it, yours joins it; if not, '
    + 'it is added. The price and duration are always yours alone.'));
  view.append(addPanel);
}

/* ---------- screen 2: timings ---------- */
async function timingsView() {
  const view = $('#view');
  view.innerHTML = '';
  view.append(el('h1', null, 'Timings & capacity'));
  view.append(el('p', 'sub', 'Chairs you release online, slot size, opening hours, lunch break and holidays.'));

  const { hours } = await api('/api/business/hours');
  const grid = el('div', 'grid two');

  for (const h of hours) {
    const card = el('div', 'panel');
    card.style.margin = '0';

    const head = el('div', 'row');
    head.style.justifyContent = 'space-between';
    head.append(el('h3', null, DOW[h.weekday]));
    const working = el('input'); working.type = 'checkbox'; working.checked = h.working;
    const wrap = el('label', 'row');
    wrap.style.gap = '6px';
    wrap.append(working, el('span', 'meta', 'open'));
    head.append(wrap);
    card.append(head);

    const body = el('div', 'grid');
    body.style.gridTemplateColumns = 'repeat(2, minmax(0,1fr))';
    body.style.marginTop = '12px';

    const mk = (label, type, value, attrs = {}) => {
      const f = el('label', 'field');
      f.append(el('span', null, label));
      const i = el('input'); i.type = type; i.value = value ?? '';
      Object.assign(i, attrs);
      f.append(i);
      body.append(f);
      return i;
    };
    const open = mk('Opens', 'time', h.openAt);
    const close = mk('Closes', 'time', h.closeAt);
    const bs = mk('Break from', 'time', h.breakStart);
    const be = mk('Break to', 'time', h.breakEnd);
    const cap = mk('Chairs online', 'number', h.onlineCapacity, { min: 0 });

    const ivF = el('label', 'field');
    ivF.append(el('span', null, 'Slot size'));
    const iv = el('select');
    for (const n of [20, 30, 45]) {
      const o = el('option', null, n + ' min'); o.value = n;
      if (n === h.slotIntervalMin) o.selected = true;
      iv.append(o);
    }
    ivF.append(iv);
    body.append(ivF);
    card.append(body);

    const save = saveButton({
      label: 'Save ' + DOW[h.weekday],
      watch: [working, open, close, bs, be, cap, iv],
      snapshot: () =>
        [working.checked, open.value, close.value, bs.value, be.value, cap.value, iv.value].join('|'),
      submit: () =>
        api('/api/business/hours/' + h.weekday, {
          method: 'PUT',
          body: JSON.stringify({
            working: working.checked,
            openAt: open.value, closeAt: close.value,
            breakStart: bs.value || null, breakEnd: be.value || null,
            onlineCapacity: Number(cap.value || 0),
            slotIntervalMin: Number(iv.value),
          }),
        }),
      onError: (err) => toast(view, err.message, true),
    });
    save.style.marginTop = '12px';
    card.append(save);
    grid.append(card);
  }
  view.append(grid);

  /* holidays */
  const hp = el('div', 'panel');
  hp.append(el('h2', null, 'Holidays'));
  const { holidays } = await api('/api/business/holidays');
  const hl = el('div', 'list');
  if (!holidays.length) hl.append(el('div', 'meta', 'None coming up.'));
  for (const h of holidays) {
    const item = el('div', 'item');
    item.append(el('strong', null, h.date));
    item.append(el('div', 'grow', h.reason || ''));
    const rm = el('button', 'btn sm danger', 'Remove');
    rm.onclick = async () => { await api('/api/business/holidays/' + h.date, { method: 'DELETE' }); timingsView(); };
    item.append(rm);
    hl.append(item);
  }
  hp.append(hl);

  const add = el('div', 'row');
  add.style.marginTop = '12px';
  const d = el('input'); d.type = 'date'; d.style.maxWidth = '180px';
  const r = el('input'); r.placeholder = 'Reason (optional)'; r.style.maxWidth = '260px';
  const btn = el('button', 'btn primary', 'Add holiday');
  btn.onclick = async () => {
    if (!d.value) return;
    await api('/api/business/holidays', { method: 'POST', body: JSON.stringify({ date: d.value, reason: r.value || null }) });
    timingsView();
  };
  add.append(d, r, btn);
  hp.append(add);
  view.append(hp);
}

/* ---------- screen 7: insights ---------- */
async function insightsView() {
  const view = $('#view');
  view.innerHTML = '';
  view.append(el('h1', null, 'Insights'));
  view.append(el('p', 'sub', 'Last 60 days.'));

  const s = await api('/api/business/stats');
  const grid = el('div', 'grid cards');
  const stat = (k, v) => { const n = el('div', 'stat'); n.append(el('div', 'k', k), el('div', 'v', v)); return n; };
  grid.append(stat('Bookings', s.total));
  grid.append(stat('Completed', s.completed));
  grid.append(stat('Revenue', rupees(s.revenue)));
  grid.append(stat('Rating', s.rating ? '★ ' + s.rating : '—'));
  // No no-show rate here, deliberately. No-show policy is Hasino's, not the
  // salon's: what a customer gets back is fixed by §4 and enforced server-side
  // (booking/status.ts), and a salon may not mark one until 15 minutes past
  // the booked time. A "No-show rate" tile in the salon's own panel reads as a
  // dial they can turn, which it never was. The figure still exists — it is a
  // fraud counter — and it is still computed by salonStats and shown to
  // admins, who are the people it is for.
  grid.append(stat('Cancel rate', (s.cancelRate * 100).toFixed(0) + '%'));
  grid.append(stat('Strikes', s.strikes + ' / 3'));
  view.append(grid);

  if (s.flags.length) {
    const box = el('div', 'panel');
    box.style.marginTop = '16px';
    box.append(el('h2', null, 'Flagged for review'));
    for (const f of s.flags) box.append(el('div', 'pill bad', f));
    box.append(el('div', 'note', 'Spec §4 fraud thresholds. Sustained flags go to admin review.'));
    view.append(box);
  }

  const { reviews } = await api('/api/business/reviews');
  const rp = el('div', 'panel');
  rp.append(el('h2', null, 'Reviews'));
  if (!reviews.length) rp.append(el('div', 'meta', 'No reviews yet.'));
  for (const r of reviews) {
    const item = el('div', 'item');
    item.append(el('span', 'pill ok', '★ ' + r.rating));
    const g = el('div', 'grow');
    g.append(el('div', null, r.comment || '—'));
    g.append(el('div', 'meta', r.customer_name || 'Customer'));
    item.append(g);
    rp.append(item);
  }
  view.append(rp);
}

/* ---------- screen 6: money ----------
 *
 * §6.6 assumes the Partner sub-merchant model, where money never touches the
 * platform and there is nothing to show but a KYC status. Payments run on the
 * platform account instead, so what a salon actually needs here is the number
 * it is owed and the entries that add up to it. Every figure below is a SUM
 * over ledger_entries — nothing is stored pre-aggregated, so this screen and
 * the accounts cannot drift apart.
 */
const LEDGER_LABEL = {
  sale: 'Booking paid',
  commission: 'Platform commission',
  refund: 'Refunded to customer',
  commission_reversal: 'Commission returned',
  payout: 'Paid out to you',
  adjustment: 'Adjustment',
};

async function payoutsView() {
  const view = $('#view');
  view.innerHTML = '';
  view.append(el('h1', null, 'Money'));
  view.append(el('p', 'sub', 'What you have earned, what we kept, and what is on its way to you.'));

  const p = await api('/api/business/payouts');
  const b = p.balance;

  const grid = el('div', 'grid cards');
  const stat = (k, v, cls) => { const n = el('div', 'stat' + (cls ? ' ' + cls : '')); n.append(el('div', 'k', k), el('div', 'v', v)); return n; };
  grid.append(stat('Available now', rupees(b.available)));
  grid.append(stat('Gross taken', rupees(b.gross)));
  grid.append(stat(`Commission (${(p.commissionBps / 100).toFixed(1)}%)`, '−' + rupees(b.commission)));
  grid.append(stat('Refunded', '−' + rupees(b.refunded)));
  grid.append(stat('Already paid out', rupees(b.paidOut)));
  view.append(grid);

  const settle = el('div', 'panel');
  settle.append(el('h2', null, 'Settlement'));
  settle.append(el('div', 'meta', 'Schedule: ' + p.settlement));
  if (!p.payouts.length) {
    settle.append(el('div', 'note',
      'No payout has been sent yet. Your first settlement covers everything in "Available now" ' +
      'at the end of the current week.'));
  } else {
    const list = el('div', 'list');
    for (const pay of p.payouts) {
      const item = el('div', 'item');
      item.append(el('div', 'when', pay.periodStart + ' → ' + pay.periodEnd));
      const g = el('div', 'grow');
      g.append(el('div', null, pay.reference || 'Weekly settlement'));
      if (pay.paidAt) g.append(el('div', 'meta', 'Sent ' + new Date(pay.paidAt).toLocaleDateString('en-GB')));
      item.append(g);
      item.append(el('strong', null, rupees(pay.amount)));
      item.append(el('span', 'pill ' + (pay.status === 'paid' ? 'ok' : pay.status === 'failed' ? 'bad' : 'warn'), pay.status));
      list.append(item);
    }
    settle.append(list);
  }
  view.append(settle);

  const led = el('div', 'panel');
  led.append(el('h2', null, 'Statement'));
  if (!p.ledger.length) {
    led.append(el('div', 'meta', 'Nothing yet. Entries appear the moment a customer pays.'));
  }
  for (const e of p.ledger) {
    const item = el('div', 'item');
    item.append(el('div', 'when', new Date(e.occurredAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })));
    const g = el('div', 'grow');
    g.append(el('div', null, LEDGER_LABEL[e.kind] || e.kind));
    g.append(el('div', 'meta', [e.customerName, e.bookingStartAt ? new Date(e.bookingStartAt).toLocaleString('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null, e.note].filter(Boolean).join(' · ')));
    item.append(g);
    const amt = el('strong', null, (e.amount < 0 ? '−' : '+') + rupees(Math.abs(e.amount)));
    amt.style.color = e.amount < 0 ? 'var(--bad)' : 'var(--ok)';
    item.append(amt);
    led.append(item);
  }
  view.append(led);

  if (p.kycStatus !== 'verified') {
    const kyc = el('div', 'panel');
    kyc.append(el('h2', null, 'Verification'));
    kyc.append(el('span', 'pill warn', 'KYC ' + p.kycStatus));
    kyc.append(el('div', 'note',
      'Settlements need a verified business entity and bank account on file. ' +
      'Bookings and earnings continue to accrue in the meantime — nothing is lost, ' +
      'it just cannot be transferred until this is done.'));
    view.append(kyc);
  }
}

window.addEventListener('hashchange', render);

// Clerk restores a session asynchronously, so wait for the first auth state
// before deciding whether this is a signed-out visitor or a slow page load.
/**
 * A pending salon's owner is a real owner — they reach the panel and can set
 * up their menu and hours while they wait. What they must not see is a Today
 * screen with nothing on it and no explanation, which is indistinguishable
 * from the product being broken.
 */
async function renderPendingBanner() {
  try {
    const { salon } = await api('/api/business/overview');
    const existing = document.getElementById('pendingBanner');
    if (existing) existing.remove();
    if (salon.status === 'active') return;

    const banner = el('div', 'banner');
    banner.id = 'pendingBanner';
    banner.textContent =
      salon.status === 'pending'
        ? 'Your salon is under review. Set up your services and timings now — customers will see it the moment it is approved.'
        : salon.status === 'suspended'
          ? 'This salon is suspended and is not taking bookings. Contact Hasino support.'
          : 'This salon has been removed from Hasino and cannot take bookings.';
    document.querySelector('.topbar').after(banner);
  } catch { /* the panel itself will surface the error */ }
}

window.addEventListener('hashchange', renderPendingBanner);

/**
 * Identity changes only — see the same guard in admin.js. watchAuthState also
 * fires on Clerk's routine token refresh, and render() rebuilds the current
 * view, so without this an owner editing their menu or timings loses whatever
 * they had typed about once a minute.
 */
let lastUserId;

watchAuthState(async (user) => {
  const userId = user?.id ?? null;
  if (userId === lastUserId) return;
  lastUserId = userId;

  const me = await initIdentity();
  if (!me) return renderNotAnOwner({ status: 401 });
  if (me.role !== 'business') return renderNotAnOwner({ status: 403 });
  await renderPendingBanner();
  render();
}).catch(() => renderNotAnOwner({ status: 401 }));
