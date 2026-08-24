/**
 * admin.html's shell.
 *
 * External rather than inline because the CSP is `script-src 'self'`
 * with no 'unsafe-inline' — an inline module script is blocked outright,
 * which renders the page blank. Keeping the strict policy and moving the
 * code out is the right trade; the alternative weakens CSP for every page
 * to save one file.
 */
import {
  completeRedirectCallback,
  configureAuthRoutes,
  currentIdToken,
  isRedirectCallback,
  signInWithGoogle,
  signOut,
  watchAuthState,
} from './lib/auth.js';

/**
 * This panel's routes, not the customer app's.
 *
 * lib/auth.js defaults to '#/login' and '#/home', which exist in the customer
 * app and nowhere here — Clerk would send the browser to a route this router
 * does not have, and it would fall back to '#/overview' looking like a
 * sign-in that did nothing. '/' is this app's sign-in screen: it renders the
 * Google button when there is no admin session.
 *
 * Before any other import can touch Clerk.
 */
import { ask, notify } from './lib/dialog.js';
import { EmptyState } from './components/EmptyState.js';
import { SkeletonList, SkeletonCard } from './components/Skeleton.js';
import { CARD_ASPECT, canCropImages, cropImage } from './lib/imagecrop.js';

configureAuthRoutes({ signIn: '/', home: '/#/overview' });

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const el = (t, cls, txt) => { const n = document.createElement(t); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const rupees = p => '₹' + (p / 100).toLocaleString('en-IN');
const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const when = iso => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const day  = iso => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

async function api(path, opts = {}) {
  let token = null;
  try { token = await currentIdToken(); } catch { /* Clerk unconfigured — the request 401s honestly */ }
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

/** Matches what the upload route accepts — see src/salons/images.ts. */
const ADMIN_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ADMIN_MAX_IMAGE_MB = 2;

/**
 * Put a storefront photo on a salon, as the file's own bytes.
 *
 * The salon id is in the path and the request carries an admin session; the
 * server checks the role before this route is reached, so nothing here is
 * trusted for authorisation.
 */
async function uploadAdminSalonImage(salonId, file) {
  if (!ADMIN_IMAGE_TYPES.includes(file.type)) {
    throw new Error('the file must be a JPEG, PNG or WebP image');
  }
  if (file.size > ADMIN_MAX_IMAGE_MB * 1024 * 1024) {
    throw new Error(`it is ${(file.size / 1024 / 1024).toFixed(1)} MB and the limit is ${ADMIN_MAX_IMAGE_MB} MB`);
  }
  return api(`/api/admin/salons/${salonId}/image`, {
    method: 'PUT',
    body: file,
    headers: { 'content-type': file.type },
  });
}

/**
 * The resize step, before anything is uploaded.
 *
 * Same dialog the owner's own panel uses (lib/imagecrop.js), for the same
 * reason: a photo taken on the admin's phone while standing in the salon is
 * several megabytes and portrait, the route caps uploads at 2 MB, and the
 * card it lands in is 16:10. Returns the file to send, or null if the admin
 * backed out of the dialog.
 */
async function frameSalonPhoto(file, title = 'Resize the storefront photo') {
  if (!canCropImages()) return file;
  if (!ADMIN_IMAGE_TYPES.includes(file.type)) {
    throw new Error('the file must be a JPEG, PNG or WebP image');
  }
  return cropImage(file, { aspect: CARD_ASPECT, title });
}

const STATUS_TONE = { pending: 'warn', active: 'ok', suspended: 'bad', banned: 'bad', rejected: 'bad' };
const statusPill = s => el('span', 'pill ' + (STATUS_TONE[s] ?? ''), s);

/**
 * The panel signs in here rather than borrowing the public app's session.
 *
 * A Clerk session belongs to one origin, so being signed in at :3000 grants
 * nothing at :4000 — which is the separation this architecture is for. The
 * round trip comes back to /sso-callback on this same origin.
 */
function googleButton(cls, label) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.onclick = async () => {
    b.disabled = true;
    b.textContent = 'Redirecting to Google…';
    try {
      await signInWithGoogle();
    } catch (err) {
      b.disabled = false;
      b.textContent = label;
      await notify({ title: 'Could not start sign-in', message: err.message, tone: 'bad' });
    }
  };
  return b;
}

function errorBox(err) {
  return el('div', 'out bad', `${err.status ?? ''} ${err.body?.code ?? ''}\n${err.message}`);
}

/* ---------------- overview ---------------- */

async function overviewView() {
  const view = $('#view');
  view.innerHTML = '';

  const o = await api('/api/admin/overview');

  // The console's whole job is the review queue, so the header states it
  // rather than saying "Overview" and leaving the operator to find the number.
  const head = el('div', 'dash-head');
  head.append(el('h1', null, 'Overview'));
  head.append(
    el(
      'div',
      'dash-sub',
      o.pending
        ? `${o.pending} application${o.pending === 1 ? '' : 's'} waiting on you.`
        : 'Nothing waiting for review.',
    ),
  );
  view.append(head);

  // The one card that is a job rather than a number gets to look like one, and
  // to be clickable — it was previously a tile you read and then navigated to
  // by hand.
  const grid = el('div', 'grid kpi');
  grid.style.marginBottom = 'var(--space-8)';
  const stat = (k, v, hint) => {
    const box = el('div', 'stat');
    box.append(el('div', 'k', k), el('div', 'v', String(v)));
    if (hint) box.append(el('div', 'meta', hint));
    return box;
  };

  const pending = stat('Salon requests', o.pending, o.pending ? 'tap to review' : 'queue clear');
  if (o.pending) {
    pending.classList.add('stat-action');
    pending.tabIndex = 0;
    pending.setAttribute('role', 'link');
    const go = () => { location.hash = '#/requests'; };
    pending.onclick = go;
    pending.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  }

  grid.append(
    pending,
    stat('Active salons', o.active, 'taking bookings'),
    stat('Suspended', o.suspended, o.suspended ? 'not bookable' : 'none'),
    stat('Bookings today', o.bookingsToday, 'across the platform'),
    stat('GMV', rupees(o.gmvThisMonth), 'this month'),
  );
  view.append(grid);

  // The two "chase someone" numbers. A salon that is live with no menu is
  // invisible to customers and looks like a platform bug from the outside.
  const chase = el('div', 'panel');
  chase.append(el('h2', null, 'Needs chasing'));
  chase.append(el('p', 'sub', 'Live salons that customers cannot actually book, and owners who have never arrived.'));
  const list = el('div', 'list');
  const row = (label, n, hint) => {
    const item = el('div', 'item');
    item.append(el('div', 'grow', label));
    item.append(el('strong', null, String(n)));
    if (hint) item.append(el('span', 'meta', hint));
    return item;
  };
  list.append(row('Salons with no services set up', o.salonsWithoutServices, 'invisible to customers'));
  list.append(row('Owners who have never signed in', o.ownersNeverSignedIn, 'cannot manage their salon yet'));
  chase.append(list);
  view.append(chase);
}

/* ---------------- salon requests ---------------- */

/**
 * The queue of people asking to list a salon.
 *
 * The same rows the Salons screen can show under its "Pending" filter, given
 * their own screen and their own nav entry — because this is the one list on
 * the panel that is *work*, and it was reachable only by remembering to filter
 * an archive of every salon on the platform.
 *
 * Nothing here is a second source of truth: it calls GET /api/admin/salons
 * with status=pending, and every row opens the same salon detail with the same
 * Approve and Reject actions. What it adds is what a reviewer needs to triage
 * without opening anything — who is asking, from where, how to reach them,
 * what they intend to sell, and how long they have been waiting.
 */
async function requestsView() {
  const view = $('#view');
  view.innerHTML = '';
  sessionStorage.setItem('adminLastList', '#/requests');

  const head = el('div', 'dash-head');
  head.append(el('h1', null, 'Salon requests'));
  head.append(el('div', 'dash-sub',
    'People asking to list a salon. Approving one makes the salon live and turns its applicant '
    + 'into a salon owner — until then their account is an ordinary customer account.'));
  view.append(head);

  const listWrap = el('div');
  view.append(listWrap);
  listWrap.append(SkeletonList(3, () => {
    const row = document.createElement('div');
    row.className = 'skeleton skeleton-row';
    return row;
  }));

  let salons;
  try {
    ({ salons } = await api('/api/admin/salons?status=pending'));
  } catch (err) {
    listWrap.innerHTML = '';
    listWrap.append(errorBox(err));
    return;
  }

  listWrap.innerHTML = '';
  if (!salons.length) {
    listWrap.append(EmptyState({
      icon: '✓',
      title: 'No requests waiting',
      body: 'Every salon listing request has been reviewed. New ones appear here the moment '
        + 'someone submits one from "List your salon".',
      action: 'See all salons',
      onAction: () => { location.hash = '#/salons'; },
    }));
    return;
  }

  const list = el('div', 'list');
  for (const s of salons) {
    const item = el('div', 'item request-row');
    item.style.cursor = 'pointer';
    const open = () => { location.hash = `#/salon/${s.id}`; };
    item.onclick = open;
    item.tabIndex = 0;
    item.setAttribute('role', 'link');
    item.setAttribute('aria-label', `Review ${s.name}`);
    item.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      open();
    };

    const main = el('div', 'grow');
    main.append(el('div', null, s.name));
    main.append(el('div', 'meta', [s.address, s.area, s.city].filter(Boolean).join(', ')));
    item.append(main);

    // Who is asking, and how to reach them. The owner's email is the account
    // they signed in with; the phone is what they gave on the form.
    const owner = el('div');
    owner.style.minWidth = '210px';
    owner.append(el('div', null, s.ownerName || '(no name given)'));
    owner.append(el('div', 'meta', [s.ownerEmail, s.ownerPhone].filter(Boolean).join(' · ') || 'no contact on file'));
    item.append(owner);

    item.append(el('span', 'pill', `${s.serviceCount} services`));
    if (s.serviceCount === 0) item.append(el('span', 'pill warn', 'no menu'));
    item.append(el('span', 'meta', `submitted ${day(s.submittedAt)}`));
    item.append(statusPill(s.status));

    // The queue's own call to action. It opens the detail rather than
    // approving from here: approving a salon means reading the application,
    // and a one-tap Approve on a list nobody has opened is how a queue gets
    // cleared without being reviewed.
    const review = el('button', 'btn sm primary', 'Review →');
    review.type = 'button';
    review.onclick = (e) => { e.stopPropagation(); open(); };
    item.append(review);

    list.append(item);
  }
  listWrap.append(list);
}

