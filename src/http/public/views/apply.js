import { el } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

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

  container.append(el('h1', null, 'List your salon on Hasino'));

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
      done.append(el('h2', null, 'Your application was not approved'));
      done.append(el('p', 'sub',
        'Reply to the email we sent and we will take another look.'));
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

  const panel = el('div', 'panel');
  const name = Input({ label: 'Salon name', placeholder: 'Sharp & Co' });
  const address = Input({ label: 'Address', placeholder: '12 MG Road, Indiranagar' });
  const city = Input({ label: 'City', placeholder: 'Bengaluru' });
  const area = Input({ label: 'Area (optional)', placeholder: 'Indiranagar' });
  const lat = Input({ label: 'Latitude', type: 'number', placeholder: '12.9719' });
  const lng = Input({ label: 'Longitude', type: 'number', placeholder: '77.6412' });
  const phone = Input({ label: 'Salon phone', type: 'tel', placeholder: '+91 98765 43210' });
  const openAt = Input({ label: 'Opens at', type: 'time' });
  const closeAt = Input({ label: 'Closes at', type: 'time' });
  openAt.input.value = '10:00';
  closeAt.input.value = '20:00';
  const coverUrl = Input({ label: 'Storefront photo URL', placeholder: 'https://…' });
  const photos = Input({ label: 'More photo URLs (one per line)' });
  const description = Input({ label: 'About your salon', placeholder: 'Two chairs, open since 2019…' });

  const locate = Button({
    label: 'Use my current location',
    size: 'sm',
    onClick: () => {
      if (!navigator.geolocation) return;
      locate.disabled = true;
      locate.textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          lat.input.value = pos.coords.latitude.toFixed(6);
          lng.input.value = pos.coords.longitude.toFixed(6);
          locate.disabled = false;
          locate.textContent = 'Use my current location';
        },
        () => {
          locate.disabled = false;
          locate.textContent = 'Could not get location — enter it manually';
        },
        { timeout: 8000 },
      );
    },
  });

  const grid = el('div', 'grid two');
  grid.append(name, phone, address, city, area, lat, lng, openAt, closeAt);
  panel.append(grid, locate);

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
            lat: Number(lat.input.value),
            lng: Number(lng.input.value),
            phone: phone.input.value.trim() || null,
            openAt: openAt.input.value || null,
            closeAt: closeAt.input.value || null,
            description: description.input.value.trim() || null,
            coverUrl: coverUrl.input.value.trim() || null,
            photoUrls: photos.input.value.split('\n').map((u) => u.trim()).filter(Boolean),
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
