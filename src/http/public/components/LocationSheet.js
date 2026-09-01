import { el } from '../lib/dom.js';
import { BottomSheet } from './BottomSheet.js';
import { currentPosition, reverseGeocode, searchPlaces, setLocation } from '../lib/location.js';
import { iconEl } from '../lib/icons.js';

/**
 * "Choose your location" — the sheet behind the header chip.
 *
 * Two ways in, because neither works for everyone: geolocation is one tap but
 * needs a permission the customer may have already refused, and typing always
 * works but is slower. The failure of one never hides the other — a denied
 * permission leaves the search box sitting right there.
 *
 * onPick is called with the chosen location after it is stored, so the caller
 * re-renders the header and whatever list is on screen.
 */
export function LocationSheet({ onPick } = {}) {
  const wrap = el('div');
  wrap.style.padding = '4px 4px 12px';

  wrap.append(el('h2', null, 'Choose your location'));

  const status = el('div', 'note');
  status.style.display = 'none';

  const choose = (place, source) => {
    const stored = setLocation({
      lat: place.lat,
      lng: place.lng,
      city: place.city ?? null,
      area: place.area ?? null,
      pincode: place.pincode ?? null,
      label: place.label,
      source,
    });
    close();
    onPick?.(stored);
  };

  // ---- use my current location ----
  const useMine = el('button', 'btn primary');
  useMine.type = 'button';
  useMine.style.cssText = 'width:100%; display:flex; align-items:center; justify-content:center; gap:8px;';
  const setUseMine = (text, withIcon = true) => {
    useMine.textContent = '';
    if (withIcon) useMine.append(iconEl('pin', { size: 17 }));
    useMine.append(document.createTextNode(text));
  };
  setUseMine('Use my current location');
  useMine.onclick = async () => {
    useMine.disabled = true;
    setUseMine('Finding you…', false);
    status.style.display = 'none';
    try {
      const { lat, lng } = await currentPosition();
      const place = await reverseGeocode(lat, lng);
      // The coordinates are the useful part; a name we could not look up only
      // costs a nicer label, so the selection still stands.
      choose(place ?? { lat, lng, city: null, area: null, pincode: null, label: 'Near you' }, 'CURRENT_LOCATION');
    } catch (err) {
      status.style.display = 'block';
      status.textContent = err.message;
      useMine.disabled = false;
      setUseMine('Use my current location');
      search.focus();
    }
  };
  wrap.append(useMine, status);

  const or = el('div', 'note', '─────  or  ─────');
  or.style.cssText = 'text-align:center; margin:14px 0 10px';
  wrap.append(or);

  // ---- search ----
  const searchField = el('div', 'input-icon');
  searchField.append(iconEl('search', { size: 18 }));
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Search city, area or pincode';
  searchField.append(search);
  wrap.append(searchField);

  const results = el('div', 'list');
  results.style.marginTop = '10px';
  wrap.append(results);

  // Typing is not a search. Waiting for a pause keeps one request per word
  // rather than one per keystroke, which matters against a shared free
  // geocoder more than it matters for our own server.
  let timer;
  let sequence = 0;
  search.oninput = () => {
    clearTimeout(timer);
    const q = search.value.trim();
    if (q.length < 2) {
      results.innerHTML = '';
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++sequence;
      results.innerHTML = '';
      results.append(el('div', 'note', 'Searching…'));
      const places = await searchPlaces(q);
      // A slow earlier request must not overwrite a newer answer.
      if (mine !== sequence) return;
      results.innerHTML = '';
      if (!places.length) {
        results.append(el('div', 'note', `Nothing found for “${q}”. Try a city name or pincode.`));
        return;
      }
      for (const place of places) {
        const row = el('div', 'item');
        row.style.cursor = 'pointer';
        row.append(el('div', 'grow', place.label));
        if (place.pincode) row.append(el('span', 'meta', place.pincode));
        row.onclick = () => choose(place, 'MANUAL');
        results.append(row);
      }
    }, 300);
  };

  const close = BottomSheet(wrap);
  // Autofocus is deliberately not set: on a phone it opens the keyboard over
  // the "use my current location" button, which is the option most people
  // want.
  return close;
}