/* ---------------- salons list ---------------- */

let salonFilters = { status: '', city: '', q: '' };

async function salonsView() {
  const view = $('#view');
  view.innerHTML = '';
  sessionStorage.setItem('adminLastList', '#/salons');

  const head = el('div', 'dash-head');
  head.append(el('h1', null, 'Salons'));
  head.append(el('div', 'dash-sub', 'Every salon on the platform, and the queue waiting to join it.'));
  view.append(head);

  const controls = el('div', 'panel');
  const row = el('div', 'row');

  // A segmented filter rather than six buttons where the selected one is a
  // primary button: a filled primary reads as "the action to take", so the
  // status you were already looking at looked like the thing to click next.
  const tabs = el('div', 'segmented');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Filter by status');
  for (const [label, value] of [['Pending','pending'],['Active','active'],['Suspended','suspended'],['Rejected','rejected'],['Banned','banned'],['All','']]) {
    const b = el('button', 'segmented-btn', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(salonFilters.status === value));
    b.onclick = () => { salonFilters.status = value; salonsView(); };
    tabs.append(b);
  }
  row.append(tabs);

  const citySel = el('select');
  citySel.style.maxWidth = '200px';
  citySel.append(el('option', null, 'All cities'));
  const { cities } = await api('/api/admin/cities');
  for (const c of cities) {
    const opt = el('option', null, `${c.city} (${c.count})`);
    opt.value = c.city;
    if (c.city === salonFilters.city) opt.selected = true;
    citySel.append(opt);
  }
  citySel.onchange = () => { salonFilters.city = citySel.value === 'All cities' ? '' : citySel.value; salonsView(); };
  row.append(citySel);

  const search = el('input');
  search.placeholder = 'Name, address, owner phone or email…';
  search.value = salonFilters.q;
  search.style.maxWidth = '280px';
  let t;
  search.oninput = () => { clearTimeout(t); t = setTimeout(() => { salonFilters.q = search.value.trim(); drawList(); }, 250); };
  row.append(search);

  controls.append(row);
  view.append(controls);

  const listWrap = el('div');
  view.append(listWrap);

  async function drawList() {
    listWrap.innerHTML = '';
    // Skeleton rows in the shape of the list that is coming, rather than the
    // word "Loading…" — the rows do not jump into place from nothing.
    listWrap.append(SkeletonList(4, () => {
      const row = document.createElement('div');
      row.className = 'skeleton skeleton-row';
      return row;
    }));
    const params = new URLSearchParams();
    if (salonFilters.status) params.set('status', salonFilters.status);
    if (salonFilters.city) params.set('city', salonFilters.city);
    if (salonFilters.q) params.set('q', salonFilters.q);
    try {
      const { salons } = await api('/api/admin/salons?' + params);
      listWrap.innerHTML = '';
      if (!salons.length) {
        const filtered = salonFilters.status || salonFilters.city || salonFilters.q;
        listWrap.append(
          EmptyState({
            icon: '◈',
            title: filtered ? 'Nothing matches those filters' : 'No salons yet',
            body: filtered
              ? 'Try a different status, city or search term — or clear the filters to see everything.'
              : 'Salons appear here once someone applies, or once you onboard one directly.',
            action: filtered ? 'Clear filters' : 'Onboard a salon',
            onAction: () => {
              if (!filtered) return void (location.hash = '#/onboard');
              salonFilters = { status: '', city: '', q: '' };
              salonsView();
            },
          }),
        );
        return;
      }
      const list = el('div', 'list');
      for (const s of salons) {
        const item = el('div', 'item');
        item.style.cursor = 'pointer';
        item.onclick = () => { location.hash = `#/salon/${s.id}`; };

        const main = el('div', 'grow');
        main.append(el('div', null, s.name));
        main.append(el('div', 'meta', [s.area, s.city].filter(Boolean).join(', ') || s.address));
        item.append(main);

        const owner = el('div');
        owner.style.minWidth = '190px';
        owner.append(el('div', null, s.ownerName || s.ownerEmail || s.ownerPhone || '—'));
        owner.append(el('div', 'meta', s.ownerHasSignedIn ? 'signed in' : 'never signed in'));
        item.append(owner);

        item.append(el('span', 'pill', `${s.serviceCount} services`));
        item.append(el('span', 'pill', `${s.bookingCount} bookings`));
        if (s.serviceCount === 0) item.append(el('span', 'pill warn', 'no menu'));
        item.append(statusPill(s.status));
        list.append(item);
      }
      listWrap.append(list);
    } catch (err) {
      listWrap.innerHTML = '';
      listWrap.append(errorBox(err));
    }
  }

  await drawList();
}

