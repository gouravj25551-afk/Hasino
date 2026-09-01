import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { SearchBar } from '../components/SearchBar.js';
import { SalonCard } from '../components/SalonCard.js';
import { EmptyState, NoSalonsState } from '../components/EmptyState.js';
import { SkeletonList } from '../components/Skeleton.js';
import { getCity, locationParams } from '../lib/location.js';
import { loadFavorites } from '../lib/favorites.js';

// Text chips, no per-category pictographs. A row of emoji faces was the
// loudest "assembled quickly" tell on the home screen, and the mature version
// of a filter strip — the one Zomato and Airbnb actually ship — is set in type:
// the label carries the meaning and the filled state carries the selection.
const CATEGORIES = [
  { id: '', name: 'All' },
  { id: 'hair', name: 'Haircut' },
  { id: 'beard', name: 'Beard' },
  { id: 'color', name: 'Color' },
  { id: 'facial', name: 'Facial' },
  { id: 'styling', name: 'Styling' },
  { id: 'grooming', name: 'Grooming' },
];

export async function renderHome(container, app) {
  container.innerHTML = '';
  let activeCategory = '';
  // The location the customer chose in the header, not a permission prompt
  // fired at whoever opens the home page. Asking unprompted on every load is
  // what the selector exists to replace, and a refusal there used to leave no
  // way to say where you are.
  const params = locationParams();
  const hasLocation = params.lat !== undefined;
  // The city the whole list is filtered to, server-side. Read here rather
  // than per-draw because the view is re-rendered from scratch when the
  // location changes — see the sheet's onPick in app.js — so this is always
  // the city the results on screen belong to.
  const city = getCity();

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
    chip.append(el('span', null, cat.name));
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
  // Naming the city in the header is what makes an empty list legible: the
  // customer can see the list is scoped before they wonder why it is short.
  salonsHeader.append(el('h2', null,
    city ? `Salons & barbers in ${city}` : hasLocation ? 'Nearby salons & barbers' : 'Salons & barbers'));
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
            // Carries `city`: the server returns this city's salons and no
            // others, so nothing has to be filtered out again here.
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
      // The saved list before the hearts are drawn, so a saved salon is red on
      // the first paint rather than filling in a moment later. It is fetched
      // once per session and cached in lib/favorites.js, not per card.
      try {
        await loadFavorites({ signedIn: Boolean(app.session) });
      } catch {
        // saving is not what this screen is for; an unreachable list leaves
        // every heart an outline rather than taking the salons down with it.
      }
      for (const s of salons) {
        grid.append(SalonCard(s, {
          onOpen: (id) => app.navigate(`#/salon/${id}`),
          savable: true,
          signedIn: Boolean(app.session),
          onRequireSignIn: () => app.signIn(),
        }));
      }
    } catch (err) {
      grid.innerHTML = '';
      grid.append(EmptyState({ title: err.message || 'Could not load salons', action: 'Retry', onAction: () => draw(q) }));
    }
  }

  await draw('');
}
