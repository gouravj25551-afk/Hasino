/**
 * The customer panel's newer moving parts: the cart, the theme, and the
 * booking action that says what it does.
 *
 * The cart and the theme are plain modules with one dependency each on browser
 * storage, so they are driven directly with a stub. The rest is asserted
 * against the source, in the style of admin-separation.test.ts — these are
 * browser modules with no build step and no DOM here.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Just enough Storage for the two modules under test. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  };
}

(globalThis as Record<string, unknown>)['sessionStorage'] = fakeStorage();
(globalThis as Record<string, unknown>)['localStorage'] = fakeStorage();

const cartModule = '../src/http/public/lib/cart.js';
const { cartFor, cartSalonId, cartTotals, clearCart, saveCart } = (await import(cartModule)) as {
  cartFor: (salonId: string) => string[];
  cartSalonId: () => string | null;
  cartTotals: (services: Array<{ price: number; durationMin: number }>) => {
    count: number; price: number; durationMin: number;
  };
  clearCart: () => void;
  saveCart: (salonId: string, ids: string[]) => void;
};

const SALON = 'salon-a';
const OTHER = 'salon-b';

describe('cart — one salon at a time', () => {
  beforeEach(() => clearCart());

  it('remembers what was picked, for the salon it was picked at', () => {
    saveCart(SALON, ['haircut', 'beard']);
    assert.deepEqual(cartFor(SALON), ['haircut', 'beard']);
    assert.equal(cartSalonId(), SALON);
  });

  it('another salon starts empty — a booking is with one salon', () => {
    saveCart(SALON, ['haircut']);
    assert.deepEqual(cartFor(OTHER), [], "another salon's services are not in this cart");
  });

  it('saving for a new salon replaces the old cart rather than merging it', () => {
    saveCart(SALON, ['haircut']);
    saveCart(OTHER, ['shave']);
    assert.deepEqual(cartFor(OTHER), ['shave']);
    assert.deepEqual(cartFor(SALON), []);
  });

  it('emptying the cart clears it rather than storing an empty one', () => {
    saveCart(SALON, ['haircut']);
    saveCart(SALON, []);
    assert.equal(cartSalonId(), null);
  });

  it('survives junk under its key', () => {
    (globalThis as Record<string, unknown>)['sessionStorage'] = {
      getItem: () => '{"not":"a cart"',
      setItem: () => {},
      removeItem: () => {},
    };
    assert.deepEqual(cartFor(SALON), [], 'a broken cart is an empty cart, not a broken page');
    (globalThis as Record<string, unknown>)['sessionStorage'] = fakeStorage();
  });
});

describe('cart — totals come from the salon’s own numbers', () => {
  it('adds up price and duration across every picked service', () => {
    const totals = cartTotals([
      { price: 30_000, durationMin: 30 },
      { price: 20_000, durationMin: 20 },
    ]);
    assert.equal(totals.count, 2);
    assert.equal(totals.price, 50_000, '₹300 + ₹200 = ₹500');
    assert.equal(totals.durationMin, 50, 'durations are summed, never assumed');
  });

  it('an empty cart totals nothing', () => {
    assert.deepEqual(cartTotals([]), { count: 0, price: 0, durationMin: 0 });
  });
});

describe('cart — the booking carries every service', () => {
  const salon = read('src/http/public/views/salon.js');

  it('posts the whole cart, not the first service', () => {
    assert.match(salon, /serviceIds: picked\.map\(\(s\) => s\.serviceId\)/);
  });

  it('asks for availability with the whole cart, so the duration is the real one', () => {
    assert.match(salon, /serviceIds: \[\.\.\.cart\]/);
  });

  it('clears the cart once it has been turned into a booking', () => {
    assert.match(salon, /clearCart\(\)/);
  });

  it('the schema already holds several services per booking', () => {
    // booking_items, one row per service with its price and duration frozen —
    // no migration was needed for a multi-service cart.
    assert.match(read('db/schema.sql'), /CREATE TABLE IF NOT EXISTS booking_items/);
    assert.match(read('src/booking/create.ts'), /INSERT INTO booking_items/);
  });

  it('the salon owner’s day list shows every service on a booking', () => {
    assert.match(read('src/business/repo.ts'), /array_agg\(sv\.name/);
  });
});

describe('the booking action is called what it does', () => {
  it('the card says Reschedule, not Move', () => {
    const card = read('src/http/public/components/BookingCard.js');
    assert.match(card, /'Reschedule'/);
    assert.doesNotMatch(card, /'Move'/);
  });

  it('and it still goes through the reschedule endpoint', () => {
    assert.match(read('src/http/public/views/bookings.js'), /\/reschedule`, \{\s*method: 'POST'/);
  });

  it('which re-checks capacity inside the booking lock', () => {
    // The rename must not become a shortcut around the chair count: reschedule
    // creates the new booking through createBookingTx, under the advisory lock.
    assert.match(read('src/booking/reschedule.ts'), /createBookingTx/);
  });
});

describe('theme', () => {
  const themeModule = '../src/http/public/lib/theme.js';

  it('follows the device until someone chooses, then remembers the choice', async () => {
    (globalThis as Record<string, unknown>)['localStorage'] = fakeStorage();
    (globalThis as Record<string, unknown>)['document'] = {
      documentElement: { setAttribute: () => {}, style: {} },
    };
    (globalThis as Record<string, unknown>)['window'] = {
      matchMedia: () => ({ matches: true, addEventListener: () => {} }),
    };
    const theme = (await import(themeModule)) as {
      currentTheme: () => string;
      storedTheme: () => string | null;
      setTheme: (t: string) => string;
      toggleTheme: () => string;
    };

    assert.equal(theme.storedTheme(), null, 'nothing chosen yet');
    assert.equal(theme.currentTheme(), 'dark', 'so the device decides');

    assert.equal(theme.setTheme('light'), 'light');
    assert.equal(theme.storedTheme(), 'light', 'the choice is remembered across launches');
    assert.equal(theme.currentTheme(), 'light', 'and it beats the device');

    assert.equal(theme.toggleTheme(), 'dark');
    assert.equal(theme.currentTheme(), 'dark');
  });

  it('is applied before the first route paints', () => {
    const app = read('src/http/public/app.js');
    const init = app.indexOf('initTheme()');
    const boot = app.indexOf('boot()');
    assert.ok(init > 0 && init < boot, 'a late theme is a flash of the wrong one on every launch');
  });

  it('both palettes are reachable without the device agreeing', () => {
    const css = read('src/http/public/brand.css');
    assert.match(css, /:root\[data-theme="dark"\]/, 'explicit dark');
    assert.match(css, /:root:not\(\[data-theme="light"\]\)/, 'system dark, unless overridden');
  });

  it('the theme-dependent colours are tokens, not hardcoded hexes in rules', () => {
    const css = read('src/http/public/brand.css');
    // These four used to be `@media (prefers-color-scheme: dark) { … #c9bcff }`
    // overrides, which no toggle could reach.
    for (const rule of ['.avatar', '.pill.brand', '.aspect.placeholder']) {
      const block = new RegExp(`\\${rule}[^{]*\\{[^}]*color: var\\(--brand-ink\\)`);
      assert.match(css, block, `${rule} must take its colour from the palette`);
    }
  });

  it('the modules the panel imports are actually served', () => {
    const server = read('src/http/server.ts');
    assert.match(server, /'lib\/theme\.js'/);
    assert.match(server, /'lib\/cart\.js'/);
  });
});

describe('the signed-in customer lives in the top-right corner', () => {
  const topbar = read('src/http/public/components/TopBar.js');

  it('the account control is in the header, with sign-out and the theme in it', () => {
    assert.match(topbar, /el\('div', 'account'\)/);
    assert.match(topbar, /el\('button', 'account-trigger'\)/);
    assert.match(topbar, /toggleTheme/);
    assert.match(topbar, /'Sign out'/);
  });

  it('it is pinned right even when the bar wraps on a phone', () => {
    assert.match(read('src/http/public/brand.css'), /\.account \{[^}]*margin-left: auto/);
  });

  it('the profile page no longer prints the name as a banner', () => {
    const profile = read('src/http/public/views/profile.js');
    assert.doesNotMatch(profile, /el\('h2', null, session\.name/);
  });
});