/* ---------------- salon detail ---------------- */

async function salonView(salonId) {
  const view = $('#view');
  view.innerHTML = '';

  // Back to the queue when this was opened from it, back to the archive
  // otherwise — a reviewer working the request list should not be dropped
  // into a list of every salon on the platform after each decision.
  const cameFromRequests = document.referrer.endsWith('#/requests')
    || sessionStorage.getItem('adminLastList') === '#/requests';
  const back = el('a', 'btn sm', cameFromRequests ? '← Salon requests' : '← All salons');
  back.href = cameFromRequests ? '#/requests' : '#/salons';
  view.append(back);

  const s = await api(`/api/admin/salons/${salonId}`);

  const head = el('div', 'panel');
  const title = el('div', 'row');
  title.style.justifyContent = 'space-between';
  title.append(el('h1', null, s.name));
  title.append(statusPill(s.status));
  head.append(title);
  head.append(el('div', 'meta', `${s.address}${s.city ? ' · ' + s.city : ''}`));
  head.append(el('div', 'meta', `${s.timezone} · commission ${(s.commissionBps / 100).toFixed(2)}%`));
  // "Submitted" is the request's own date and moves on a resubmission;
  // "onboarded" is when the salon row first existed and never does. On a
  // first application they are the same day and only one is shown.
  const dates = [`Submitted ${day(s.submittedAt)}`];
  if (day(s.createdAt) !== day(s.submittedAt)) dates.push(`first applied ${day(s.createdAt)}`);
  if (s.approvedAt) dates.push(`approved ${day(s.approvedAt)}`);
  head.append(el('div', 'meta', dates.join(' · ')));
  view.append(head);

  // ---- the application itself ----
  // Everything the owner submitted, in one panel, because approving a salon
  // means judging a business and a name plus an address judges nothing.
  const appPanel = el('div', 'panel');
  appPanel.append(el('h2', null, s.status === 'pending' ? 'Application' : 'Salon details'));

  const facts = el('div', 'list');
  const fact = (k, v) => {
    const it = el('div', 'item');
    it.append(el('div', 'meta', k));
    it.append(el('div', 'grow', v || '—'));
    return it;
  };
  facts.append(fact('Phone', s.phone));
  facts.append(fact('Email', s.email));
  facts.append(fact('Address', [s.address, s.area, s.city].filter(Boolean).join(', ')));
  facts.append(fact('Location', `${s.lat}, ${s.lng}`));
  const map = el('a', 'btn sm', 'Open in maps ↗');
  map.href = `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`;
  map.target = '_blank';
  map.rel = 'noopener noreferrer';
  const mapRow = el('div', 'item');
  mapRow.append(el('div', 'meta', 'Verify'));
  mapRow.append(el('div', 'grow'), map);
  facts.append(mapRow);
  appPanel.append(facts);

  if (s.description) {
    appPanel.append(el('h3', null, 'Description'));
    appPanel.append(el('p', 'sub', s.description));
  }

  // Photos are the strongest signal an admin has that a real shop exists, so
  // they are shown, not linked.
  const gallery = [...(s.coverUrl ? [{ url: s.coverUrl, label: 'Storefront' }] : []),
                   ...(s.photos ?? []).map((url) => ({ url, label: '' }))];
  if (gallery.length) {
    appPanel.append(el('h3', null, 'Photos'));
    const strip = el('div', 'row');
    strip.style.cssText = 'flex-wrap:wrap; gap:10px';
    for (const g of gallery) {
      const link = el('a');
      link.href = g.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const img = el('img');
      img.src = g.url;
      img.alt = g.label || 'Salon photo';
      img.loading = 'lazy';
      img.style.cssText = 'width:150px; height:110px; object-fit:cover; border-radius:10px; display:block';
      // A dead link is itself a signal worth seeing.
      img.onerror = () => { link.replaceWith(el('div', 'out bad', 'image failed to load')); };
      link.append(img);
      const cell = el('div');
      cell.append(link);
      if (g.label) cell.append(el('div', 'meta', g.label));
      strip.append(cell);
    }
    appPanel.append(strip);
  } else {
    appPanel.append(el('div', 'note', 'No photos submitted.'));
  }

  // Replacing the storefront shot from here, for the salon that was onboarded
  // without one or sent in something unusable. It writes the same field the
  // owner's own upload writes, so there is one picture per salon and no
  // question about which of them wins.
  {
    const pickRow = el('div', 'row');
    pickRow.style.cssText = 'gap:10px; align-items:center; margin-top:12px; flex-wrap:wrap';
    const file = el('input');
    file.type = 'file';
    file.accept = ADMIN_IMAGE_TYPES.join(',');
    file.style.display = 'none';
    const pick = el('button', 'btn sm', s.coverUrl ? 'Replace storefront photo' : 'Add storefront photo');
    const outcome = el('div');
    pick.onclick = () => file.click();
    file.onchange = async () => {
      const chosen = file.files?.[0];
      // Cleared first, so picking the same file again after a cancel or a
      // failure still fires this.
      file.value = '';
      if (!chosen) return;
      outcome.innerHTML = '';
      const was = pick.textContent;
      try {
        const framed = await frameSalonPhoto(chosen);
        if (!framed) return;               // backed out of the resize dialog
        pick.disabled = true;
        pick.textContent = 'Uploading…';
        await uploadAdminSalonImage(s.id, framed);
        outcome.append(el('div', 'out ok', 'Saved.'));
        salonView(s.id);
      } catch (err) {
        outcome.append(el('div', 'out bad', err.message || 'Upload failed'));
        pick.disabled = false;
        pick.textContent = was;
      }
    };
    pickRow.append(pick, file);
    appPanel.append(pickRow, outcome);
  }
  view.append(appPanel);

  // ---- owner ----
  const ownerPanel = el('div', 'panel');
  ownerPanel.append(el('h2', null, 'Owner'));
  const o = el('div', 'list');
  const oi = el('div', 'item');
  oi.append(el('div', 'grow', s.owner.name || '(no name yet)'));
  if (s.owner.phone) oi.append(el('span', 'meta', s.owner.phone));
  if (s.owner.email) oi.append(el('span', 'meta', s.owner.email));
  oi.append(s.owner.hasSignedIn
    ? el('span', 'pill ok', 'signed in')
    : el('span', 'pill warn', 'never signed in'));
  // Approval is what turns a customer into a salon owner, so the role is the
  // clearest read on whether that has happened yet.
  oi.append(el('span', 'pill ' + (s.owner.role === 'business' ? 'ok' : ''),
    s.owner.role === 'business' ? 'salon owner' : s.owner.role));
  o.append(oi);
  ownerPanel.append(o);
  if (!s.owner.hasSignedIn) {
    ownerPanel.append(el('div', 'note',
      `This owner has not signed in yet. They sign in with Google as ${s.owner.email ?? '(no email on file)'}; ` +
      'the account they get is already attached to this salon. No further action here.'));
  }
  view.append(ownerPanel);

  // ---- status ----
  const statusPanel = el('div', 'panel');
  statusPanel.append(el('h2', null, 'Status'));
  const actions = el('div', 'row');
  // Mirrors ALLOWED_STATUS in src/admin/repo.ts. The server is the authority —
  // it refuses an illegal transition regardless of what this renders.
  const LEGAL = {
    pending: ['active', 'rejected', 'banned'],
    active: ['suspended', 'banned'],
    suspended: ['active', 'banned'],
    rejected: ['pending', 'banned'],
    banned: [],
  };
  const LABEL = {
    active: s.status === 'pending' ? 'Approve & activate' : 'Reactivate',
    rejected: 'Reject',
    pending: 'Reopen for review',
    suspended: 'Suspend',
    banned: 'Ban',
  };
  for (const to of LEGAL[s.status] ?? []) {
    const tone = to === 'active' ? ' primary' : to === 'pending' ? '' : ' danger';
    const b = el('button', 'btn sm' + tone, LABEL[to]);
    b.onclick = () => changeStatus(s, to);
    actions.append(b);
  }
  if (!(LEGAL[s.status] ?? []).length) {
    actions.append(el('div', 'meta', 'Banned is terminal — this salon cannot be reinstated.'));
  }
  if (s.status === 'pending') {
    statusPanel.append(el('div', 'note',
      'Approving makes this salon visible to customers and turns its owner into a salon owner. '
      + 'Until then they are a plain customer with no panel.'));
  }
  statusPanel.append(actions);

  if (s.statusHistory.length) {
    const hist = el('div', 'list');
    hist.style.marginTop = '12px';
    for (const h of s.statusHistory) {
      const it = el('div', 'item');
      it.append(el('div', 'grow', `${h.from ?? '—'} → ${h.to}${h.reason ? ` · ${h.reason}` : ''}`));
      it.append(el('span', 'meta', `${h.actor} · ${when(h.at)}`));
      hist.append(it);
    }
    statusPanel.append(hist);
  }
  view.append(statusPanel);

  // ---- services ----
  view.append(await salonServicesPanel(salonId, s.services));

  // ---- hours ----
  view.append(await salonHoursPanel(salonId, s.hours));

  // ---- money + bookings ----
  const money = el('div', 'panel');
  money.append(el('h2', null, 'Money'));
  const mrow = el('div', 'row');
  mrow.append(el('span', 'pill', `gross ${rupees(s.balance.gross)}`));
  mrow.append(el('span', 'pill', `commission ${rupees(s.balance.commission)}`));
  mrow.append(el('span', 'pill ok', `available ${rupees(s.balance.available)}`));
  money.append(mrow);
  view.append(money);

  const bookings = el('div', 'panel');
  bookings.append(el('h2', null, 'Recent bookings (read-only)'));
  if (!s.recentBookings.length) {
    bookings.append(el('div', 'empty', 'No bookings yet.'));
  } else {
    const bl = el('div', 'list');
    for (const b of s.recentBookings) {
      const it = el('div', 'item');
      it.append(el('div', 'when', when(b.startAt)));
      it.append(el('div', 'grow', b.customerName || b.customerPhone || 'Customer'));
      it.append(el('strong', null, rupees(b.amount)));
      it.append(el('span', 'pill', b.status.replace(/_/g, ' ')));
      bl.append(it);
    }
    bookings.append(bl);
  }
  view.append(bookings);
}

