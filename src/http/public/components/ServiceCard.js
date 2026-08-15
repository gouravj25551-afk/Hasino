import { el } from '../lib/dom.js';
import { rupees } from '../lib/format.js';

/**
 * A service on the salon's menu, with the button that puts it in the cart.
 *
 * An "Add" button rather than a checkbox, because that is what choosing
 * services actually is: the customer is filling a basket, not answering a
 * form. It also gives the action a name — a bare tick told you the state and
 * never told you what tapping it would do.
 *
 * `service` matches SalonDetail.services[]. `selected` says whether it is
 * already in the cart; `onToggle(serviceId, nowSelected)` is called with what
 * the tap means. The component holds no state of its own — the cart is the one
 * source of truth and it lives in the view.
 */
export function ServiceCard(service, { selected = false, onToggle } = {}) {
  const row = el('div', 'item pick');

  const grow = el('div', 'grow');
  grow.append(el('div', null, service.name));
  grow.append(
    el('div', 'meta', `${service.category.toUpperCase()} · ${service.durationMin} min`),
  );
  row.append(grow);
  row.append(el('strong', null, rupees(service.price)));

  const add = el('button', 'add-btn' + (selected ? ' added' : ''));
  add.type = 'button';
  // So the cart sheet can put this button back in step when a service is
  // removed from there rather than from here.
  add.dataset.service = service.serviceId;
  const paint = (isIn) => {
    add.textContent = isIn ? '✓ Added' : 'Add';
    add.classList.toggle('added', isIn);
    add.setAttribute(
      'aria-label',
      `${isIn ? 'Remove' : 'Add'} ${service.name}, ${rupees(service.price)}, ${service.durationMin} minutes`,
    );
    add.setAttribute('aria-pressed', String(isIn));
  };
  paint(selected);

  // Tapping an added service takes it out again — the same button, because on
  // a phone the row is where the customer's thumb already is. The cart sheet
  // has an explicit Remove for when they are reviewing rather than browsing.
  add.onclick = () => {
    const nowIn = !add.classList.contains('added');
    paint(nowIn);
    onToggle?.(service.serviceId, nowIn);
  };
  row.append(add);

  return row;
}
