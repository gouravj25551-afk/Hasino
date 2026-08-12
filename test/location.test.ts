/**
 * The location selector.
 *
 * The geocoder itself is somebody else's network service and is not asserted
 * here — what is asserted is that we never call it when we should not, that a
 * bad coordinate is refused before it leaves, and that the header no longer
 * claims to know where anyone is.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import { searchPlaces } from '../src/geo/geocode.ts';
import { resolveCoords } from '../src/admin/repo.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('no hardcoded city', () => {
  const topbar = read('src/http/public/components/TopBar.js');
  // Prose recording what this used to do is fine; a live default is not.
  const code = topbar.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('the header has no default city', () => {
    // It read 'Bengaluru' for every visitor, which told a customer in Sonipat
    // they were somewhere else and made the chip look like a fact.
    assert.doesNotMatch(code, /locationLabel = '/, 'locationLabel must not default to a city');
    assert.doesNotMatch(code, /Bengaluru/);
  });

  it('invites a choice when nothing is chosen', () => {
    assert.match(topbar, /Select location/);
  });

  it('renders the place name as text, not markup', () => {
    // The label comes from a geocoder. A place name is not HTML.
    assert.doesNotMatch(topbar, /innerHTML = `📍/);
    assert.match(topbar, /textContent: locationLabel/);
  });
});

describe('discovery uses the chosen location', () => {
  it('home no longer prompts for geolocation on load', () => {
    const home = read('src/http/public/views/home.js');
    // Asking unprompted on every page load is what the selector replaces, and
    // a refusal there used to leave no way to say where you are.
    assert.doesNotMatch(home, /navigator\.geolocation/);
    assert.match(home, /locationParams\(\)/);
  });

  it('explore sorts by the chosen location too', () => {
    assert.match(read('src/http/public/views/explore.js'), /locationParams\(\)/);
  });

  it('both client modules are actually served', () => {
    // loadAssets() takes an explicit allowlist; a module missing from it 404s
    // at import time and takes the page down with it.
    const server = read('src/http/server.ts');
    assert.match(server, /'lib\/location\.js'/);
    assert.match(server, /'components\/LocationSheet\.js'/);
  });
});

describe('the geocode proxy', () => {
  it('does not call out for a query too short to mean anything', async () => {
    // One character matches half of India. This returns without a request.
    assert.deepEqual(await searchPlaces(''), []);
    assert.deepEqual(await searchPlaces(' '), []);
    assert.deepEqual(await searchPlaces('a'), []);
  });

  it('validates coordinates in the route before calling the provider', () => {
    const server = read('src/http/server.ts');
    const route = server.slice(server.indexOf("path === '/api/geo/reverse'"));
    assert.match(route, /Number\.isFinite\(lat\)/);
    assert.match(route, /lat < -90 \|\| lat > 90/);
  });

  it('is swappable without touching the client', () => {
    // The browser only ever talks to our own origin, so replacing Nominatim
    // with Google or Mapbox is one module.
    const geo = read('src/geo/geocode.ts');
    assert.match(geo, /GEOCODER_URL/);
    const client = read('src/http/public/lib/location.js');
    assert.match(client, /\/api\/geo\/reverse/);
    assert.doesNotMatch(client, /nominatim|googleapis|mapbox/i);
  });

  it('identifies itself, as the provider requires', () => {
    assert.match(read('src/geo/geocode.ts'), /user-agent/);
  });
});

describe('the stored location', () => {
  const loc = read('src/http/public/lib/location.js');

  it('keeps the coordinates, not just the label', () => {
    // The label is for the header; lat/lng is what /api/salons sorts by.
    // Storing only the string would mean geocoding the same city on every load.
    for (const field of ['lat', 'lng', 'city', 'area', 'pincode', 'source']) {
      assert.match(loc, new RegExp(field), `${field} must be part of the stored location`);
    }
  });

  it('records how the location was chosen', () => {
    assert.match(loc, /CURRENT_LOCATION/);
    assert.match(loc, /MANUAL/);
  });

  it('survives a corrupted value rather than breaking the header', () => {
    assert.match(loc, /localStorage\.removeItem/);
  });

  it('distinguishes every geolocation failure', () => {
    // "Location unavailable" covers four different situations and only one of
    // them is worth retrying.
    for (const code of ['PERMISSION_DENIED', 'UNAVAILABLE', 'TIMEOUT', 'UNSUPPORTED']) {
      assert.match(loc, new RegExp(code));
    }
  });
});

describe('onboarding does not ask anyone to type coordinates', () => {
  it('trusts coordinates that are given, without calling out', async () => {
    // An owner standing in their own shop knows better than a geocoder.
    const at = await resolveCoords({ lat: 29.1234, lng: 76.5678, address: 'x', city: 'Jind' });
    assert.deepEqual(at, { lat: 29.1234, lng: 76.5678 });
  });

  it('still rejects an impossible coordinate', async () => {
    await assert.rejects(
      resolveCoords({ lat: 999, lng: 12, address: 'x', city: 'Jind' }),
      (e: { code?: string }) => e.code === 'BAD_LAT',
    );
  });

  it('neither form asks for latitude and longitude any more', () => {
    // Hand-typed coordinates are wrong in a way nobody notices: a Jind salon
    // was stored at 12.83, 12.32 — a point in Chad — and the only symptom was
    // that it sorted last for every customer, forever.
    const apply = read('src/http/public/views/apply.js');
    assert.doesNotMatch(apply, /label: 'Latitude'/);
    assert.doesNotMatch(apply, /label: 'Longitude'/);

    const admin = read('src/http/public/admin.js');
    assert.doesNotMatch(admin, /Latitude \*/, 'coordinates must not be a required admin field');
  });

  it('both onboarding paths go through the same resolver', () => {
    // Two copies of "where is this salon" is how one path ends up geocoding
    // and the other keeps trusting a typed number.
    const repo = read('src/admin/repo.ts');
    const calls = repo.match(/await resolveCoords\(input\)/g) ?? [];
    assert.equal(calls.length, 2, 'onboardSalon and applyForSalon must both resolve coordinates');
  });
});
