import { el } from '../lib/dom.js';
import { Button } from './Button.js';

export function SearchBar({ placeholder = 'Search…', value = '', onSearch, debounceMs = 220 } = {}) {
  const wrap = el('div', 'search-bar-wrap');
  const input = el('input');
  input.placeholder = placeholder;
  input.value = value;

  let timer;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => onSearch?.(input.value.trim()), debounceMs);
  };

  const btn = Button({ label: 'Search', variant: 'primary', onClick: () => onSearch?.(input.value.trim()) });
  wrap.append(input, btn);
  wrap.input = input;
  return wrap;
}
