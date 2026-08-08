import { el } from '../lib/dom.js';

export function Avatar({ src, name, size = '' } = {}) {
  const cls = ['avatar', size].filter(Boolean).join(' ');
  if (src) {
    const img = el('img', cls);
    img.src = src;
    img.alt = name ? `${name}'s photo` : 'Profile photo';
    return img;
  }
  return el('div', cls, (name?.trim()?.[0] ?? 'U').toUpperCase());
}