/**
 * Deactivation asks about future bookings, showing the count, because the
 * default is silent: createBooking already refuses a non-active salon, so no
 * NEW bookings follow — but the ones already promised are untouched, and
 * fourteen customers turning up at a switched-off salon is the failure this
 * prompt exists to prevent.
 */
async function changeStatus(salon, to) {
  const deactivating = to !== 'active';
  const offerCancel = deactivating && salon.futureBookings > 0;

  // One dialog, asking both questions at once. This used to be a confirm()
  // followed by a prompt(); prompt() throws outright where dialogs are not
  // supported, and because it sat outside the try below, the throw rejected
  // this function into an onclick that ignored the promise. The button did
  // nothing at all, with nothing logged and nothing shown.
  const answer = await ask({
    title:
      to === 'active'
        ? (salon.status === 'pending' ? 'Approve and activate this salon?' : 'Reactivate this salon?')
        : to === 'suspended' ? 'Suspend this salon?' : 'Ban this salon?',
    message:
      to === 'active'
        ? 'It becomes visible to customers and can take bookings immediately.'
        : offerCancel
          ? `This salon has ${salon.futureBookings} upcoming booking(s).\n` +
            'No new bookings can be made either way. The ones already promised are ' +
            'left standing unless you cancel them here — otherwise those customers ' +
            'still turn up.'
          : 'No new bookings can be made while it is in this state.',
    confirmLabel: to === 'active' ? 'Approve & activate' : to === 'suspended' ? 'Suspend' : 'Ban',
    danger: deactivating,
    input: { label: 'Reason (optional)', placeholder: 'Recorded in the status history' },
    ...(offerCancel
      ? { checkbox: { label: `Cancel those ${salon.futureBookings} booking(s) and queue refunds`, checked: false } }
      : {}),
  });

  if (!answer) return; // dismissed

  try {
    const result = await api(`/api/admin/salons/${salon.id}/status`, {
      method: 'POST',
      body: JSON.stringify({
        status: to,
        reason: answer.value || null,
        cancelFutureBookings: answer.checked,
      }),
    });
    salonView(salon.id);
    if (result.cancelledBookings) {
      await notify({
        title: 'Status changed',
        message: `${result.cancelledBookings} booking(s) cancelled, ${result.refundsQueued} refund(s) queued.`,
      });
    }
  } catch (err) {
    await notify({ title: 'Could not change status', message: err.message, tone: 'bad' });
  }
}

