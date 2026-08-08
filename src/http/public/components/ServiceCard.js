import { el } from '../lib/dom.js';
import { rupees } from '../lib/format.js';

/** A selectable row in the salon detail service list. `service` matches SalonDetail.services[]. */
export function ServiceCard(service, { selected = false, onToggle } = {}) {
  const row = el('label', 'item pick');

  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = selected;
  cb.onchange = () => onToggle?.(service.serviceId, cb.checked);

  const grow = el('div', 'grow');
  grow.append(el('div', null, service.name));
  grow.append(el('div', 'meta', `${service.category.toUpperCase()} · ${service.durationMin} min`));

  row.append(cb, grow, el('strong', null, rupees(service.price)));
  return row;
}
