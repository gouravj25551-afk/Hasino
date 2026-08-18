import { el } from '../lib/dom.js';

/**
 * Where you are in a multi-step flow.
 *
 * The booking flow already had real steps — pick services, pick a slot, review
 * and confirm — but nothing on screen named them, so the answer to "how much
 * more of this is there?" was "keep going and find out". That uncertainty is
 * most of what makes a checkout feel long.
 *
 * Rendered as an ordered list with aria-current on the active step, so it is a
 * described sequence to a screen reader rather than a row of decorative
 * circles. Steps already passed are marked done and are not re-announced as
 * current.
 *
 * `update(index)` mutates in place instead of rebuilding: this sits above a
 * panel the customer is actively using, and replacing the node on every cart
 * change would fight the scroll position.
 */
export function Stepper(labels, current = 0) {
  const list = el('ol', 'stepper');
  const items = labels.map((label, i) => {
    const li = el('li', 'stepper-step');
    li.append(el('span', 'stepper-dot', String(i + 1)));
    li.append(el('span', 'stepper-label', label));
    list.append(li);
    return li;
  });

  function update(index) {
    items.forEach((li, i) => {
      li.classList.toggle('is-done', i < index);
      li.classList.toggle('is-current', i === index);
      // The dot shows a tick once the step is behind you; the number is only
      // useful while it is still ahead.
      li.querySelector('.stepper-dot').textContent = i < index ? '✓' : String(i + 1);
      if (i === index) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
  }

  update(current);
  list.update = update;
  return list;
}