async function salonServicesPanel(salonId, services) {
  const panel = el('div', 'panel');
  panel.append(el('h2', null, 'Menu'));
  panel.append(el('div', 'note',
    'Prices are what the customer pays; duration is chair time. A salon with nothing active here is invisible to customers.'));

  const wrap = el('div', 'scroll-x');
  const table = el('table');
  table.innerHTML = '<thead><tr><th>Service</th><th>Category</th><th>Price ₹</th><th>Mins</th><th>Buffer</th><th>Live</th><th></th></tr></thead>';
  const tbody = el('tbody');

  for (const sv of services) {
    const tr = el('tr');
    tr.append(el('td', null, sv.name));
    tr.append(el('td', null, sv.category));

    const price = el('input'); price.type = 'number'; price.value = sv.price != null ? sv.price / 100 : '';
    const dur   = el('input'); dur.type = 'number';   dur.value = sv.durationMin ?? 30;
    const buf   = el('input'); buf.type = 'number';   buf.value = sv.bufferMin ?? 10;
    const live  = el('input'); live.type = 'checkbox'; live.checked = Boolean(sv.active);

    for (const [node, cell] of [[price,'td'],[dur,'td'],[buf,'td'],[live,'td']]) {
      const td = el(cell); td.append(node); tr.append(td);
    }

    const save = el('button', 'btn sm primary', 'Save');
    save.onclick = async () => {
      save.disabled = true; save.textContent = '…';
      try {
        await api(`/api/admin/salons/${salonId}/services/${sv.serviceId}`, {
          method: 'PUT',
          body: JSON.stringify({
            price: Math.round(Number(price.value) * 100),
            durationMin: Number(dur.value),
            bufferMin: Number(buf.value),
            active: live.checked,
          }),
        });
        save.textContent = 'Saved';
      } catch (err) {
        await notify({ title: 'Could not save', message: err.message, tone: 'bad' });
        save.textContent = 'Save';
      } finally {
        save.disabled = false;
        setTimeout(() => { save.textContent = 'Save'; }, 1200);
      }
    };
    const td = el('td'); td.append(save); tr.append(td);
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  panel.append(wrap);
  return panel;
}

async function salonHoursPanel(salonId, hours) {
  const panel = el('div', 'panel');
  panel.append(el('h2', null, 'Timings'));
  panel.append(el('div', 'note',
    'Capacity is chairs bookable online at once. A day with no row is a non-working day.'));

  const wrap = el('div', 'scroll-x');
  const table = el('table');
  table.innerHTML = '<thead><tr><th>Day</th><th>Open</th><th>Open</th><th>Close</th><th>Break</th><th>Break end</th><th>Chairs</th><th>Slot</th><th></th></tr></thead>';
  const tbody = el('tbody');

  for (const h of hours) {
    const tr = el('tr');
    tr.append(el('td', null, DOW[h.weekday]));
    const working = el('input'); working.type = 'checkbox'; working.checked = h.working;
    const open  = el('input'); open.type  = 'time'; open.value  = h.openAt;
    const close = el('input'); close.type = 'time'; close.value = h.closeAt;
    const bs    = el('input'); bs.type    = 'time'; bs.value    = h.breakStart ?? '';
    const be    = el('input'); be.type    = 'time'; be.value    = h.breakEnd ?? '';
    const cap   = el('input'); cap.type   = 'number'; cap.value = h.onlineCapacity;
    const slot  = el('select');
    for (const v of [20, 30, 45]) {
      const o = el('option', null, `${v} min`); o.value = String(v);
      if (v === h.slotIntervalMin) o.selected = true;
      slot.append(o);
    }
    for (const node of [working, open, close, bs, be, cap, slot]) {
      const td = el('td'); td.append(node); tr.append(td);
    }
    const save = el('button', 'btn sm primary', 'Save');
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api(`/api/admin/salons/${salonId}/hours/${h.weekday}`, {
          method: 'PUT',
          body: JSON.stringify({
            working: working.checked,
            openAt: open.value, closeAt: close.value,
            breakStart: bs.value || null, breakEnd: be.value || null,
            onlineCapacity: Number(cap.value),
            slotIntervalMin: Number(slot.value),
          }),
        });
        save.textContent = 'Saved';
      } catch (err) {
        await notify({ title: 'Could not save', message: err.message, tone: 'bad' });
      } finally {
        save.disabled = false;
        setTimeout(() => { save.textContent = 'Save'; }, 1200);
      }
    };
    const td = el('td'); td.append(save); tr.append(td);
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  panel.append(wrap);
  return panel;
}

