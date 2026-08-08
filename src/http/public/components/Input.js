import { el } from '../lib/dom.js';

/** Returns the wrapper element; `wrapper.input` is the underlying <input>. */
export function Input({ label, type = 'text', placeholder = '', value = '', onInput } = {}) {
  const wrap = el(label ? 'label' : 'div', 'field');
  if (label) wrap.append(el('span', null, label));
  const input = el('input');
  input.type = type;
  input.placeholder = placeholder;
  input.value = value;
  if (onInput) input.oninput = () => onInput(input.value);
  wrap.append(input);
  wrap.input = input;
  return wrap;
}
