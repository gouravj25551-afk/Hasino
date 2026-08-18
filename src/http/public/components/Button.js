import { el } from '../lib/dom.js';

/**
 * The five intents the design system defines: '' (default/outline), 'primary',
 * 'secondary', 'ghost', 'danger', 'success'. Sizes: '', 'sm', 'lg'.
 *
 * `loading` is a state rather than a caller's job: the button keeps its label
 * and therefore its width — so nothing on the row jumps — and shows a spinner
 * over it. aria-busy is what the CSS hooks, which means a screen reader is
 * told the same thing the spinner says.
 */
export function Button({
  label,
  variant = '',
  size = '',
  onClick,
  disabled = false,
  loading = false,
  block = false,
  type = 'button',
} = {}) {
  const cls = ['btn', variant, size, block ? 'block' : ''].filter(Boolean).join(' ');
  const btn = el('button', cls, label);
  btn.type = type;
  btn.disabled = disabled;
  if (loading) btn.setAttribute('aria-busy', 'true');
  if (onClick) btn.onclick = onClick;

  /**
   * Flip the button into its loading state.
   *
   * Exposed on the element so an async handler can say `btn.setLoading(true)`
   * around its await rather than each caller reinventing "disable it, swap the
   * text, remember the old text, put it back on failure" — which is where the
   * inconsistency between screens came from.
   */
  btn.setLoading = (on) => {
    if (on) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
    btn.disabled = !!on;
  };
  return btn;
}