/* ---------------- onboard ---------------- */

function onboardView() {
  const view = $('#view');
  view.innerHTML = '';
  view.append(el('h1', null, 'Onboard a salon'));
  view.append(el('p', 'sub', 'Creates the salon and an owner account. The owner claims it by signing in with Google using the email address below — so it must be the address on their Google account, or they will get a fresh customer account instead of this salon.'));

  const panel = el('div', 'panel');
  const grid = el('div', 'grid two');

  const field = (label, node, hint) => {
    const l = el('label', 'field');
    l.append(el('span', null, label));
    l.append(node);
    if (hint) l.append(el('div', 'meta', hint));
    return l;
  };
  const input = (placeholder, value = '', type = 'text') => {
    const i = el('input'); i.placeholder = placeholder; i.value = value; i.type = type; return i;
  };

  const name = input('Salon name');
  const address = input('12 MG Road, Indiranagar');
  const city = input('Bengaluru');
  const area = input('Indiranagar');
  // Optional. The server geocodes the address; these are an override for the
  // rare salon a geocoder cannot place. Typed coordinates were the default
  // once and produced a Jind salon sitting in Chad.
  const lat = input('optional', '', 'number');
  const lng = input('optional', '', 'number');
  const tz = input('Asia/Kolkata', 'Asia/Kolkata');
  const commission = input('1500', '', 'number');
  const salonPhone = input('+918012345678');
  const salonEmail = input('salon@example.com');
  const ownerPhone = input('+919876543210');
  const ownerName = input('Rahul Sharma');
  const ownerEmail = input('rahul@example.com');

  const status = el('select');
  for (const [label, v] of [['Pending review','pending'],['Active immediately','active']]) {
    const o = el('option', null, label); o.value = v; status.append(o);
  }

  // The storefront photo, taken on the admin's phone while they are standing
  // in the salon. Uploaded after the salon exists, because the image is stored
  // against a salon id — see the two-step in submit below.
  const photo = el('input');
  photo.type = 'file';
  photo.accept = ADMIN_IMAGE_TYPES.join(',');

  grid.append(
    field('Salon name *', name),
    field('Address *', address),
    field('City *', city, 'What the operator filters by'),
    field('Area', area),
    field('Latitude', lat, 'Leave blank — found from the address'),
    field('Longitude', lng),
    field('Timezone', tz, 'IANA zone; rejected if not real'),
    field('Commission (bps)', commission, 'Blank uses PLATFORM_COMMISSION_BPS'),
    field('Salon phone', salonPhone),
    field('Salon email', salonEmail),
    field('Owner phone *', ownerPhone, 'E.164. So the platform can ring them; not used at sign-in.'),
    field('Owner name', ownerName),
    field('Owner email *', ownerEmail, 'Their Google address. This is what they sign in with.'),
    field('Status', status),
    field('Salon photo', photo,
      `Optional. JPEG, PNG or WebP up to ${ADMIN_MAX_IMAGE_MB} MB. The owner and customers see this same picture; `
      + 'leave it empty and the salon keeps the lettered placeholder until the owner adds one.'),
  );
  panel.append(grid);

  const out = el('div');
  const submit = el('button', 'btn primary', 'Create salon');
  submit.style.marginTop = '16px';
  submit.onclick = async () => {
    out.innerHTML = '';
    submit.disabled = true; submit.textContent = 'Creating…';
    try {
      const body = {
        name: name.value.trim(),
        address: address.value.trim(),
        city: city.value.trim(),
        area: area.value.trim() || null,
        ...(lat.value !== '' ? { lat: Number(lat.value) } : {}),
        ...(lng.value !== '' ? { lng: Number(lng.value) } : {}),
        timezone: tz.value.trim() || 'Asia/Kolkata',
        status: status.value,
        phone: salonPhone.value.trim() || null,
        email: salonEmail.value.trim() || null,
        owner: {
          phone: ownerPhone.value.trim(),
          name: ownerName.value.trim() || null,
          email: ownerEmail.value.trim(),
        },
      };
      if (commission.value !== '') body.commissionBps = Number(commission.value);

      const created = await api('/api/admin/salons', { method: 'POST', body: JSON.stringify(body) });

      // The photo, if one was chosen. Second step on purpose: it is stored
      // against the salon id, and that id does not exist until the line above
      // returns. A failure here is reported without pretending the salon
      // failed — it exists, it simply has no picture yet, and the owner can
      // add one from their own panel.
      let photoNote = '';
      const chosen = photo.files?.[0];
      if (chosen) {
        try {
          // Framed after the salon exists, like the upload itself: the dialog
          // is the admin's last chance to say which part of the shot is the
          // salon. Cancelling it leaves the salon created and photoless,
          // which the note below says plainly.
          const framed = await frameSalonPhoto(chosen);
          if (framed) {
            await uploadAdminSalonImage(created.salonId, framed);
            photoNote = '\nThe photo is saved — the owner and customers see it now.';
          } else {
            photoNote = '\nThe salon was created without a photo — the owner can add one from their panel.';
          }
        } catch (err) {
          photoNote = `\nThe salon was created but the photo did not upload: ${err.message}`;
        }
      }

      out.append(el('div', 'out ok',
        `Created. Seven days of default hours (10:00–20:00, 1 chair, 30 min) are in place.\n` +
        `The owner ${created.ownerExisted ? 'already existed and was promoted' : 'was created'} — ` +
        `they sign in with Google as ${body.owner.email}.` + photoNote));
      const go = el('a', 'btn sm primary', 'Open salon →');
      go.href = `#/salon/${created.salonId}`;
      out.append(go);
    } catch (err) {
      out.append(errorBox(err));
    } finally {
      submit.disabled = false; submit.textContent = 'Create salon';
    }
  };
  panel.append(submit, out);
  view.append(panel);
}

