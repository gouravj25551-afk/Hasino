import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { SearchBar } from '../components/SearchBar.js';
import { SalonCard } from '../components/SalonCard.js';
import { EmptyState, NoSalonsState } from '../components/EmptyState.js';
import { SkeletonList } from '../components/Skeleton.js';
import { getCity, locationParams } from '../lib/location.js';
import { loadFavorites } from '../lib/favorites.js';
import { Button } from '../components/Button.js';

// Brand hero photography. A barbershop interior, not a listed salon — see the
// note at the hero for why that distinction matters and how it degrades if the
// image fails. Sized and quality-capped in the URL so the hero does not pull a
// full-resolution original. Swap for owned/CDN photography before launch.
const HERO_IMAGE =
  'https://images.unsplash.com/photo-1585747860715-2ba37e788b70?w=1200&q=70&auto=format&fit=crop';

// Promotional creative photography. Same rules as HERO_IMAGE: brand creative
// (a scene, never posed as a specific listed salon), gradient/overlay fallback,
// swapped for owned photography before launch.
const AD_IMAGE =
  'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=1400&q=70&auto=format&fit=crop';
const PROMO_IMAGE =
  'https://images.unsplash.com/photo-1622286342621-4bd786c2447c?w=1000&q=70&auto=format&fit=crop';

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

  // Editorial split hero: the value line and the search on the left, a single
  // strong grooming photograph on the right. The photo is brand creative — a
  // barbershop, not any specific listed salon — so it never poses as data the
  // way §18 warns against. It sits on a brand gradient and hides itself on a
  // load error (onerror below), so a blocked or slow image degrades to a clean
  // coloured panel rather than a broken box. Replace HERO_IMAGE with owned
  // photography before launch; it is the one hotlinked asset on the page.
  const hero = el('section', 'hero');

  const heroCopy = el('div', 'hero-copy');
  heroCopy.append(el('h1', null, 'Find a barber worth going back to.'));
  heroCopy.append(el('p', null,
    'Discover top-rated barbers and salons near you, see live availability, and book your chair in seconds.'));
  const search = SearchBar({ placeholder: 'Search salons, barbers or a service', onSearch: (q) => draw(q) });
  heroCopy.append(search);

  // Real categories, surfaced as one-tap entry points. Selecting one drives the
  // same filter the strip below does and drops the customer at the results.
  const cues = el('div', 'hero-cues');
  cues.append(el('span', 'hero-cues-label', 'Popular'));
  for (const cue of [{ id: 'hair', name: 'Haircut' }, { id: 'beard', name: 'Beard' }, { id: 'facial', name: 'Facial' }]) {
    const b = el('button', 'hero-cue', cue.name);
    b.type = 'button';
    b.onclick = () => { selectCategory(cue.id); salonsHeader.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    cues.append(b);
  }
  heroCopy.append(cues);

  const heroMedia = el('div', 'hero-media');
  const heroImg = el('img', 'hero-img');
  heroImg.src = HERO_IMAGE;
  heroImg.alt = '';
  heroImg.setAttribute('role', 'presentation');
  heroImg.loading = 'eager';
  heroImg.decoding = 'async';
  heroImg.onerror = () => heroMedia.classList.add('hero-media-fallback');
  heroMedia.append(heroImg);

  hero.append(heroCopy, heroMedia);
  container.append(hero);

  const catHeader = el('div', 'categories-header');
  catHeader.append(el('h2', null, 'Explore categories'));
  container.append(catHeader);

  const catStrip = el('div', 'category-strip');
  for (const cat of CATEGORIES) {
    const chip = el('div', 'category-card' + (activeCategory === cat.id ? ' active' : ''));
    chip.append(el('span', null, cat.name));
    chip.dataset.category = cat.id;
    chip.onclick = () => selectCategory(cat.id);
    catStrip.append(chip);
  }
  container.append(catStrip);

  // One place that owns "a category is now selected", so the hero cues and the
  // strip below can never disagree about which filter is live.
  function selectCategory(id) {
    activeCategory = id;
    for (const c of catStrip.children) c.classList.toggle('active', c.dataset.category === id);
    draw(search.input.value.trim());
  }

  const salonsHeader = el('div', 'categories-header');
  // Naming the city in the header is what makes an empty list legible: the
  // customer can see the list is scoped before they wonder why it is short.
  salonsHeader.append(el('h2', null,
    city ? `Salons & barbers in ${city}` : hasLocation ? 'Nearby salons & barbers' : 'Salons & barbers'));
  container.append(salonsHeader);

  const grid = el('div', 'grid cards');
  container.append(grid);
  grid.append(SkeletonList(3));

  // ---- promotional creatives below the results ----
  // Advertisement-style bands, appended after the grid (which fills in above
  // them asynchronously). The copy is deliberately generic — a campaign line,
  // not a factual claim — so nothing here invents a discount, a rating or a
  // number the product cannot stand behind.

  // A full-width campaign banner: one photograph, a headline overlaid on a
  // scrim, one action. The scrim is what keeps white text readable and doubles
  // as the fallback if the image never loads.
  const ad = el('section', 'adband');
  const adImg = el('img', 'adband-img');
  adImg.src = AD_IMAGE;
  adImg.alt = '';
  adImg.setAttribute('role', 'presentation');
  adImg.loading = 'lazy';
  adImg.decoding = 'async';
  adImg.onerror = () => ad.classList.add('adband-fallback');
  const adInner = el('div', 'adband-inner');
  adInner.append(el('p', 'adband-eyebrow', 'Grooming, sorted'));
  adInner.append(el('h2', null, 'Fresh look. Better booking.'));
  adInner.append(el('p', 'adband-sub', 'Discover barbers worth booking and reserve a time that works for you.'));
  adInner.append(Button({
    label: 'Explore barbers',
    variant: 'primary',
    onClick: () => app.navigate('#/explore'),
  }));
  ad.append(adImg, adInner);
  container.append(ad);

  const promo = el('section', 'promo');
  const promoMedia = el('div', 'promo-media');
  const promoImg = el('img', 'promo-img');
  promoImg.src = PROMO_IMAGE;
  promoImg.alt = '';
  promoImg.setAttribute('role', 'presentation');
  promoImg.loading = 'lazy';
  promoImg.decoding = 'async';
  promoImg.onerror = () => promoMedia.classList.add('promo-media-fallback');
  promoMedia.append(promoImg);
  const promoCopy = el('div', 'promo-copy');
  promoCopy.append(el('h2', null, 'Your chair is waiting.'));
  promoCopy.append(el('p', null,
    'From a quick fade to a full grooming session, find a barber you trust and book a time that works for you.'));
  promoCopy.append(Button({
    label: 'Find a barber',
    variant: 'primary',
    onClick: () => { window.scrollTo({ top: 0, behavior: 'smooth' }); search.input.focus(); },
  }));
  promo.append(promoMedia, promoCopy);
  container.append(promo);

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
