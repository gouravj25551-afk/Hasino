import { el } from '../lib/dom.js';
import { api, ApiError } from '../lib/api.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

/**
 * "List your salon" — a signed-in customer applying to join.
 *
 * The application lands as pending and is invisible to customers until an
 * admin approves it. The applicant becomes a salon owner immediately so they
 * can set up their menu and hours while they wait; nothing they do is public
 * until approval.
 */
export function renderApply(container, app) {
  const session = app.requireSession();
  if (!session) return;
  container.innerHTML = '';

  container.append(el('h1', null, 'List your salon on Hasino'));
  container.append(
    el('p', 'sub',
      'Tell us where you are. We review every salon before it goes live — usually a couple of days. ' +
      'You can set up your services and timings straight away.'),
  );

  if (session.role === 'business') {
    const done = el('div', 'panel');
    done.append(el('h2', null, 'You already have a salon'));
    const go = el('a', 'btn primary', 'Open your salon panel');
    go.href = '/business';
    done.append(go);
    container.append(done);
    return;
  }

  const panel = el('div', 'panel');
  const name = Input({ label: 'Salon name', placeholder: 'Sharp & Co' });
  const address = Input({ label: 'Address', placeholder: '12 MG Road, Indiranagar' });
  const city = Input({ label: 'City', placeholder: 'Bengaluru' });
  const area = Input({ label: 'Area (optional)', placeholder: 'Indiranagar' });
  const lat = Input({ label: 'Latitude', type: 'number', placeholder: '12.9719' });
  const lng = Input({ label: 'Longitude', type: 'number', placeholder: '77.6412' });

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
  grid.append(name, address, city, area, lat, lng);
  panel.append(grid, locate);

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
          }),
        });
        await app.refreshSession().catch(() => {});
        container.innerHTML = '';
        const done = el('div', 'panel');
        done.append(el('h1', null, 'Application received'));
        done.append(el('p', 'sub',
          'We will review it shortly. In the meantime you can add your services and set your timings — ' +
          'nothing is visible to customers until we approve you.'));
        const go = el('a', 'btn primary', 'Set up my salon');
        go.href = '/business';
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
