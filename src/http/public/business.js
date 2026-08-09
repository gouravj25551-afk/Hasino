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
  try {
    const me = await api('/api/me');
    who.innerHTML = '';
    who.append(el('span', 'meta', me.name || me.email || me.phone));
    const out = el('button', 'btn sm', 'Sign out');
    out.onclick = async () => { await signOut(); location.reload(); };
    who.append(out);
    return me;
  } catch (err) {
    who.innerHTML = '';
    const link = el('a', 'btn sm primary', 'Sign in');
    link.href = '/#/login';
    who.append(link);
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

function toast(node, msg, bad) {
  const box = el('div', 'out ' + (bad ? 'bad' : 'ok'), msg);
  node.append(box);
  setTimeout(() => box.remove(), 3200);
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
    if (!confirm(`Cancel every booking on ${currentDate} and queue refunds?\n\nThis cannot be undone.`)) return;
    const r = await api('/api/business/close-today', { method: 'POST', body: JSON.stringify({ date: currentDate }) });
    toast(view, `Cancelled ${r.cancelled} booking(s).\n${r.refunds}`);
    todayView();
  };
  ctrl.append(close);
  view.append(ctrl);

  const { bookings } = await api('/api/business/bookings?date=' + currentDate);
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
    grow.append(el('div', 'meta', `${b.customerPhone} · ${b.services.join(', ') || '—'}`));
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
      verify.onclick = () => {
        const code = prompt("Enter the customer's 6-digit code:");
        if (code) send('verify', { code: code.trim() });
      };
      act.append(verify);
      const ns = el('button', 'btn sm danger', 'No-show');
      ns.onclick = () => confirm('Mark as no-show? The customer is not refunded.') && send('no-show');
      act.append(ns);
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
      cancel.onclick = () => confirm('Cancel this booking and queue a refund?') && send('cancel');
      act.append(cancel);
    }
    item.append(act);
    list.append(item);
  }
  view.append(list);
}

/* ---------- screen 1: service setup ---------- */
async function servicesView() {
  const view = $('#view');
  view.innerHTML = '';
  view.append(el('h1', null, 'Services'));
  view.append(el('p', 'sub', 'Your price and your duration. Both are per-salon — the same haircut can be 30 minutes here and 45 next door.'));

  const { services } = await api('/api/business/services');
  const panel = el('div', 'panel scroll-x');
  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th>Service</th><th>Price (₹)</th><th>Duration</th><th>Buffer</th><th>Live</th><th></th>
  </tr></thead>`;
  const tbody = el('tbody');

  for (const s of services) {
    const tr = el('tr');
    const name = el('td');
    name.append(el('div', null, s.name));
    name.append(el('div', 'meta', s.category));
    tr.append(name);

    const price = el('input'); price.type = 'number'; price.min = '0';
    price.value = s.offered ? s.price / 100 : '';
    price.placeholder = '—';

    const dur = el('input'); dur.type = 'number'; dur.min = '1';
    dur.value = s.durationMin ?? ''; dur.placeholder = '—';

    const buf = el('input'); buf.type = 'number'; buf.min = '0';
    buf.value = s.bufferMin ?? 10;

    const active = el('input'); active.type = 'checkbox'; active.checked = s.active;

    for (const [node, cls] of [[price], [dur], [buf]]) { const td = el('td'); td.append(node); tr.append(td); }
    const tdA = el('td'); tdA.append(active); tr.append(tdA);

    const save = el('button', 'btn sm primary', s.offered ? 'Save' : 'Add');
    save.onclick = async () => {
      if (!price.value || !dur.value) { toast(view, 'Price and duration are required.', true); return; }
      try {
        await api('/api/business/services/' + s.serviceId, {
          method: 'PUT',
          body: JSON.stringify({
            price: Math.round(Number(price.value) * 100),
            durationMin: Number(dur.value),
            bufferMin: Number(buf.value || 0),
            active: active.checked,
          }),
        });
        toast(view, `${s.name} saved.`);
        servicesView();
      } catch (err) { toast(view, err.message, true); }
    };
    const tdS = el('td'); tdS.append(save); tr.append(tdS);
    tbody.append(tr);
  }
  table.append(tbody);
  panel.append(table);
  view.append(panel);

  view.append(el('div', 'note',
    'Buffer is turnaround time after the service. A booking reserves duration + one buffer, ' +
    'sized by the longest buffer in the cart.'));
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

    const save = el('button', 'btn primary');
    save.textContent = 'Save ' + DOW[h.weekday];
    save.style.marginTop = '12px';
    save.onclick = async () => {
      try {
        await api('/api/business/hours/' + h.weekday, {
          method: 'PUT',
          body: JSON.stringify({
            working: working.checked,
            openAt: open.value, closeAt: close.value,
            breakStart: bs.value || null, breakEnd: be.value || null,
            onlineCapacity: Number(cap.value || 0),
            slotIntervalMin: Number(iv.value),
          }),
        });
        toast(view, DOW[h.weekday] + ' saved.');
      } catch (err) { toast(view, err.message, true); }
    };
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
  grid.append(stat('No-show rate', (s.noShowRate * 100).toFixed(0) + '%'));
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

watchAuthState(async () => {
  const me = await initIdentity();
  if (!me) return renderNotAnOwner({ status: 401 });
  if (me.role !== 'business') return renderNotAnOwner({ status: 403 });
  await renderPendingBanner();
  render();
}).catch(() => renderNotAnOwner({ status: 401 }));
