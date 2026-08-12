import { el } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { currentPosition } from '../lib/location.js';

/**
 * "List your salon" — a signed-in customer applying to join.
 *
 * The application lands as pending, is invisible to customers, and grants the
 * applicant nothing. An admin approving it is what makes the salon live and
 * its author a salon owner, in that one step.
 */
export function renderApply(container, app) {
  const session = app.requireSession();
  if (!session) return;
  container.innerHTML = '';

  container.append(el('h1', null, 'Apply as a Salon'));

  // One salon per owner, so anyone who has already applied gets the state of
  // that application rather than a form that would only 409.
  if (session.salon) {
    const done = el('div', 'panel');
    if (session.salon.status === 'pending') {
      done.append(el('h2', null, 'Your application is under review'));
      done.append(el('p', 'sub',
        `${session.salon.name} is with a Hasino admin. It is not visible to customers yet, and your `
        + 'salon dashboard unlocks the moment it is approved.'));
    } else if (session.salon.status === 'rejected') {
      // Not a dead end: resubmitting sends it back to review, which is a way
      // to fix what was wrong rather than a way around approval.
      done.append(el('h2', null, 'Your application was not approved'));
      done.append(el('p', 'sub',
        `${session.salon.name} was turned down. Update the details below and submit again — `
        + 'it goes back to a Hasino admin for review.'));
      container.append(done);
      renderForm(container, app);
      return;
    } else if (session.role === 'business') {
      done.append(el('h2', null, 'You already have a salon'));
      const go = el('a', 'btn primary', 'Open your salon panel');
      go.href = '/business';
      done.append(go);
    } else {
      done.append(el('h2', null, `${session.salon.name} is ${session.salon.status}`));
      done.append(el('p', 'sub', 'Contact Hasino support if you think this is wrong.'));
    }
    container.append(done);
    return;
  }

  container.append(
    el('p', 'sub',
      'Tell us about your salon. A Hasino admin reviews every application before it goes live — '
      + 'usually a couple of days.'),
  );

  renderForm(container, app);
}

