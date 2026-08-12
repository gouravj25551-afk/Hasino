/**
 * Turning coordinates into a place name, and a typed place name into
 * coordinates.
 *
 * Proxied through our own server rather than called from the browser, for
 * three reasons that all matter:
 *
 *  - The CSP is `connect-src 'self'` plus the payment and auth hosts. Calling
 *    a geocoder directly would mean widening it for every visitor, on every
 *    page, to a host we do not control.
 *  - Nominatim's usage policy requires a descriptive User-Agent identifying
 *    the application. A browser cannot set one; a server can.
 *  - One in-memory cache here serves every customer. Reverse geocoding the
 *    same neighbourhood a hundred times is a hundred requests from the
 *    browser and one from here.
 *
 * The provider is behind GEOCODER_URL so this can become Google, Mapbox or a
 * self-hosted Nominatim without touching the client. Nothing here is on the
 * booking path: every failure returns null and the caller falls back to
 * letting the customer type a city.
 */
import { log } from '../obs/logger.ts';

export interface Place {
  lat: number;
  lng: number;
  /** The city or town. What the header shows when there is nothing finer. */
  city: string | null;
  /** Neighbourhood or suburb, when the provider knows one. */
  area: string | null;
  pincode: string | null;
  /** What to show: "Indiranagar, Bengaluru" or just "Sonipat". */
  label: string;
}

const BASE = process.env['GEOCODER_URL'] ?? 'https://nominatim.openstreetmap.org';

/**
 * Nominatim asks for an identifying User-Agent and refuses anonymous traffic.
 * CONTACT_EMAIL is optional but is what they ask for to reach an operator
 * whose deployment is misbehaving.
 */
const CONTACT = process.env['GEOCODER_CONTACT'] ?? process.env['ADMIN_EMAILS']?.split(',')[0]?.trim() ?? '';
const USER_AGENT = `Hasino/0.1 (salon booking marketplace${CONTACT ? `; ${CONTACT}` : ''})`;

/**
 * Coordinates round to ~1km before they become a cache key.
 *
 * Two customers on the same street should not be two upstream requests, and
 * the answer we want — the name of the locality — does not change over a few
 * hundred metres. Three decimals is about 110m.
 */
const cache = new Map<string, { at: number; value: Place[] }>();
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

function cached(key: string): Place[] | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function remember(key: string, value: Place[]): void {
  // Oldest-out rather than a real LRU: this is a courtesy cache in front of a
  // free service, not a hot path worth the bookkeeping.
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

interface NominatimAddress {
  city?: string; town?: string; village?: string; municipality?: string;
  state_district?: string; county?: string; state?: string;
  suburb?: string; neighbourhood?: string; city_district?: string;
  postcode?: string;
}

interface NominatimPlace {
  lat: string;
  lon: string;
  display_name?: string;
  address?: NominatimAddress;
}

/**
 * The name a person would use for where they are.
 *
 * Providers disagree about which field holds "the city" — a village in Haryana
 * arrives as `village`, a Bengaluru address as `city`, and somewhere in
 * between as `municipality`. Taking the first that exists is more reliable
 * than trusting any single key.
 */
function toPlace(raw: NominatimPlace): Place | null {
  const lat = Number(raw.lat);
  const lng = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const a = raw.address ?? {};
  const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.state_district ?? a.county ?? null;
  const area = a.suburb ?? a.neighbourhood ?? a.city_district ?? null;
  const label = [area, city ?? a.state].filter(Boolean).join(', ')
    || raw.display_name?.split(',').slice(0, 2).join(',').trim()
    || 'Unknown place';

  return { lat, lng, city, area, pincode: a.postcode ?? null, label };
}

async function call(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries({ format: 'jsonv2', addressdetails: '1', ...params })) {
    url.searchParams.set(k, v);
  }
  // A geocode is a nicety. It must never hold a request open long enough to
  // be mistaken for the app being down.
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`geocoder responded ${res.status}`);
  return res.json();
}

