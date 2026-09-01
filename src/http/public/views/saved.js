import { el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { SalonCard } from '../components/SalonCard.js';
import { EmptyState } from '../components/EmptyState.js';
import { SkeletonList } from '../components/Skeleton.js';
import { loadFavorites, onFavoritesChanged } from '../lib/favorites.js';

/**
 * The customer's saved salons, newest save first.
 *
 * The order is the server's — GET /api/me/saved is listFavoriteSalons, which
 * returns the favorites table in created_at DESC. So a salon just hearted is at
 * the top the next time this screen is opened, without this view sorting
 * anything itself.
 *
 * Unsaving here removes the card in place rather than waiting for a reload:
 * every heart publishes through lib/favorites.js, so this view subscribes and
 * drops the card when its salon is unhearted anywhere — the same mechanism that
 * keeps a card's heart and the salon page's heart in agreement.
 */
export async function renderSaved(container, app) {
  if (!app.requireSession()) return;
  container.innerHTML = '';

  container.append(el('h1', null, 'Saved'));
  container.append(el('p', 'sub', 'Salons and barbers you’ve saved, most recent first.'));

  const grid = el('div', 'grid cards');
  container.append(grid);
  grid.append(SkeletonList(3));

  // Card element per salon id, so an unsave elsewhere can find and remove it.
  const cardById = new Map();

  const showEmpty = () => {
    grid.innerHTML = '';
    grid.classList.remove('cards');
    grid.append(EmptyState({
      icon: 'heart',
      title: 'Nothing saved yet',
      body: 'Tap the heart on any salon to keep it here for quick booking.',
      action: 'Discover salons',
      onAction: () => app.navigate('#/home'),
    }));
  };

  // Remove a card the moment its salon is unsaved from anywhere; if that empties
  // the grid, fall through to the empty state so the screen never sits blank.
  const stop = onFavoritesChanged((salonId, isSaved) => {
    if (isSaved) return;
    const card = cardById.get(salonId);
    if (!card) return;
    card.remove();
    cardById.delete(salonId);
    if (cardById.size === 0) showEmpty();
  });
  // The view is torn down on navigation; stop listening when it leaves the DOM.
  const observer = new MutationObserver(() => {
    if (!container.isConnected) { stop(); observer.disconnect(); }
  });
  if (container.parentNode) observer.observe(container.parentNode, { childList: true });

  try {
    // The heart list backs the optimistic paint on each card; load it first so
    // every card renders filled rather than filling in a beat later.
    await loadFavorites({ signedIn: true });
    const { salons } = await api('/api/me/saved');
    grid.innerHTML = '';
    if (!salons.length) { showEmpty(); return; }
    for (const s of salons) {
      const card = SalonCard(s, {
        onOpen: (id) => app.navigate(`#/salon/${id}`),
        savable: true,
        signedIn: true,
        onRequireSignIn: () => app.signIn(),
      });
      cardById.set(s.id, card);
      grid.append(card);
    }
  } catch (err) {
    grid.innerHTML = '';
    grid.classList.remove('cards');
    grid.append(EmptyState({
      title: 'Could not load your saved salons',
      body: err?.message || 'Please try again in a moment.',
      action: 'Retry',
      onAction: () => renderSaved(container, app),
    }));
  }
}
