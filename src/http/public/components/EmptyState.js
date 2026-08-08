import { el } from '../lib/dom.js';

export function EmptyState({ title, action, onAction } = {}) {
  const box = el('div', 'empty-state');
  box.append(el('div', null, title));
  if (action && onAction) {
    const btn = el('button', 'btn sm primary', action);
    btn.onclick = onAction;
    box.append(btn);
  }
  return box;
}
