import { el } from '../lib/dom.js';

/**
 * Transient messages, in one place.
 *
 * The panel grew its own toast() that appended a div into whatever view was
 * on screen, so a message could scroll away with the page, stack unpredictably
 * or land under the bottom nav. This is a single fixed region, shared by every
 * screen.
 *
 * The region is aria-live="polite": the message is announced once, without
 * interrupting whatever is being read. Errors get role="alert" instead, since
 * a failed booking is worth interrupting for.
 */
let region = null;

function ensureRegion() {
  if (region && region.isConnected) return region;
  region = el('div', 'toast-region');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'false');
  document.body.append(region);
  return region;
}

/**
 * `tone` is '' | 'ok' | 'bad'. An error stays until dismissed — it usually
 * says something the customer has to act on, and a message that removes itself
 * mid-read is worse than one that needs a tap.
 */
export function toast(message, { tone = '', duration } = {}) {
  const host = ensureRegion();
  const node = el('div', ['toast', tone].filter(Boolean).join(' '));
  if (tone === 'bad') node.setAttribute('role', 'alert');

  node.append(el('span', 'toast-dot'));
  node.append(el('span', 'toast-msg', String(message)));

  const close = el('button', 'toast-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.onclick = () => dismiss(node);
  node.append(close);

  host.append(node);

  const ms = duration ?? (tone === 'bad' ? 0 : 4000);
  if (ms > 0) setTimeout(() => dismiss(node), ms);
  return node;
}

function dismiss(node) {
  if (!node.isConnected) return;
  node.classList.add('leaving');
  // Matches the leave animation. Falls back to a plain remove if the element
  // never gets one (reduced motion collapses the duration to ~0).
  setTimeout(() => node.remove(), 220);
}

export const toastOk = (m) => toast(m, { tone: 'ok' });
export const toastError = (m) => toast(m, { tone: 'bad' });
