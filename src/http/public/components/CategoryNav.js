import { el } from '../lib/dom.js';

/**
 * The menu bar over a salon's services.
 *
 * A salon with four categories and thirty services was one flat list, so
 * finding "beard" meant scrolling past every haircut. This is the same strip
 * of chips the home and explore screens use — `.category-strip` /
 * `.category-card`, so it is one visual language and not a second one — with
 * two things added: it sticks under the header while the services scroll, and
 * the chip for the section you are looking at is the active one.
 *
 * The categories are whatever the salon's own services say they are. Nothing
 * here has a list of category names; a salon that only does facials gets one
 * chip, and a new category added to the catalogue appears without a change
 * here.
 *
 * `items` is [{ id, label, count }]. `onSelect(id)` is the press.
 */
export function CategoryNav(items, { onSelect, ariaLabel = 'Service categories' } = {}) {
  const nav = el('nav', 'menu-nav');
  nav.setAttribute('aria-label', ariaLabel);

  const strip = el('div', 'category-strip menu-strip');
  nav.append(strip);

  const chips = new Map();
  for (const item of items) {
    const chip = el('button', 'category-card menu-chip');
    chip.type = 'button';
    chip.dataset.category = item.id;
    chip.append(el('span', null, item.label));
    if (item.count != null) chip.append(el('span', 'menu-chip-count', String(item.count)));
    chip.setAttribute('aria-label', item.count != null ? `${item.label}, ${item.count} services` : item.label);
    chip.onclick = () => onSelect?.(item.id);
    strip.append(chip);
    chips.set(item.id, chip);
  }

  /**
   * Mark one chip active and bring it into view *within the strip*.
   *
   * scrollLeft rather than scrollIntoView: the latter also scrolls the page
   * vertically, which on a scroll-driven highlight means the page fights the
   * customer's own scrolling.
   */
  nav.setActive = (id) => {
    for (const [key, chip] of chips) {
      const on = key === id;
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-current', on ? 'true' : 'false');
    }
    const chip = chips.get(id);
    if (!chip) return;
    const left = chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2;
    strip.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  };

  return nav;
}

/**
 * Scroll a section under the sticky chrome instead of behind it.
 *
 * window.scrollTo with a computed offset, because `scroll-margin-top` alone
 * cannot know the header's height — it is a wrapping flex bar whose height
 * depends on the viewport and the phone's notch.
 */
export function scrollToSection(section, offset = 0) {
  const top = section.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}
