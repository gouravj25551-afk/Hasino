import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { SearchBar } from '../components/SearchBar.js';
import { SalonCard } from '../components/SalonCard.js';
import { EmptyState, NoSalonsState } from '../components/EmptyState.js';
import { SkeletonList } from '../components/Skeleton.js';
import { getCity, locationParams } from '../lib/location.js';

const CATEGORIES = [
  { id: '', name: 'All' },
  { id: 'hair', name: 'Haircut' },
  { id: 'beard', name: 'Beard' },
  { id: 'color', name: 'Color' },
  { id: 'facial', name: 'Facial' },
  { id: 'styling', name: 'Styling' },
  { id: 'grooming', name: 'Grooming' },
];

export async function renderExplore(container, app) {
  container.innerHTML = '';
  let activeCategory = '';

  // Same scope as home: the server filters to the customer's current city,
  // and the heading says so rather than leaving a short list unexplained.
  const city = getCity();
  const params = locationParams();

  container.append(el('h1', null, city ? `Explore ${city}` : 'Explore'));
  const search = SearchBar({ placeholder: 'Salon name, service or area…', onSearch: (q) => draw(q) });
  search.style.marginBottom = 'var(--space-4)';
  container.append(search);

  const catStrip = el('div', 'category-strip');
  for (const cat of CATEGORIES) {
    const chip = el('div', 'category-card' + (activeCategory === cat.id ? ' active' : ''), cat.name);
    chip.onclick = () => {
      activeCategory = cat.id;
      for (const c of catStrip.children) c.classList.remove('active');
      chip.classList.add('active');
      draw(search.input.value.trim());
    };
    catStrip.append(chip);
  }
  container.append(catStrip);

  const grid = el('div', 'grid cards');
  container.append(grid);
  grid.append(SkeletonList(4));

  async function draw(q) {
    grid.innerHTML = '';
    grid.append(SkeletonList(4));
    try {
      const { salons } = await api(
        '/api/salons?' + new URLSearchParams({
          ...(q ? { q } : {}),
          ...(activeCategory ? { category: activeCategory } : {}),
          // `city` scopes the results and lat/lng order what is left of them.
          ...params,
        }),
      );
      grid.innerHTML = '';
      if (!salons.length) {
        grid.append(NoSalonsState({
          city,
          filtered: Boolean(q) || Boolean(activeCategory),
          onClear: () => {
            search.input.value = '';
            activeCategory = '';
            for (const c of catStrip.children) c.classList.remove('active');
            catStrip.firstElementChild?.classList.add('active');
            draw('');
          },
        }));
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
