import { el } from '../lib/dom.js';

export function Button({ label, variant = '', size = '', onClick, disabled = false, type = 'button' } = {}) {
  const btn = el('button', ['btn', variant, size].filter(Boolean).join(' '), label);
  btn.type = type;
  btn.disabled = disabled;
  if (onClick) btn.onclick = onClick;
  return btn;
}
