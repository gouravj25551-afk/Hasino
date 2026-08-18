import { el } from '../lib/dom.js';

/**
 * An empty screen is where a product either explains itself or looks broken.
 *
 * The old version rendered one line of grey text in a dashed box, which reads
 * as "something failed" rather than "there is nothing here yet". This takes an
 * icon, a title, an optional sentence of context and the action that resolves
 * the emptiness.
 *
 * `title` alone still works — every existing caller passes exactly that and
 * keeps rendering, just better.
 */
export function EmptyState({ title, body, icon = '✨', action, onAction } = {}) {
  const box = el('div', 'empty-state');
  if (icon) box.append(el('div', 'empty-icon', icon));
  box.append(el('div', 'empty-title', title));
  if (body) box.append(el('div', 'empty-body', body));
  if (action && onAction) {
    const btn = el('button', 'btn primary', action);
    btn.onclick = onAction;
    box.append(btn);
  }
  return box;
}
