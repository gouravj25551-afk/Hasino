import { el } from '../lib/dom.js';
import { distance, rupees } from '../lib/format.js';
import { Rating } from './Rating.js';

/**
 * `salon` is a SalonSummary from GET /api/salons. `onOpen(id)` navigates;
 * `onToggleFavorite(id)` is omitted entirely when favoriting isn't wired up
 * for this list (no fake heart icon dangling with no effect).
 */
export function SalonCard(salon, { onOpen, onToggleFavorite, isFavorite = false } = {}) {
  const card = el('div', 'salon-card');
  card.onclick = () => onOpen?.(salon.id);

  const hasImage = Boolean(salon.coverImage);
  const imgWrap = el('div', 'salon-card-img-wrap' + (hasImage ? '' : ' aspect placeholder'));
  if (hasImage) {
    const img = el('img', 'salon-card-img');
    img.src = salon.coverImage;
    img.alt = salon.name;
    img.loading = 'lazy';
    imgWrap.append(img);
  } else {
    imgWrap.append(document.createTextNode(salon.name.slice(0, 1).toUpperCase()));
  }
  imgWrap.append(
    el('div', 'salon-badge-top', salon.openNow ? (salon.closesAt ? `Open · till ${salon.closesAt}` : 'Open') : 'Closed'),
  );
  card.append(imgWrap);

  const body = el('div', 'salon-card-body');

  const titleRow = el('div', 'salon-card-title-row');
  titleRow.append(el('h3', 'salon-card-title', salon.name));
  titleRow.append(Rating({ value: salon.rating, reviewCount: salon.reviewCount }));
  body.append(titleRow);

  const addrBits = [distance(salon.distanceKm), salon.address].filter(Boolean).join(' · ');
  body.append(el('div', 'salon-card-address', addrBits));

  const footer = el('div', 'salon-card-footer');
  const price = el('div', 'salon-card-price');
  price.innerHTML = salon.fromPrice != null ? `From <strong>${rupees(salon.fromPrice)}</strong>` : 'See services';
  footer.append(price);

  if (onToggleFavorite) {
    const favBtn = el('button', 'btn sm' + (isFavorite ? ' primary' : ''), isFavorite ? '♥ Saved' : '♡ Save');
    favBtn.onclick = (e) => {
      e.stopPropagation();
      onToggleFavorite(salon.id);
    };
    footer.append(favBtn);
  }
  body.append(footer);

  card.append(body);
  return card;
}
