import { el } from '../lib/dom.js';
import { distance, rupees } from '../lib/format.js';
import { Rating } from './Rating.js';

/**
 * `salon` is a SalonSummary from GET /api/salons. `onOpen(id)` navigates;
 * `onToggleFavorite(id)` is omitted entirely when favoriting isn't wired up
 * for this list (no fake heart icon dangling with no effect).
 *
 * The card is the most repeated element in the product, so it carries the
 * design system rather than its own styling: the open/closed state is a status
 * pill with a dot (colour alone is not something to rely on), the price and
 * the call to action share a footer, and the whole card is one target.
 *
 * That target is reachable from a keyboard. It was a bare <div onclick>, which
 * meant the entire discovery experience — the only way into a salon — could
 * not be operated without a mouse.
 */
export function SalonCard(salon, { onOpen, onToggleFavorite, isFavorite = false } = {}) {
  const card = el('div', 'salon-card');
  const open = () => onOpen?.(salon.id);
  card.onclick = open;

  if (onOpen) {
    card.tabIndex = 0;
    card.setAttribute('role', 'link');
    card.setAttribute('aria-label', `${salon.name}, ${salon.openNow ? 'open now' : 'closed'}`);
    card.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();   // space would otherwise scroll the page
      open();
    };
  }

  const hasImage = Boolean(salon.coverImage);
  const imgWrap = el('div', 'salon-card-img-wrap' + (hasImage ? '' : ' aspect placeholder'));
  if (hasImage) {
    const img = el('img', 'salon-card-img');
    img.src = salon.coverImage;
    img.alt = '';            // decorative: the name is already the label
    img.loading = 'lazy';
    imgWrap.append(img);
  } else {
    imgWrap.append(document.createTextNode(salon.name.slice(0, 1).toUpperCase()));
  }

  // Open/closed as a status pill rather than a plain dark chip, so it reads at
  // a glance in a grid and carries a shape as well as a colour.
  const status = el(
    'span',
    'pill dot ' + (salon.openNow ? 'ok' : 'bad'),
    salon.openNow ? (salon.closesAt ? `Open till ${salon.closesAt}` : 'Open now') : 'Closed',
  );
  const badgeSlot = el('div', 'salon-badge-top');
  badgeSlot.append(status);
  imgWrap.append(badgeSlot);
  card.append(imgWrap);

  const body = el('div', 'salon-card-body');

  const titleRow = el('div', 'salon-card-title-row');
  titleRow.append(el('h3', 'salon-card-title', salon.name));
  titleRow.append(Rating({ value: salon.rating, reviewCount: salon.reviewCount }));
  body.append(titleRow);

  const addrBits = [distance(salon.distanceKm), salon.address].filter(Boolean).join(' · ');
  if (addrBits) body.append(el('div', 'salon-card-address', addrBits));

  const footer = el('div', 'salon-card-footer');
  const price = el('div', 'salon-card-price');
  if (salon.fromPrice != null) {
    price.append(document.createTextNode('From '));
    price.append(el('strong', null, rupees(salon.fromPrice)));
  } else {
    price.append(document.createTextNode('See services'));
  }
  footer.append(price);

  if (onToggleFavorite) {
    const favBtn = el('button', 'btn sm' + (isFavorite ? ' secondary' : ' ghost'), isFavorite ? '♥ Saved' : '♡ Save');
    favBtn.setAttribute('aria-pressed', String(!!isFavorite));
    favBtn.onclick = (e) => {
      e.stopPropagation();   // the card underneath is a link
      onToggleFavorite(salon.id);
    };
    footer.append(favBtn);
  } else {
    footer.append(el('span', 'salon-card-cta', 'Book →'));
  }
  body.append(footer);

  card.append(body);
  return card;
}
