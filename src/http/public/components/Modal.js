import { clear, el } from '../lib/dom.js';

function getContainer() {
  const node = document.getElementById('modalContainer');
  if (!node) throw new Error('#modalContainer is missing from the page');
  return node;
}

/** Centered dialog. Returns close(). Click on the backdrop closes it. */
export function Modal(contentNode, { onClose } = {}) {
  const root = getContainer();
  clear(root);

  const backdrop = el('div', 'modal-backdrop');
  const card = el('div', 'modal-card');
  card.append(contentNode);
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
