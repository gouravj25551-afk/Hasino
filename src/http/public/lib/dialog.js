/**
 * In-page replacements for window.confirm / prompt / alert.
 *
 * The native ones are not available everywhere. `prompt()` in particular
 * *throws* "prompt() is not supported." in a sandboxed or embedded context
 * rather than returning null, and Chrome suppresses all three once a user
 * ticks "prevent this page from creating additional dialogs". Every caller
 * here sat in an onclick handler that ignored the returned promise, so the
 * throw became an unhandled rejection and the button silently did nothing —
 * which is exactly how "Approve & activate" stopped working.
 *
 * These build on .modal-backdrop / .modal-card from brand.css, which all three
 * surfaces already load, and create their own container so no page needs a
 * mount point. Nothing here can throw at the call site: cancelling resolves,
 * it does not reject.
 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * A modal question. Resolves to null when dismissed, or to
 * `{ value, checked }` when confirmed — so a caller can always tell "cancelled"
 * from "confirmed with an empty reason", which `prompt()` conflates.
 *
 * `input` and `checkbox` are optional; omit both for a plain confirmation.
 */
export function ask({
  title,
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  input = null,
  checkbox = null,
} = {}) {
  return new Promise((resolve) => {
    const backdrop = el('div', 'modal-backdrop');
    const card = el('div', 'modal-card');

    card.append(el('h2', null, title));
    if (message) {
      const p = el('p', 'sub', message);
      p.style.whiteSpace = 'pre-line'; // callers pass multi-line explanations
      card.append(p);
    }

    let field = null;
    if (input) {
      const label = el('label', 'field');
      if (input.label) label.append(el('span', null, input.label));
      field = el('input');
      field.type = input.type ?? 'text';
      field.placeholder = input.placeholder ?? '';
      field.value = input.value ?? '';
      label.append(field);
      card.append(label);
    }

    let box = null;
    if (checkbox) {
      const label = el('label', 'row');
      label.style.cssText = 'gap:8px; align-items:center; margin-top:12px; cursor:pointer';
      box = el('input');
      box.type = 'checkbox';
      box.checked = !!checkbox.checked;
      label.append(box, el('span', null, checkbox.label));
      card.append(label);
    }

    const row = el('div', 'row');
    row.style.cssText = 'gap:8px; margin-top:20px; justify-content:flex-end';
    const cancel = el('button', 'btn', cancelLabel);
    const confirm = el('button', 'btn ' + (danger ? 'danger' : 'primary'), confirmLabel);
    cancel.type = 'button';
    confirm.type = 'button';
    // An empty cancelLabel means there is nothing to decline — notify() uses
    // it for a message that only needs acknowledging.
    if (cancelLabel) row.append(cancel);
    row.append(confirm);
    card.append(row);

    // One exit point, so the listener and the node are always cleaned up
    // together — a leaked keydown listener here would swallow Escape for the
    // rest of the session.
    let done = false;
    const close = (result) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(result);
    };

    const submit = () => close({ value: field ? field.value.trim() : '', checked: box ? box.checked : false });

    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      // Enter submits from the text field only; a bare Enter must not fire a
      // destructive default while the confirm button has focus by accident.
      else if (e.key === 'Enter' && field && document.activeElement === field) submit();
    };

    cancel.onclick = () => close(null);
    confirm.onclick = submit;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(null); };
    document.addEventListener('keydown', onKey);

    backdrop.append(card);
    document.body.append(backdrop);
    (field ?? confirm).focus();
  });
}

/** Informational. Resolves when dismissed. Replaces alert(). */
export function notify({ title, message = '', tone = 'ok' } = {}) {
  return ask({
    title,
    message,
    confirmLabel: 'OK',
    cancelLabel: '',
    danger: tone === 'bad',
  }).then(() => undefined);
}