/** The application itself, shared by a first submission and a resubmission. */
function renderForm(container, app) {
  const panel = el('div', 'panel');
  const name = Input({ label: 'Salon name', placeholder: 'Sharp & Co' });
  const address = Input({ label: 'Address', placeholder: '12 MG Road, Indiranagar' });
  const city = Input({ label: 'City', placeholder: 'Bengaluru' });
  const area = Input({ label: 'Area (optional)', placeholder: 'Indiranagar' });
  // No latitude/longitude fields. The server geocodes the address, and the
  // button below is for an owner standing in their own shop — both beat asking
  // anyone to type two decimal numbers they cannot check.
  let coords = null;
  const phone = Input({ label: 'Salon phone', type: 'tel', placeholder: '+91 98765 43210' });
  const openAt = Input({ label: 'Opens at', type: 'time' });
  const closeAt = Input({ label: 'Closes at', type: 'time' });
  openAt.input.value = '10:00';
  closeAt.input.value = '20:00';
  const coverUrl = Input({ label: 'Storefront photo URL', placeholder: 'https://…' });
  const photos = Input({ label: 'More photo URLs (one per line)' });
  const description = Input({ label: 'About your salon', placeholder: 'Two chairs, open since 2019…' });

  const pinNote = el('div', 'note',
    'We find your salon on the map from the address above. If you are at the salon now, '
    + 'this pins it exactly.');
  const locate = Button({
    label: '📍 Pin my exact location',
    size: 'sm',
    onClick: async () => {
      locate.disabled = true;
      locate.textContent = 'Locating…';
      try {
        coords = await currentPosition();
        pinNote.textContent = `Pinned to your current position (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}).`;
        locate.textContent = '📍 Pinned';
      } catch (err) {
        coords = null;
        // Not a failure worth blocking on: without a pin the address is
        // geocoded, which is what most applicants will rely on anyway.
        pinNote.textContent = `${err.message} We will locate your salon from the address instead.`;
        locate.disabled = false;
        locate.textContent = '📍 Pin my exact location';
      }
    },
  });

  const grid = el('div', 'grid two');
  grid.append(name, phone, address, city, area, openAt, closeAt);
  panel.append(grid, locate, pinNote);

  // ---- menu ----
  // Picked from the same catalogue every salon's menu is built from, so an
  // approved salon is immediately bookable instead of being live with nothing
  // to sell. The owner can change any of it later in their dashboard.
  const menu = el('div');
  const chosen = new Map();   // serviceId -> { price, durationMin }
  panel.append(el('h2', null, 'Your services'));
  panel.append(el('div', 'note',
    'Tick what you offer and set your prices in rupees. You can change these any time '
    + 'once your salon is live.'));
  panel.append(menu);
  menu.append(el('div', 'note', 'Loading the service list…'));

  api('/api/services').then(({ services }) => {
    menu.innerHTML = '';
    const list = el('div', 'list');
    for (const svc of services) {
      const row = el('div', 'item');
      const tick = el('input');
      tick.type = 'checkbox';
      const price = el('input');
      price.type = 'number';
      price.min = '0';
      price.placeholder = '₹';
      price.style.maxWidth = '110px';
      price.disabled = true;
      const mins = el('input');
      mins.type = 'number';
      mins.min = '5';
      mins.value = '30';
      mins.style.maxWidth = '90px';
      mins.disabled = true;

      const sync = () => {
        price.disabled = !tick.checked;
        mins.disabled = !tick.checked;
        if (!tick.checked) return chosen.delete(svc.id);
        chosen.set(svc.id, {
          // Rupees in the form, paise on the wire — everything that touches
          // money in this system is an integer number of paise.
          price: Math.round(Number(price.value || 0) * 100),
          durationMin: Number(mins.value || 30),
        });
      };
      tick.onchange = sync;
      price.oninput = sync;
      mins.oninput = sync;

      row.append(tick);
      row.append(el('div', 'grow', svc.name));
      row.append(el('span', 'meta', svc.category));
      row.append(price, el('span', 'meta', 'min'), mins);
      list.append(row);
    }
    menu.append(list);
  }).catch(() => {
    menu.innerHTML = '';
    menu.append(el('div', 'note',
      'Could not load the service list. You can submit without it and set your menu up after approval.'));
  });

  panel.append(el('h2', null, 'Photos and description'));
  panel.append(el('div', 'note',
    'A Hasino admin reads this to decide whether to approve you, so a real storefront photo '
    + 'and a couple of words about the salon make the difference. Paste image links for now — '
    + 'direct uploads are coming.'));
  panel.append(coverUrl, photos, description);

  const out = el('div');
  const submit = Button({
    label: 'Submit application',
    variant: 'primary',
    onClick: async () => {
      out.innerHTML = '';
      submit.disabled = true;
      submit.textContent = 'Submitting…';
      try {
        await api('/api/salons/apply', {
          method: 'POST',
          body: JSON.stringify({
            name: name.input.value.trim(),
            address: address.input.value.trim(),
            city: city.input.value.trim(),
            area: area.input.value.trim() || null,
            // Omitted when there is no pin — the server geocodes the address.
            ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
            phone: phone.input.value.trim() || null,
            openAt: openAt.input.value || null,
            closeAt: closeAt.input.value || null,
            description: description.input.value.trim() || null,
            coverUrl: coverUrl.input.value.trim() || null,
            photoUrls: photos.input.value.split('\n').map((u) => u.trim()).filter(Boolean),
            services: [...chosen.entries()].map(([serviceId, v]) => ({ serviceId, ...v })),
          }),
        });
        await app.refreshSession().catch(() => {});
        container.innerHTML = '';
        const done = el('div', 'panel');
        done.append(el('h1', null, 'Application received'));
        done.append(el('p', 'sub',
          'A Hasino admin will review it. Nothing is visible to customers until it is approved — '
          + 'once it is, your salon dashboard unlocks and you can set up services and timings. '
          + 'We will email you at the address you signed in with.'));
        const go = el('a', 'btn primary', 'Back to Hasino');
        go.href = '#/home';
        done.append(go);
        container.append(done);
      } catch (err) {
        const message =
          err instanceof ApiError && err.code === 'ALREADY_OWNS_SALON'
            ? 'You already have a salon on Hasino.'
            : err.message;
        out.append(el('div', 'out bad', message));
        submit.disabled = false;
        submit.textContent = 'Submit application';
      }
    },
  });
  submit.style.marginTop = 'var(--space-4)';
  panel.append(submit, out);
  container.append(panel);
}
