import { el } from '../lib/dom.js';

export function SkeletonCard() {
  return el('div', 'skeleton skeleton-card');
}

export function SkeletonLine(width = '100%') {
  const line = el('div', 'skeleton skeleton-line');
  line.style.width = width;
  return line;
}

export function SkeletonAvatar() {
  return el('div', 'skeleton skeleton-avatar');
}

/** `count` copies of `factory()` in a fragment, for list/grid loading states. */
export function SkeletonList(count = 3, factory = SkeletonCard) {
  const wrap = document.createDocumentFragment();
  for (let i = 0; i < count; i++) wrap.append(factory());
  return wrap;
}
