import { el } from '../lib/dom.js';

/**
 * `value` is null for a salon with no reviews yet — shown honestly as "New",
 * not a fabricated number.
 *
 * The two cases are visually distinct now. Both used to render in the same
 * green rating badge, so "New" read like a score: a salon nobody had reviewed
 * looked, at a glance in a grid, exactly like a well-rated one.
 */
export function Rating({ value, reviewCount } = {}) {
  if (value == null) return el('span', 'pill outline', 'New');

  const badge = el('span', 'salon-card-rating', `★ ${value.toFixed(1)}`);
  if (reviewCount) {
    badge.append(el('span', 'rating-count', `(${reviewCount})`));
    badge.title = `${reviewCount} review${reviewCount === 1 ? '' : 's'}`;
  }
  return badge;
}
