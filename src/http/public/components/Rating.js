import { el } from '../lib/dom.js';

/** `value` is null for a salon with no reviews yet — shown honestly as "New", not a fabricated number. */
export function Rating({ value, reviewCount } = {}) {
  const badge = el('span', 'salon-card-rating', value == null ? 'New' : `★ ${value.toFixed(1)}`);
  if (value != null && reviewCount) {
    badge.title = `${reviewCount} review${reviewCount === 1 ? '' : 's'}`;
  }
  return badge;
}
