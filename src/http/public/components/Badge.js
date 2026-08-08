import { el } from '../lib/dom.js';

const TONES = new Set(['ok', 'warn', 'bad', 'brand']);

export function Badge({ text, tone } = {}) {
  const cls = ['pill', TONES.has(tone) ? tone : ''].filter(Boolean).join(' ');
  return el('span', cls, text);
}
