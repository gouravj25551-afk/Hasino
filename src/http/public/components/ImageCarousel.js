import { el } from '../lib/dom.js';

/**
 * A salon's photos, one at a time.
 *
 * A salon can have several pictures — cover_url plus the salon_photos gallery
 * the API already returns — and the page was showing exactly one of them, so
 * the rest existed in the database and nowhere else.
 *
 * What this is careful about:
 *
 *  - One photo is not a carousel. No arrows, no dots, no timer: the controls
 *    would all be inert and the timer would run forever for nothing.
 *  - It advances on its own, and stops the moment the customer is involved —
 *    a pointer over it, a finger on it, focus inside it, or the tab in the
 *    background. Autoplay that fights a swipe is worse than no autoplay.
 *  - Nothing is stretched. Every slide is object-fit: cover inside a fixed
 *    aspect box, so a portrait phone photo is cropped, never squashed.
 *  - It cleans itself up. The views here re-render by emptying a container,
 *    so the timer checks whether it is still on the page and stops if not —
 *    otherwise every salon opened would leave one running.
 *  - Reduced motion means no automatic movement at all, and no slide
 *    transition; the controls still work.
 */
const AUTOPLAY_MS = 4200;
/** How long a manual change holds the timer off, so it never steals a swipe. */
const RESUME_AFTER_MS = 7000;
/** Horizontal travel that counts as a swipe rather than a tap. */
const SWIPE_PX = 40;

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function ImageCarousel(images, {
  alt = '',
  aspect = 'cover',
  interval = AUTOPLAY_MS,
  placeholder = '',
} = {}) {
  const shots = (images ?? []).filter(Boolean);

  // No photo at all: the same lettered placeholder the cards use. Never a
  // borrowed stock image.
  if (shots.length === 0) {
    const empty = el('div', `aspect ${aspect} placeholder`);
    empty.append(document.createTextNode((placeholder || alt || '?').slice(0, 1).toUpperCase()));
    return empty;
  }

  const root = el('div', `carousel aspect ${aspect}`);

  // One photo: a plain image. Everything below would be controls for a
  // journey of length one.
  if (shots.length === 1) {
    const only = el('img');
    only.src = shots[0];
    only.alt = alt;
    root.append(only);
    return root;
  }

  root.setAttribute('role', 'group');
  root.setAttribute('aria-roledescription', 'carousel');
  root.setAttribute('aria-label', alt ? `${alt} photos` : 'Photos');

  const track = el('div', 'carousel-track');
  for (const [i, src] of shots.entries()) {
    const slide = el('div', 'carousel-slide');
    slide.setAttribute('role', 'group');
    slide.setAttribute('aria-roledescription', 'slide');
    slide.setAttribute('aria-label', `${i + 1} of ${shots.length}`);
    const img = el('img');
    img.src = src;
    img.alt = i === 0 ? alt : '';
    // Only the first one is worth blocking the hero on; the rest arrive
    // before the timer reaches them.
    img.loading = i === 0 ? 'eager' : 'lazy';
    img.draggable = false;
    slide.append(img);
    track.append(slide);
  }
  root.append(track);

  let index = 0;
  let timer = null;
  let held = 0;          // interactions currently holding autoplay off
  let resumeAt = 0;      // no autoplay until this timestamp

  const dots = el('div', 'carousel-dots');
  dots.setAttribute('role', 'tablist');
  const dotButtons = shots.map((_, i) => {
    const dot = el('button', 'carousel-dot');
    dot.type = 'button';
    dot.setAttribute('role', 'tab');
    dot.setAttribute('aria-label', `Photo ${i + 1}`);
    dot.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      go(i, { manual: true });
    };
    dots.append(dot);
    return dot;
  });

  const paint = () => {
    track.style.transform = `translate3d(${-index * 100}%, 0, 0)`;
    for (const [i, dot] of dotButtons.entries()) {
      dot.classList.toggle('active', i === index);
      dot.setAttribute('aria-selected', String(i === index));
    }
    for (const [i, slide] of [...track.children].entries()) {
      // Off-screen slides are not in the tab order and not read out.
      slide.setAttribute('aria-hidden', String(i !== index));
    }
  };

  function go(to, { manual = false } = {}) {
    index = (to + shots.length) % shots.length;
    if (manual) resumeAt = Date.now() + RESUME_AFTER_MS;
    paint();
  }

  const arrow = (dir, label, glyph) => {
    const b = el('button', `carousel-nav ${dir}`);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.innerHTML = `<span aria-hidden="true">${glyph}</span>`;
    b.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      go(index + (dir === 'next' ? 1 : -1), { manual: true });
    };
    // The hero sits inside no link, but a card might; either way a press on an
    // arrow is not a press on what is underneath it.
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    return b;
  };
  root.append(arrow('prev', 'Previous photo', '‹'), arrow('next', 'Next photo', '›'), dots);

  // ---- autoplay, and everything that pauses it ----
  const tick = () => {
    if (!root.isConnected) {
      // The view was re-rendered out from under us. Nothing else will tell us.
      clearInterval(timer);
      timer = null;
      return;
    }
    if (held > 0 || document.hidden || Date.now() < resumeAt) return;
    go(index + 1);
  };

  if (!reducedMotion()) timer = setInterval(tick, interval);

  const hold = () => { held++; };
  const release = () => { held = Math.max(0, held - 1); };

  root.addEventListener('pointerenter', hold);
  root.addEventListener('pointerleave', release);
  root.addEventListener('focusin', hold);
  root.addEventListener('focusout', release);

  // ---- swipe ----
  // Pointer events cover touch, pen and mouse drag in one path. The track is
  // dragged with the finger and snaps to the nearest slide on release, which
  // is what makes it feel like a phone gallery rather than two arrows.
  let dragFrom = null;
  let dragDx = 0;

  root.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    dragFrom = e.clientX;
    dragDx = 0;
    hold();
    track.classList.add('dragging');
  });

  root.addEventListener('pointermove', (e) => {
    if (dragFrom === null) return;
    dragDx = e.clientX - dragFrom;
    track.style.transform = `translate3d(calc(${-index * 100}% + ${dragDx}px), 0, 0)`;
    // Past a real swipe the browser must stop trying to scroll the page
    // sideways instead; `touch-action: pan-y` in the CSS is the other half.
    if (Math.abs(dragDx) > 10 && e.cancelable) e.preventDefault();
  });

  const endDrag = () => {
    if (dragFrom === null) return;
    const moved = dragDx;
    dragFrom = null;
    dragDx = 0;
    track.classList.remove('dragging');
    release();
    if (Math.abs(moved) >= SWIPE_PX) go(index + (moved < 0 ? 1 : -1), { manual: true });
    else paint();   // snap back
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);
  root.addEventListener('pointerleave', endDrag);

  // ---- keyboard ----
  root.tabIndex = 0;
  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1, { manual: true }); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1, { manual: true }); }
  });

  paint();

  root.goTo = (i) => go(i, { manual: true });
  root.stop = () => { if (timer) clearInterval(timer); timer = null; };
  return root;
}
