/**
 * The salon page's photos, its menu, the saved-salon heart, the panel header,
 * and the resize step before an upload.
 *
 * Source assertions, in the style of panel-ui.test.ts and
 * assets-served.test.ts: these are browser modules with no build step and no
 * DOM in the runner, so what is protected here is the shape of the code — the
 * decisions that are one careless edit from silently regressing. The
 * behaviours themselves were driven in a real browser during development.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const salon = read('src/http/public/views/salon.js');
const carousel = read('src/http/public/components/ImageCarousel.js');
const heart = read('src/http/public/components/HeartButton.js');
const favorites = read('src/http/public/lib/favorites.js');
const card = read('src/http/public/components/SalonCard.js');
const crop = read('src/http/public/lib/imagecrop.js');
const business = read('src/http/public/business.js');
const businessHtml = read('src/http/public/business.html');
const admin = read('src/http/public/admin.js');
const app = read('src/http/public/app.js');
const router = read('src/http/public/lib/router.js');
const css = read('src/http/public/brand.css');

describe('the salon hero is a carousel', () => {
  it('the page hands it every photo the API returned, deduped', () => {
    // cover_url falls back to photos[0] server-side, so without the Set a
    // salon with one gallery photo and no upload shows it twice.
    assert.match(salon, /new Set\(\[salon\.coverImage, \.\.\.\(salon\.photos \?\? \[\]\)\]\.filter\(Boolean\)\)/);
    assert.match(salon, /ImageCarousel\(shots,/);
  });

  it('one photo is not a carousel', () => {
    // No arrows, no dots, and above all no timer running forever for a
    // journey of length one.
    assert.match(carousel, /if \(shots\.length === 1\)/);
    const single = /if \(shots\.length === 1\) \{[\s\S]*?\n  \}/.exec(carousel)?.[0] ?? '';
    assert.doesNotMatch(single, /carousel-nav|carousel-dot|setInterval/);
  });

  it('it advances on its own, and stops when the customer is involved', () => {
    assert.match(carousel, /timer = setInterval\(tick, interval\)/);
    assert.match(carousel, /if \(held > 0 \|\| document\.hidden \|\| Date\.now\(\) < resumeAt\) return;/);
    for (const event of ['pointerenter', 'pointerleave', 'focusin', 'focusout']) {
      assert.match(carousel, new RegExp(`addEventListener\\('${event}'`), `${event} must pause or resume it`);
    }
    assert.match(carousel, /resumeAt = Date\.now\(\) \+ RESUME_AFTER_MS/, 'a manual change holds the timer off');
  });

  it('the timer stops itself when the view is re-rendered', () => {
    // Every view here empties a container to redraw. Nothing else would ever
    // tell this component it is gone, and one live interval per salon opened
    // is a leak that grows all session.
    assert.match(carousel, /if \(!root\.isConnected\) \{\s*[\s\S]*?clearInterval\(timer\)/);
  });

  it('a swipe is a pointer drag, so touch and mouse are one path', () => {
    assert.match(carousel, /addEventListener\('pointerdown'/);
    assert.match(carousel, /addEventListener\('pointermove'/);
    assert.match(carousel, /Math\.abs\(moved\) >= SWIPE_PX/);
    // pan-y is what lets a vertical scroll through while the horizontal
    // gesture belongs to the carousel.
    assert.match(css, /\.carousel \{[^}]*touch-action: pan-y/);
  });

  it('nothing is stretched', () => {
    assert.match(css, /\.carousel-slide > img \{[^}]*object-fit: cover/);
  });

  it('a device that asked for stillness gets no autoplay', () => {
    assert.match(carousel, /if \(!reducedMotion\(\)\) timer = setInterval/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.carousel-track \{ transition: none/);
  });
});

describe('saving a salon is one heart and one implementation', () => {
  it('the endpoints are called from exactly one module', () => {
    for (const [name, source] of [['salon.js', salon], ['SalonCard.js', card], ['HeartButton.js', heart]] as const) {
      assert.doesNotMatch(source, /'\/api\/me\/favorites'/, `${name} must not fetch favorites itself`);
    }
    assert.match(favorites, /api\('\/api\/me\/favorites'\)/);
    assert.match(favorites, /method: 'POST'/);
    assert.match(favorites, /method: 'DELETE'/);
  });

  it('the saved state comes from the server, so a refresh keeps it', () => {
    // No localStorage: the record is the favorites table, which is also what
    // makes a save follow the customer to another device.
    assert.doesNotMatch(favorites, /localStorage|sessionStorage/);
    assert.match(salon, /await loadFavorites\(\{ signedIn: Boolean\(app\.session\) \}\)/);
    for (const view of ['views/home.js', 'views/explore.js']) {
      assert.match(read(`src/http/public/${view}`), /await loadFavorites\(/, `${view} must load the saved list`);
    }
  });

  it('the cache is only written after the server agrees', () => {
    const fn = /export async function setFavorite\([\s\S]*?\n\}/.exec(favorites)?.[0] ?? '';
    assert.notEqual(fn, '', 'setFavorite() not found');
    const awaitAt = Math.max(fn.indexOf('await api('), fn.lastIndexOf('await api('));
    assert.ok(awaitAt > 0 && fn.indexOf('saved ??= new Set()') > awaitAt,
      'a failed save must not leave a salon marked saved');
  });

  it('a failed save puts the heart back', () => {
    const onclick = /btn\.onclick = async \(e\) => \{[\s\S]*?\n  \};/.exec(heart)?.[0] ?? '';
    assert.match(onclick, /paint\(next, \{ animate: next \}\)/, 'optimistic, so the tap feels instant');
    assert.match(onclick, /catch \(err\) \{\s*paint\(!next\)/, 'and reverted when it does not land');
  });

  it('pressing it never opens the card underneath', () => {
    assert.match(heart, /e\.stopPropagation\(\);\s*\n\s*e\.preventDefault\(\);/);
    assert.match(heart, /addEventListener\('pointerdown', \(e\) => e\.stopPropagation\(\)\)/);
    // The card listens for Enter and Space as a link, too.
    assert.match(heart, /addEventListener\('keydown'/);
    // And it is over the photo rather than inside the card's body flow.
    assert.match(css, /\.salon-card-heart \{[^}]*position: absolute/);
  });

  it('every heart for one salon agrees with every other', () => {
    assert.match(favorites, /export function onFavoritesChanged/);
    assert.match(heart, /onFavoritesChanged\(\(id, nowSaved\) =>/);
    // A session that arrives after the cards were drawn repaints them.
    assert.match(favorites, /function replaceAll\(next\)/);
    assert.match(app, /loadFavorites\(\{ signedIn: true, force: true \}\)/);
  });

  it('signing out forgets them', () => {
    assert.match(app, /forgetFavorites\(\)/);
    assert.match(favorites, /export function forgetFavorites/);
  });

  it('unsaved is an outline and saved is a filled red heart', () => {
    assert.match(css, /\.heart-btn svg path \{[^}]*fill: none/);
    assert.match(css, /\.heart-btn\.is-saved svg path \{[^}]*fill: #e2364d/);
    assert.match(css, /@keyframes heart-pop/);
    assert.match(heart, /btn\.classList\.add\('pop'\)/);
  });

  it('a signed-out visitor is sent to sign in rather than to a 401', () => {
    assert.match(heart, /if \(!signedIn\) \{\s*onRequireSignIn\?\.\(\);/);
    assert.match(salon, /onRequireSignIn: \(\) => app\.signIn\(\)/);
  });
});

describe("the salon's menu is the salon's own categories", () => {
  it('nothing hardcodes a list of categories', () => {
    // home.js and explore.js have a fixed discovery filter; the salon page
    // must not, or a salon whose services are 'nails' gets a menu that does
    // not mention them.
    assert.doesNotMatch(salon, /const CATEGORIES/);
    assert.match(salon, /const categories = \[\.\.\.byCategory\.keys\(\)\]/);
    assert.match(salon, /byCategory\.get\(c\)\.length/);
  });

  it('one category is not a menu', () => {
    assert.match(salon, /if \(categories\.length > 1\) \{/);
  });

  it('a chip scrolls to its section, under the sticky header rather than behind it', () => {
    assert.match(salon, /scrollToSection\(target, stickyOffset\(nav\)\)/);
    const offset = /function stickyOffset\(nav\) \{[\s\S]*?\n\}/.exec(salon)?.[0] ?? '';
    assert.match(offset, /\.topbar/, 'the header is measured, not assumed');
    assert.match(read('src/http/public/components/CategoryNav.js'), /behavior: 'smooth'/);
  });

  it('the header publishes the height the menu sticks under', () => {
    assert.match(app, /setProperty\('--app-header-height', `\$\{bar\.offsetHeight\}px`\)/);
    assert.match(app, /ResizeObserver/);
    assert.match(css, /\.menu-nav \{[\s\S]*?top: var\(--app-header-height, 0px\)/);
  });

  it('the chip for the section on screen is the highlighted one', () => {
    assert.match(salon, /new IntersectionObserver\(/);
    assert.match(salon, /nav\.setActive\(current \?\? 'all'\)/);
    // A press moves the highlight at once and mutes the observer while the
    // page travels, or the highlight fights the scroll it started.
    assert.match(salon, /suppressSpy\(\)/);
  });

  it('many categories scroll sideways rather than wrapping', () => {
    assert.match(css, /\.category-strip \{[^}]*overflow-x: auto/);
    assert.match(read('src/http/public/components/CategoryNav.js'), /strip\.scrollTo\(/);
  });
});

describe('the salon panel has no per-booking Cancel', () => {
  it('the button is gone from the panel', () => {
    assert.doesNotMatch(business, /el\('button', 'btn sm', 'Cancel'\)/);
    assert.doesNotMatch(business, /send\('cancel'\)/);
  });

  it('and so is the action behind it', () => {
    const map = /const map: Record<string, BookingStatus> = \{[\s\S]*?\};/
      .exec(read('src/http/routes-business.ts'))?.[0] ?? '';
    assert.notEqual(map, '', 'the action map was not found');
    assert.doesNotMatch(map, /cancel:/);
    // What replaced it is still there: a no-show, and closing the whole day.
    assert.match(map, /'no-show': 'no_show'/);
    assert.match(read('src/http/routes-business.ts'), /tail\[0\] === 'close-today'/);
  });

  it("but the customer's own cancellation is untouched", () => {
    assert.match(read('src/http/server.ts'), /seg\[4\] === 'cancel'/);
    assert.match(read('src/http/public/components/BookingCard.js'), /Cancel/);
    // And the status itself still exists — closing a day writes it.
    assert.match(read('src/booking/status.ts'), /cancelled_by_salon/);
  });
});

describe('the salon panel has the owner in the top-right corner', () => {
  it('the header exists, with a slot for the account', () => {
    assert.match(businessHtml, /class="panel-header"/);
    assert.match(businessHtml, /id="panelAccount"/);
    assert.match(businessHtml, /id="panelTitle"/);
  });

  it('and it is pinned right even when the header wraps', () => {
    assert.match(css, /\.panel-header-actions \{[^}]*margin-left: auto/);
  });

  it('the control is the same shape as the customer app’s', () => {
    // Not a second idea of what an account menu looks like: same classes,
    // same aria, same close-on-Escape.
    for (const hook of [/el\('div', 'account'\)/, /el\('button', 'account-trigger'\)/, /el\('div', 'account-menu'\)/]) {
      assert.match(business, hook);
    }
    assert.match(business, /aria-haspopup', 'menu'/);
    assert.match(business, /e\.key === 'Escape'/);
  });

  it('it opens the profile and keeps sign-out reachable', () => {
    assert.match(business, /link\('#\/profile', 'Salon profile'\)/);
    assert.match(business, /await signOut\(\)/);
  });

  it('the header says which screen you are on', () => {
    assert.match(business, /const PANEL_TITLES = \{/);
    assert.match(business, /title\.textContent = PANEL_TITLES\[hash\] \|\| 'Today'/);
  });
});

describe('a photo is framed and resized before it is uploaded', () => {
  it('both panels go through the one dialog', () => {
    assert.match(business, /from '\.\/lib\/imagecrop\.js'/);
    assert.match(admin, /from '\.\/lib\/imagecrop\.js'/);
    assert.match(business, /await cropImage\(chosen, \{ aspect: CARD_ASPECT/);
    assert.match(admin, /return cropImage\(file, \{ aspect: CARD_ASPECT/);
    // And it is served from both origins, or the import 404s and the page
    // renders blank.
    assert.match(read('src/http/server.ts'), /'lib\/imagecrop\.js'/);
    assert.match(read('src/http/admin-server.ts'), /'lib\/imagecrop\.js'/);
  });

  it('backing out of the dialog uploads nothing', () => {
    assert.match(business, /if \(!framed\) return;/);
    assert.match(admin, /if \(!framed\) return;/);
  });

  it('the file is decoded without a blob: URL, which the CSP refuses', () => {
    // img-src is 'self' data: https:. An object URL is blocked outright, and
    // the dialog can then never show the photo that was just chosen — which
    // is exactly what it did before this.
    assert.doesNotMatch(crop, /createObjectURL/);
    assert.match(crop, /createImageBitmap\(file\)/);
    assert.match(crop, /readAsDataURL/, 'and a data: URL where that is missing');
    assert.match(read('src/http/middleware.ts'), /img-src 'self' data: https:/);
  });

  it('the output keeps the card’s shape and lands under the upload cap', () => {
    assert.match(crop, /export const CARD_ASPECT = 16 \/ 10/);
    assert.match(crop, /const MAX_OUTPUT_WIDTH = 1600/);
    assert.match(crop, /const height = Math\.round\(width \/ aspect\)/);
    // Never upscaled: a bigger blurry photo is not a better one.
    assert.match(crop, /Math\.min\(MAX_OUTPUT_WIDTH, region\.sw\)/);
    assert.match(crop, /'image\/jpeg', JPEG_QUALITY/);
    // And the server still decides what it will accept.
    assert.match(read('src/salons/images.ts'), /export const MAX_IMAGE_BYTES = 2 \* 1024 \* 1024/);
  });

  it('the frame cannot be dragged off the edge of the photo', () => {
    assert.match(crop, /const clamp = \(\) => \{/);
    assert.match(crop, /Math\.max\(0, img\.width - sw\)/);
  });

  it('a transparent PNG does not come out black', () => {
    // JPEG has no alpha; without the fill, transparency encodes as black.
    assert.match(crop, /ctx\.fillStyle = '#ffffff';\s*\n\s*ctx\.fillRect\(0, 0, canvas\.width, canvas\.height\);/);
  });

  it('the dialog is the same overlay Android’s back button knows how to close', () => {
    assert.match(crop, /el\('div', 'modal-backdrop'\)/);
    assert.match(read('src/http/public/lib/backbutton.js'), /querySelectorAll\('\.modal-backdrop'\)/);
  });
});

describe('the login page does not trap the back button', () => {
  it('a redirect replaces the entry it came from instead of stacking on it', () => {
    assert.match(router, /export function replace\(hash\)/);
    assert.match(router, /location\.replace\(hash\)/);
    // The protected route that bounced them must not be behind the login
    // page, or Back lands on it and it bounces them forward again.
    const require = /function requireSession\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '';
    assert.match(require, /rememberReturnTo\(currentHash\(\)\)/);
    assert.match(require, /replace\('#\/login'\)/);
    assert.doesNotMatch(require, /go\('#\/login'\)/);
  });

  it('signing in leaves the login page behind rather than on top of', () => {
    assert.match(app, /navigateTo\(afterSignInDestination\(\), \{ swap: currentHash\(\) === '#\/login' \}\)/);
  });

  it('and finishes the trip the visitor was on', () => {
    assert.match(app, /const returnTo = takeReturnTo\(\)/);
    assert.match(app, /panelForRole\(\) \?\? returnTo \?\? \(intent === 'salon' \? '#\/apply' : '#\/home'\)/);
    // Read once and cleared, or an interrupted trip hijacks the next sign-in.
    assert.match(app, /sessionStorage\.removeItem\(RETURN_TO\)/);
    // '#/login' is never a destination.
    assert.match(app, /hash !== '#\/login' \? hash : null/);
  });

  it('the login page offers its own way back', () => {
    const login = read('src/http/public/views/login.js');
    assert.match(login, /login-back/);
    assert.match(login, /window\.history\.back\(\)/);
    assert.match(login, /replace\('#\/home'\)/, 'and home replaces it when there is no history');
  });

  it('signing out does not leave a page that bounces to login behind it', () => {
    const out = /async function doSignOut\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '';
    assert.match(out, /replace\('#\/home'\)/);
    assert.match(out, /await signOut\(\)/, 'and it still signs out');
  });

  it("Android's back button is told a replacement is not a step forward", () => {
    assert.match(router, /REPLACED_EVENT/);
    assert.match(read('src/http/public/lib/backbutton.js'), /addEventListener\('hasino:replace'/);
  });
});