/** Coordinates -> the place they are in, or null when the provider cannot say. */
export async function reverseGeocode(lat: number, lng: number): Promise<Place | null> {
  const key = `r:${lat.toFixed(3)},${lng.toFixed(3)}`;
  const hit = cached(key);
  if (hit) return hit[0] ?? null;

  try {
    // zoom 12 is the level that answers "what city am I in". At 13 and above
    // the same coordinates in Sonipat come back as the village Garhi
    // Brahmnan, which is more precise and less useful as a header label.
    const raw = await call('/reverse', { lat: String(lat), lon: String(lng), zoom: '12' });
    const place = toPlace(raw as NominatimPlace);
    // The caller asked about a specific point; keep their coordinates rather
    // than the provider's centroid for the locality.
    const exact = place ? { ...place, lat, lng } : null;
    remember(key, exact ? [exact] : []);
    return exact;
  } catch (err) {
    log.warn('reverse geocode failed', { message: (err as Error).message });
    return null;
  }
}

/** A typed city, area or pincode -> candidate places, best first. */
export async function searchPlaces(query: string, limit = 6): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const key = `s:${q.toLowerCase()}`;
  const hit = cached(key);
  if (hit) return hit;

  try {
    const raw = await call('/search', {
      q,
      limit: String(limit),
      // The pilot is in India, and an unqualified "Panipat" should not offer
      // somewhere on another continent first.
      countrycodes: process.env['GEOCODER_COUNTRIES'] ?? 'in',
    });
    const places = (Array.isArray(raw) ? raw : [])
      .map((r) => toPlace(r as NominatimPlace))
      .filter((p): p is Place => p !== null);

    // "Sonipat" matches the city, the district and the tehsil, which arrive as
    // three rows with the same label. A list offering the same answer three
    // times looks broken; keep the first of each.
    const seen = new Set<string>();
    const unique = places.filter((p) => {
      const k = `${p.label.toLowerCase()}|${p.pincode ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    remember(key, unique);
    return unique;
  } catch (err) {
    log.warn('place search failed', { message: (err as Error).message });
    return [];
  }
}

/**
 * A postal address -> the point it sits at.
 *
 * This exists because coordinates used to be typed by hand on the onboarding
 * forms, and hand-typed coordinates are wrong in a way nobody notices: a salon
 * in Jind was stored at 12.83, 12.32 — a point in Chad — and the only symptom
 * was that it sorted last for every customer. An address the operator can read
 * back is checkable; two decimal numbers are not.
 *
 * Structured rather than one string: Nominatim matches a `city` field far more
 * reliably than the same word buried in free text, and a street it does not
 * recognise then still resolves to the right town instead of nothing.
 */
export async function geocodeAddress(parts: {
  address?: string | null;
  area?: string | null;
  city: string;
  postalcode?: string | null;
}): Promise<Place | null> {
  const city = parts.city.trim();
  if (!city) return null;

  const key = `a:${[parts.address, parts.area, city, parts.postalcode].filter(Boolean).join('|').toLowerCase()}`;
  const hit = cached(key);
  if (hit) return hit[0] ?? null;

  // Most specific first. A wrong street name should cost precision, not the
  // whole lookup — landing on the right city beats refusing to onboard.
  const attempts: Record<string, string>[] = [
    { street: [parts.address, parts.area].filter(Boolean).join(', '), city, ...(parts.postalcode ? { postalcode: parts.postalcode } : {}) },
    { city, ...(parts.postalcode ? { postalcode: parts.postalcode } : {}) },
  ];

  for (const params of attempts) {
    if (!params['street'] && Object.keys(params).length === 1 && !params['city']) continue;
    try {
      const raw = await call('/search', {
        ...params,
        limit: '1',
        countrycodes: process.env['GEOCODER_COUNTRIES'] ?? 'in',
      });
      const first = Array.isArray(raw) ? raw[0] : null;
      const place = first ? toPlace(first as NominatimPlace) : null;
      if (place) {
        remember(key, [place]);
        return place;
      }
    } catch (err) {
      log.warn('address geocode failed', { message: (err as Error).message });
      return null;
    }
  }

  remember(key, []);
  return null;
}