/* ---------------- catalogue ---------------- */

async function catalogView() {
  const view = $('#view');
  view.innerHTML = '';
  view.append(el('h1', null, 'Service catalogue'));
  view.append(el('p', 'sub', 'The global master list every salon menu draws from. Adding a service here does not put it on any menu.'));

  const add = el('div', 'panel');
  const row = el('div', 'row');
  const n = el('input'); n.placeholder = 'Service name';
  const c = el('input'); c.placeholder = 'Category (hair, beard, skin, nails, spa, bridal)';
  const b = el('button', 'btn primary', 'Add');
  row.append(n, c, b);
  add.append(row);
  const addOut = el('div');
  add.append(addOut);
  view.append(add);

  const listPanel = el('div', 'panel');
  view.append(listPanel);

  async function draw() {
    listPanel.innerHTML = '';
    listPanel.append(el('h2', null, 'Catalogue'));
    const { services } = await api('/api/admin/services');
    const list = el('div', 'list');
    for (const sv of services) {
      const it = el('div', 'item');
      it.append(el('div', 'grow', sv.name));
      it.append(el('span', 'pill', sv.category));
      it.append(el('span', 'meta', `${sv.usageCount} salon(s)`));
      const del = el('button', 'btn sm danger', 'Delete');
      del.disabled = sv.usageCount > 0;
      del.title = sv.usageCount > 0
        ? 'In use by a salon menu — removing it would rewrite booking history'
        : 'Not used by any salon';
      del.onclick = async () => {
        const ok = await ask({
          title: `Delete "${sv.name}" from the catalogue?`,
          message: 'Salons already offering it keep their own copy; this only removes it from the list new salons pick from.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        try { await api(`/api/admin/services/${sv.id}`, { method: 'DELETE' }); draw(); }
        catch (err) { await notify({ title: 'Could not delete', message: err.message, tone: 'bad' }); }
      };
      it.append(del);
      list.append(it);
    }
    listPanel.append(list);
  }

  b.onclick = async () => {
    addOut.innerHTML = '';
    try {
      await api('/api/admin/services', {
        method: 'POST',
        body: JSON.stringify({ name: n.value.trim(), category: c.value.trim() }),
      });
      n.value = ''; c.value = '';
      draw();
    } catch (err) {
      addOut.append(errorBox(err));
    }
  };

  await draw();
}

/* ---------------- shell ---------------- */

const routes = [
  [/^#\/overview$/, overviewView],
  [/^#\/requests$/, requestsView],
  [/^#\/salons$/, salonsView],
  [/^#\/salon\/([\w-]+)$/, salonView],
  [/^#\/onboard$/, onboardView],
  [/^#\/catalog$/, catalogView],
];

function render() {
  const hash = location.hash || '#/overview';
  const key = hash.replace('#/', '').split('/')[0];
  for (const a of $$('[data-nav]')) a.removeAttribute('aria-current');
  const navKey = key === 'salon' ? 'salons' : key;
  $(`[data-nav="${navKey}"]`)?.setAttribute('aria-current', 'page');

  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      return Promise.resolve(fn(...m.slice(1))).catch((err) => {
        $('#view').innerHTML = '';
        $('#view').append(errorBox(err));
      });
    }
  }
  location.hash = '#/overview';
}

async function refreshPendingBadge() {
  try {
    const o = await api('/api/admin/overview');
    // Lives in the sidebar link now, so the size of the queue is visible from
    // every screen rather than only from Salons. .side-count is the sidebar's
    // own count chip; an empty className leaves nothing rendered.
    const badge = $('#pendingBadge');
    badge.textContent = o.pending ? String(o.pending) : '';
    badge.className = o.pending ? 'side-count' : '';
  } catch { /* the nav badge is not worth an error state */ }
}

async function initIdentity() {
  const who = $('#whoami');
  try {
    const me = await api('/api/me');
    who.innerHTML = '';
    who.append(el('span', 'meta', me.email || me.name || me.phone));
    const out = el('button', 'btn sm', 'Sign out');
    out.onclick = async () => { await signOut(); location.reload(); };
    who.append(out);
    return me;
  } catch {
    who.innerHTML = '';
    who.append(googleButton('btn sm primary', 'Sign in'));
    return null;
  }
}

/**
 * The page itself is public — every byte of data behind it is authorised
 * server-side, and this gate is a courtesy, not the security boundary.
 */
function renderNotAdmin(kind) {
  const view = $('#view');
  view.innerHTML = '';
  const box = el('div', 'panel');
  if (kind === 'anon') {
    box.append(el('h1', null, 'Sign in'));
    box.append(el('p', 'sub',
      'The admin panel needs a Hasino platform account. It signs in on its own — '
      + 'a session on the public app does not carry over to this origin.'));
    box.append(googleButton('btn primary', 'Sign in with Google'));
  } else {
    box.append(el('h1', null, 'Not an admin account'));
    box.append(el('p', 'sub',
      'This account is signed in but is not a platform admin. Admin access comes from the ADMIN_EMAILS ' +
      'environment variable on the server — adding an address there and signing in again grants it.'));
  }
  view.append(box);
}

window.addEventListener('hashchange', render);

/**
 * Coming back from Google. Finish the OAuth handshake before anything else
 * runs: this page load is not a route, it carries Clerk's parameters in its
 * query string, and Clerk navigates on to the panel itself once it is done.
 */
if (isRedirectCallback()) {
  completeRedirectCallback().catch(async (err) => {
    console.error('sign-in could not be completed', err);
    await notify({ title: 'Sign-in could not be completed', message: err.message, tone: 'bad' });
    location.replace('/');
  });
}

/**
 * Re-render the panel when the *identity* changes, and at no other time.
 *
 * watchAuthState fires on every Clerk resource change, not just sign-in and
 * sign-out — a session token refresh, which Clerk does on its own about once a
 * minute, emits too. Calling render() on each of those rebuilds the current
 * view from scratch, and onboardView() starts with `view.innerHTML = ''`. An
 * admin halfway through typing a salon watched the form empty itself roughly
 * every minute, which looks exactly like the page reloading.
 *
 * undefined rather than null as the initial value, so the very first callback
 * always gets through: signed out is a real state and null is its id.
 */
let lastUserId;

watchAuthState(async (user) => {
  const userId = user?.id ?? null;
  if (userId === lastUserId) return; // same person, just a refreshed token
  lastUserId = userId;

  const me = await initIdentity();
  if (!me) return renderNotAdmin('anon');
  if (me.role !== 'admin') return renderNotAdmin('forbidden');
  await refreshPendingBadge();
  render();
}).catch(() => renderNotAdmin('anon'));
