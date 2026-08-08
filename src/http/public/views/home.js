import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { SearchBar } from '../components/SearchBar.js';
import { SalonCard } from '../components/SalonCard.js';
import { EmptyState } from '../components/EmptyState.js';
import { SkeletonList } from '../components/Skeleton.js';

const CATEGORIES = [
  { id: '', name: 'All', icon: '✨' },
  { id: 'hair', name: 'Haircut', icon: '✂️' },
  { id: 'beard', name: 'Beard', icon: '🧔' },
  { id: 'color', name: 'Color', icon: '🎨' },
  { id: 'facial', name: 'Facial', icon: '💆' },
  { id: 'styling', name: 'Styling', icon: '💇' },
  { id: 'grooming', name: 'Grooming', icon: '🧼' },
];

function geolocate() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null), // declined or unavailable — browse without distance sort
      { timeout: 4000 },
    );
  });
}

export async function renderHome(container, app) {
  container.innerHTML = '';
  let activeCategory = '';
  const coords = await geolocate();

  const hero = el('div', 'hero-box');
  hero.append(el('h1', null, 'Find your next haircut & grooming'));
  hero.append(el('p', null, 'Book top rated salons, barbers & beauty professionals near you.'));
  const search = SearchBar({ onSearch: (q) => draw(q) });
  hero.append(search);
  container.append(hero);

  const catHeader = el('div', 'categories-header');
  catHeader.append(el('h2', null, 'Explore categories'));
  container.append(catHeader);

  const catStrip = el('div', 'category-strip');
  for (const cat of CATEGORIES) {
    const chip = el('div', 'category-card' + (activeCategory === cat.id ? ' active' : ''));
    chip.append(el('span', 'category-icon', cat.icon), el('span', null, cat.name));
    chip.onclick = () => {
      activeCategory = cat.id;
      for (const c of catStrip.children) c.classList.remove('active');
      chip.classList.add('active');
      draw(search.input.value.trim());
    };
    catStrip.append(chip);
  }
  container.append(catStrip);

  const salonsHeader = el('div', 'categories-header');
  salonsHeader.append(el('h2', null, coords ? 'Nearby salons & barbers' : 'Salons & barbers'));
  container.append(salonsHeader);

  const grid = el('div', 'grid cards');
  container.append(grid);
  grid.append(SkeletonList(3));

  async function draw(q) {
    grid.innerHTML = '';
    grid.append(SkeletonList(3));
    try {
      const { salons } = await api(
        '/api/salons?' +
          new URLSearchParams({
            ...(q ? { q } : {}),
            ...(activeCategory ? { category: activeCategory } : {}),
            ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
          }),
      );
      grid.innerHTML = '';
      if (!salons.length) {
        grid.append(EmptyState({ title: 'No salons found. Try a different search.' }));
        return;
      }
      for (const s of salons) grid.append(SalonCard(s, { onOpen: (id) => app.navigate(`#/salon/${id}`) }));
    } catch (err) {
      grid.innerHTML = '';
      grid.append(EmptyState({ title: err.message || 'Could not load salons', action: 'Retry', onAction: () => draw(q) }));
    }
  }

  await draw('');
}
