import { clear, el } from '../lib/dom.js';

function getContainer() {
  const node = document.getElementById('modalContainer');
  if (!node) throw new Error('#modalContainer is missing from the page');
  return node;
}

/** Mobile-style sheet anchored to the bottom edge. Same container as Modal — only one of either is ever open. */
export function BottomSheet(contentNode, { onClose } = {}) {
  const root = getContainer();
  clear(root);

  const backdrop = el('div', 'modal-backdrop sheet');
  const card = el('div', 'sheet-card');
  card.append(el('div', 'sheet-handle'), contentNode);
  backdrop.append(card);
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };
  root.append(backdrop);

  function close() {
    clear(root);
    onClose?.();
  }
  return close;
}
