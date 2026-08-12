import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { SearchBar } from '../components/SearchBar.js';
import { SalonCard } from '../components/SalonCard.js';
import { EmptyState } from '../components/EmptyState.js';
import { SkeletonList } from '../components/Skeleton.js';
import { locationParams } from '../lib/location.js';

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

  container.append(el('h1', null, 'Explore'));
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
          // Sorts by distance from the chosen location when there is one.
          ...locationParams(),
        }),
      );
      grid.innerHTML = '';
      if (!salons.length) {
        grid.append(EmptyState({ title: 'Nothing matches that search.' }));
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
