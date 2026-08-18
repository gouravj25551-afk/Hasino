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
import { EmptyState } from './components/EmptyState.js';
import { toast as pushToast } from './components/Toast.js';

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
  '#/insights': insightsView, '#/payouts': payoutsView, '#/profile': profileView,
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

/**
 * Delegates to the shared toast region.
 *
 * This used to append a box into whatever node it was handed, which meant a
 * confirmation could scroll off with the page it was attached to, or be wiped
 * by the very re-render that followed the action — several callers here do
 * `toast(view, ...)` and then immediately redraw `view`. The signature keeps
 * its `node` argument so no call site changes; the argument is simply no
 * longer where the message lives.
 */
function toast(_node, msg, bad) {
  return pushToast(msg, { tone: bad ? 'bad' : 'ok' });
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

/**
 * "Good morning" by the salon's clock, not the browser's.
 *
 * An owner in Bengaluru opening the panel on a laptop still set to London
 * time would otherwise be greeted "good evening" at breakfast. tz is already
 * the salon's zone — the panel uses it for every booking time on the screen —
 * so the greeting uses the same one.
 */
function greeting(zone) {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** The salon's own calendar date, for telling "today" from a date being browsed. */
function localDay(zone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
}
function isToday(dateKey, zone) {
  return dateKey === localDay(zone);
}

function dashSubtitle(overview, dateKey) {
  const n = overview.todayCount ?? 0;
  if (!isToday(dateKey, tz)) return `Viewing ${dateKey} · ${overview.salon.status}`;
  if (n === 0) return 'Nothing booked yet today.';
  return `${n} booking${n === 1 ? '' : 's'} on the book today.`;
}

/**
 * The numbers that were already in /api/business/overview and never shown.
 *
 * salonStats() reports over a rolling 60 days, so the labels say so rather
 * than letting an owner read a two-month revenue figure as today's takings —
 * a KPI card that does not state its window is worse than no card.
 */
function kpiRow(overview) {
  const st = overview.stats || {};
  const grid = el('div', 'grid kpi');
  grid.style.marginBottom = 'var(--space-8)';

  const card = (k, v, hint) => {
    const box = el('div', 'stat');
    box.append(el('div', 'k', k));
    box.append(el('div', 'v', v));
    if (hint) box.append(el('div', 'meta', hint));
    return box;
  };

  grid.append(card('Today', String(overview.todayCount ?? 0), 'bookings'));
  grid.append(card('Revenue', rupees(st.revenue ?? 0), 'last 60 days'));
  grid.append(card('Completed', String(st.completed ?? 0), 'last 60 days'));
  grid.append(
    card(
      'Rating',
      st.rating == null ? '—' : `★ ${Number(st.rating).toFixed(1)}`,
      st.reviews ? `${st.reviews} review${st.reviews === 1 ? '' : 's'}` : 'no reviews yet',
    ),
  );

  // Only when there is something to say. A permanent "0 flags" tile is a tile
  // that never earns its space.
  if (st.flags && st.flags.length) {
    const warn = card('Needs attention', String(st.flags.length), st.flags.join(' · '));
    warn.style.borderColor = 'var(--warn)';
    grid.append(warn);
  }
  return grid;
}

async function todayView() {
  const view = $('#view');
  view.innerHTML = '';

  const overview = await api('/api/business/overview');
  tz = overview.salon.timezone;
  if (!currentDate) currentDate = overview.today;

  // ---- the greeting ----
  // A dashboard opens with who you are and how the day looks, not with a
  // heading and a status string. The hour comes from the salon's own timezone,
  // which the panel already knows — greeting an owner in Bengaluru "good
  // evening" off a laptop still on London time is the kind of small wrongness
  // that makes software feel generic.
  const head = el('div', 'dash-head');
  head.append(el('h1', null, `${greeting(tz)}, ${overview.salon.name}`));
  head.append(el('div', 'dash-sub', dashSubtitle(overview, currentDate)));
  view.append(head);

  // ---- today's numbers ----
  // Everything here already came back with /api/business/overview; nothing new
  // is fetched and no endpoint changed. It was simply never shown.
  view.append(kpiRow(overview));

  const ctrl = el('div', 'row');
  ctrl.style.marginBottom = 'var(--space-6)';
  // The date field carries a label above it, so centre-aligning the row would
  // float the button half a line high against the input.
  ctrl.style.alignItems = 'flex-end';
  const date = el('label', 'field');
  date.style.margin = '0';
  date.append(el('span', null, 'Showing'));
  const dateInput = el('input');
  dateInput.type = 'date';
  dateInput.value = currentDate;
  dateInput.style.maxWidth = '190px';
  dateInput.onchange = () => { currentDate = dateInput.value; todayView(); };
  date.append(dateInput);
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
  const listHead = el('div', 'section-head');
  listHead.append(el('h2', null, isToday(currentDate, tz) ? "Today's appointments" : 'Appointments'));
  listHead.append(el('span', 'meta', `${bookings.length} booked`));
  view.append(listHead);

  if (!bookings.length) {
    view.append(
      EmptyState({
        icon: '◷',
        title: 'Nothing booked for this day',
        body: 'Bookings appear here the moment a customer confirms one. Check your timings and services are set up so customers can find you.',
        action: 'Check timings',
        onAction: () => { location.hash = '#/timings'; },
      }),
    );
    return;
  }

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

/* ---------- profile: the salon as customers see it ---------- */

/**
 * One screen for what a salon *is*, as opposed to what it is doing today.
 *
 * Everything here writes the same salons row the customer app reads, so the
 * name, photo, description and address a customer sees are these. Nothing is
 * duplicated: the photo panel is the one the Today screen uses, timings and
 * services are links to the screens that own them, and the save buttons are
 * the same helper — "Saved" only after the server says so.
 *
 * Two things are deliberately not editable. The account the owner signs in
 * with, because that is Clerk's and changing it here would let a salon point
 * itself at a different identity; and anything about no-show refunds, which is
 * Hasino's policy and never the salon's to set.
 */
async function profileView() {
  const view = $('#view');
  view.innerHTML = '';

  const salon = await api('/api/business/profile');
  tz = salon.timezone;

  view.append(el('h1', null, 'Profile'));
  view.append(el('p', 'sub', 'What customers see when they find your salon.'));

  if (salon.status !== 'active') {
    view.append(el('div', 'note',
      salon.status === 'pending'
        ? 'Your salon is still under review. You can fill this in now — it is what the reviewer reads.'
        : `This salon is ${salon.status}.`));
  }

  // ---- the photo, from the panel the Today screen already uses ----
  view.append(salonImagePanel(salon));

  // ---- name, description ----
  const about = el('div', 'panel');
  about.append(el('h2', null, 'Salon details'));

  const field = (label, node, hint) => {
    const wrap = el('label', 'field');
    wrap.append(el('span', null, label));
    wrap.append(node);
    if (hint) wrap.append(el('div', 'meta', hint));
    return wrap;
  };
  const input = (value, placeholder = '', attrs = {}) => {
    const i = el('input');
    i.type = 'text';
    i.value = value ?? '';
    i.placeholder = placeholder;
    Object.assign(i, attrs);
    return i;
  };

  const name = input(salon.name, 'Sharma Hair Studio', { maxLength: 120 });
  const description = el('textarea');
  description.value = salon.description ?? '';
  description.rows = 4;
  description.maxLength = 2000;
  description.placeholder = 'Two chairs, open since 2019. Fades, beard work and colour.';
  description.style.cssText = 'width:100%; font:inherit; padding:10px 12px; border-radius:10px; '
    + 'border:1px solid var(--line); background:var(--surface); color:var(--text)';

  const address = input(salon.address, '12 MG Road, Indiranagar');
  const city = input(salon.city, 'Bengaluru');
  const area = input(salon.area, 'Indiranagar');
  const phone = input(salon.phone, '+918012345678');
  const salonEmail = input(salon.email, 'salon@example.com', { type: 'email' });

  const grid = el('div', 'grid two');
  grid.append(field('Salon name', name));
  grid.append(field('Phone customers can call', phone));
  about.append(grid);
  about.append(field('About your salon', description,
    'Shown on your page. What you are known for, in a sentence or two.'));

  const locationGrid = el('div', 'grid two');
  locationGrid.append(field('Address', address, 'Changing this re-places your pin on the map.'));
  locationGrid.append(field('City', city, 'What customers filter by — keep it the real city name.'));
  locationGrid.append(field('Area', area, 'Optional. The neighbourhood, for search.'));
  locationGrid.append(field('Salon email', salonEmail, 'For customers. Not your sign-in.'));
  about.append(locationGrid);

  const detailStatus = el('div');
  const saveDetails = saveButton({
    watch: [name, description, address, city, area, phone, salonEmail],
    snapshot: () =>
      [name.value, description.value, address.value, city.value, area.value, phone.value, salonEmail.value].join('|'),
    submit: async () => {
      detailStatus.innerHTML = '';
      const result = await api('/api/business/profile', {
        method: 'PUT',
        body: JSON.stringify({
          name: name.value.trim(),
          description: description.value.trim() || null,
          address: address.value.trim(),
          city: city.value.trim(),
          area: area.value.trim() || null,
          phone: phone.value.trim() || null,
          email: salonEmail.value.trim() || null,
        }),
      });
      if (result.geocoded) {
        detailStatus.append(el('div', 'out ok', 'Saved. Your map pin was moved to the new address.'));
      }
    },
    onError: (err) => toast(view, err.message, true),
  });
  saveDetails.style.marginTop = '12px';
  about.append(saveDetails, detailStatus);
  view.append(about);

  // ---- who this account is ----
  const identity = el('div', 'panel');
  identity.append(el('h2', null, 'Account'));
  const who = el('div', 'list');
  const row = (label, value) => {
    const item = el('div', 'item');
    item.append(el('div', 'grow', label));
    item.append(el('span', 'meta', value || '—'));
    return item;
  };
  who.append(row('Signed in as', salon.account.email));
  if (salon.account.name) who.append(row('Name on the account', salon.account.name));
  who.append(row('Timezone', salon.timezone));
  identity.append(who);
  identity.append(el('div', 'note',
    'Your salon is tied to the Google account you sign in with, and that link is what makes this '
    + 'panel yours. It cannot be changed here — contact Hasino support if the salon needs to move '
    + 'to a different account.'));
  view.append(identity);

  // ---- chairs ----
  const chairsPanel = el('div', 'panel');
  chairsPanel.append(el('h2', null, 'Chairs'));
  chairsPanel.append(el('p', 'sub',
    'How many customers you can serve at the same time. A 10:00 slot takes this many bookings before it is full.'));

  if (salon.chairsVary) {
    chairsPanel.append(el('div', 'note',
      'Your chair count is different on different days, which is deliberate enough that this screen '
      + 'will not flatten it. Edit each day under Timings.'));
    const toTimings = el('a', 'btn sm', 'Open Timings →');
    toTimings.href = '#/timings';
    chairsPanel.append(toTimings);
  } else {
    const chairs = el('input');
    chairs.type = 'number';
    chairs.min = '0';
    chairs.max = '50';
    chairs.value = salon.chairs ?? 1;
    chairs.style.maxWidth = '120px';
    const chairStatus = el('div');

    const saveChairs = saveButton({
      watch: [chairs],
      snapshot: () => String(chairs.value),
      submit: async () => {
        chairStatus.innerHTML = '';
        const result = await api('/api/business/chairs', {
          method: 'PUT',
          body: JSON.stringify({ chairs: Number(chairs.value) }),
        });
        chairStatus.append(el('div', 'out ok', `Applied to ${result.weekdaysUpdated} working day(s).`));
      },
      onError: (err) => {
        // The one refusal worth explaining in place rather than as a toast:
        // it is about bookings the owner already has.
        chairStatus.innerHTML = '';
        chairStatus.append(el('div', 'out bad', err.message));
      },
    });
    saveChairs.style.marginTop = '12px';

    chairsPanel.append(field('Chairs available to online booking', chairs,
      `Applied to all ${salon.workingDays} day(s) you are open.`));
    chairsPanel.append(saveChairs, chairStatus);
    chairsPanel.append(el('div', 'note',
      'Lowering this is refused when you already have more bookings than that sharing a slot — '
      + 'those customers have a chair, and taking it away here would only surprise you on the day.'));
  }
  view.append(chairsPanel);

  // ---- the screens that own the rest ----
  const links = el('div', 'panel');
  links.append(el('h2', null, 'Manage'));
  const list = el('div', 'list');
  const linkRow = (label, hint, href) => {
    const item = el('a', 'item');
    item.href = href;
    item.style.cssText = 'text-decoration:none; color:inherit';
    const grow = el('div', 'grow');
    grow.append(el('div', null, label));
    grow.append(el('div', 'meta', hint));
    item.append(grow, el('span', 'meta', '→'));
    return item;
  };
  list.append(linkRow('Services', 'Your menu, prices and durations', '#/services'));
  list.append(linkRow('Timings & capacity', 'Opening hours, breaks, slot size and holidays', '#/timings'));
  links.append(list);
  view.append(links);
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
    const name = el('td', 'name-cell');
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

    // The label rides on the cell so the same markup can be a table on a
    // desktop and a labelled card on a phone — see .table-cards in brand.css.
    // A second, mobile-only rendering would be two versions of this row to
    // keep in step, and the one that gets forgotten is always the small one.
    for (const [node, label] of [[price, 'Price (₹)'], [dur, 'Duration'], [buf, 'Buffer']]) {
      const td = el('td');
      td.dataset.label = label;
      td.append(node);
      tr.append(td);
    }
    const tdA = el('td');
    tdA.dataset.label = 'Live';
    tdA.append(active);
    tr.append(tdA);

    const actions = el('td', 'actions-cell');
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

    const remove = el('button', 'btn sm danger', 'Remove');
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

    // Side by side, and staying that way: a Save stacked on top of a Remove
    // reads as a list of two unrelated things, and puts a destructive button
    // directly under the one the owner taps most.
    const pair = el('div', 'row-actions');
    pair.append(save, remove);
    actions.append(pair);
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
    const panel = el('div', 'panel scroll-x table-cards');
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
    const slot = document.getElementById('bannerSlot');
    if (slot) slot.replaceChildren();
    if (salon.status === 'active') return;

    const banner = el('div', 'banner');
    banner.id = 'pendingBanner';
    banner.textContent =
      salon.status === 'pending'
        ? 'Your salon is under review. Set up your services and timings now — customers will see it the moment it is approved.'
        : salon.status === 'suspended'
          ? 'This salon is suspended and is not taking bookings. Contact Hasino support.'
          : 'This salon has been removed from Hasino and cannot take bookings.';
    document.getElementById('bannerSlot')?.replaceChildren(banner);
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
