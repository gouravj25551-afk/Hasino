import { el } from '../lib/dom.js';
import { distance, rupees } from '../lib/format.js';
import { Rating } from './Rating.js';
import { HeartButton } from './HeartButton.js';

/**
 * `salon` is a SalonSummary from GET /api/salons. `onOpen(id)` navigates.
 *
 * The heart sits on the photo rather than in the footer, and it is the same
 * HeartButton the salon's own page uses over the same lib/favorites.js — so a
 * salon saved from a card is saved on its page, and the other way round,
 * without this component knowing anything about the endpoints. It stops its
 * own events, so saving never opens the salon by accident.
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
export function SalonCard(salon, { onOpen, savable = false, signedIn = false, onRequireSignIn } = {}) {
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

  if (savable) {
    const heartSlot = el('div', 'salon-card-heart');
    heartSlot.append(HeartButton(salon.id, { signedIn, label: salon.name, onRequireSignIn }));
    imgWrap.append(heartSlot);
  }
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

  footer.append(el('span', 'salon-card-cta', 'Book →'));
  body.append(footer);

  card.append(body);
  return card;
}
