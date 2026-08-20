/**
 * The customer's chosen location.
 *
 * Kept in localStorage, not the database. It is a browsing preference, not
 * account data: it belongs to this device, it should survive a reload, and it
 * has to work before anyone signs in — the first thing a visitor does is look
 * for salons near them, and that must not require an account.
 *
 * Stored whole rather than as a display string. `lat`/`lng` are what
 * /api/salons sorts by; the rest is what the header shows and what a future
 * "salons in your area" query would filter on. Keeping only the label would
 * mean geocoding the same city again on every page load.
 */

const KEY = 'hasino.location';

/** @typedef {{lat:number, lng:number, city:string|null, area:string|null, pincode:string|null, label:string, source:'CURRENT_LOCATION'|'MANUAL'}} SelectedLocation */

/** The stored location, or null when the customer has not chosen one yet. */
export function getLocation() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    // A hand-edited or half-written value must not break the header on boot.
    if (typeof v?.lat !== 'number' || typeof v?.lng !== 'number' || typeof v?.label !== 'string') {
      localStorage.removeItem(KEY);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

/** @param {SelectedLocation} loc */
export function setLocation(loc) {
  try {
    localStorage.setItem(KEY, JSON.stringify(loc));
  } catch {
    // Private browsing, or a full quota. The choice is still returned to the
    // caller and used for this page — it simply will not survive a reload.
  }
  return loc;
}

export function clearLocation() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}

/**
 * The city salon discovery filters by, or null when there isn't one.
 *
 * There is one stored location, whichever way it was chosen, so "the city the
 * customer selected" and "the city we detected for them" are never both in
 * play — picking a city in the sheet replaces a detected one and vice versa,
 * and this returns whichever is current. That is what keeps a manual choice
 * from being quietly overridden by GPS: the last explicit act wins because it
 * is the only thing stored.
 *
 * Null in two cases, and the caller must tell them apart: no location chosen
 * at all, or a location whose city the geocoder could not name (a GPS fix
 * that reverse-geocoded to nothing). `getLocation()` distinguishes them.
 */
export function getCity() {
  const city = getLocation()?.city;
  return typeof city === 'string' && city.trim() !== '' ? city.trim() : null;
}

/**
 * What to hand /api/salons, or `{}` when no location is chosen.
 *
 * Callers spread this into a query string, so it is `{}` rather than nulls —
 * an absent lat is different from a lat of zero, which is a real place in the
 * Gulf of Guinea.
 *
 * `city` is the discovery filter and `lat`/`lng` only order what survives it.
 * Both are sent because they answer different questions: which salons a
 * customer in Jind can book, and which of those is nearest. The server does
 * the filtering — this parameter is how it is told the city, not where the
 * rule lives.
 */
export function locationParams() {
  const loc = getLocation();
  if (!loc) return {};
  const city = getCity();
  return { lat: String(loc.lat), lng: String(loc.lng), ...(city ? { city } : {}) };
}

/**
 * Ask the browser where we are.
 *
 * Every failure mode gets its own message, because "location unavailable"
 * covers four completely different situations and only one of them is worth
 * retrying. The codes are the W3C ones; `code` is checked rather than the
 * message, which is browser-specific prose.
 */
export function currentPosition({ timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      return reject(Object.assign(
        new Error('This browser cannot share your location. Search for your city instead.'),
        { code: 'UNSUPPORTED' },
      ));
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => {
        const map = {
          1: ['PERMISSION_DENIED', 'Location permission was blocked. You can allow it in your browser settings, or search for your city.'],
          2: ['UNAVAILABLE', 'Your location could not be determined right now. Try searching for your city.'],
          3: ['TIMEOUT', 'Finding your location took too long. Try again, or search for your city.'],
        };
        const [code, message] = map[err.code] ?? ['UNKNOWN', 'Could not get your location. Try searching for your city.'];
        reject(Object.assign(new Error(message), { code }));
      },
      // No high accuracy: a city name does not need GPS, and asking for it
      // costs seconds and battery for a worse chance of an answer indoors.
      { timeout, maximumAge: 5 * 60 * 1000, enableHighAccuracy: false },
    );
  });
}

/** Coordinates -> a place, via our own server. Null when it cannot be named. */
export async function reverseGeocode(lat, lng) {
  const res = await fetch(`/api/geo/reverse?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`);
  if (!res.ok) return null;
  const { place } = await res.json();
  return place ?? null;
}

/** A typed city, area or pincode -> candidate places. */
export async function searchPlaces(query) {
  const res = await fetch(`/api/geo/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) return [];
  const { places } = await res.json();
  return places ?? [];
}
