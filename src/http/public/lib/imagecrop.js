/**
 * Crop and resize a photo in the browser, before it is uploaded.
 *
 * Why this exists
 * ---------------
 * The upload was a bare <input type="file"> straight to a PUT: whatever came
 * out of the phone's picker was what customers saw. Two things fell out of
 * that. Every shot from a modern phone is 3-8 MB, and the route caps uploads
 * at 2 MB (src/salons/images.ts), so the common case was "please choose a
 * smaller one" with no way to make one. And the picture is rendered into a
 * fixed 16:10 card and a 21:9 hero, so a portrait photo was centre-cropped by
 * the browser with the owner never seeing which part survived.
 *
 * The resize step people were looking for is this: pick, frame, save.
 *
 * No new dependency
 * -----------------
 * A crop library would be the fourth thing this project loads from a CDN, and
 * the work is a drag, a scale and one drawImage — canvas does all of it. The
 * output is re-encoded as JPEG, which the upload route already accepts and
 * sniffs for, so nothing on the server changes.
 *
 * Quality: the source is drawn once, at the output size, with the browser's
 * high-quality smoothing on, and encoded at 0.9. A 16:10 card is never shown
 * wider than about 800 CSS pixels, so 1600 across is a 2x panel on a retina
 * screen and still lands comfortably under the size cap.
 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** The salon card's shape. The hero crops this further, from the middle. */
export const CARD_ASPECT = 16 / 10;
const MAX_OUTPUT_WIDTH = 1600;
const JPEG_QUALITY = 0.9;

/**
 * Decode a File into something drawImage() will take.
 *
 * Not an object URL. The app's CSP is `img-src 'self' data: https:` with no
 * `blob:`, so `<img src="blob:…">` is refused outright and the dialog can
 * never show the photo the owner just picked — which is what it did. The
 * choice is to widen the policy for every page or to decode without a URL,
 * and this decodes without a URL.
 *
 * createImageBitmap takes the File itself and is what every current browser
 * and the Android WebView has. The fallback reads it as a data: URL, which
 * the policy does allow — slower and heavier on memory, so it is the second
 * choice rather than the first.
 *
 * Returns { source, width, height } because an ImageBitmap has width/height
 * and an <img> has naturalWidth/naturalHeight, and nothing below should have
 * to care which one it got.
 */
async function loadImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // An old WebView, or a format it will not decode. Fall through.
    }
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('That file could not be read as an image.'));
    img.src = dataUrl;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))),
      type,
      quality,
    );
  });
}

/**
 * Draw the chosen region at the output size.
 *
 * `region` is in source-image pixels: {sx, sy, sw, sh}. The output is capped
 * at MAX_OUTPUT_WIDTH but never enlarged past the region itself — upscaling a
 * small photo only makes a bigger blurry photo.
 */
async function renderCrop(img, region, aspect) {
  const width = Math.round(Math.min(MAX_OUTPUT_WIDTH, region.sw));
  const height = Math.round(width / aspect);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // A JPEG has no alpha; without this a transparent PNG comes out black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img.source, region.sx, region.sy, region.sw, region.sh, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
}

/**
 * Open the crop dialog for `file`.
 *
 * Resolves to a File (JPEG) to upload, or null if the person backed out. It
 * never rejects for a cancel — the callers are onclick handlers.
 *
 * The dialog is .modal-backdrop / .modal-card, the same pair every other
 * dialog in this app uses, which also means Android's back button closes it:
 * lib/backbutton.js dismisses the topmost .modal-backdrop by clicking it.
 */
export function cropImage(file, { aspect = CARD_ASPECT, title = 'Resize your photo' } = {}) {
  return new Promise((resolve) => {
    const backdrop = el('div', 'modal-backdrop');
    const card = el('div', 'modal-card cropper-card');

    card.append(el('h2', null, title));
    card.append(el('p', 'sub', 'Drag to move, and use the slider to zoom. What is inside the frame is what customers see.'));

    const stage = el('div', 'cropper-stage');
    stage.style.aspectRatio = String(aspect);
    const canvas = el('canvas', 'cropper-canvas');
    stage.append(canvas);
    stage.append(el('div', 'cropper-frame'));
    card.append(stage);

    const zoomRow = el('label', 'field cropper-zoom');
    zoomRow.append(el('span', null, 'Zoom'));
    const zoom = el('input');
    zoom.type = 'range';
    zoom.min = '1';
    zoom.max = '3';
    zoom.step = '0.01';
    zoom.value = '1';
    zoomRow.append(zoom);
    card.append(zoomRow);

    const hint = el('div', 'meta cropper-hint', 'Reading the photo…');
    card.append(hint);

    const actions = el('div', 'row');
    actions.style.cssText = 'gap:8px; margin-top:16px; justify-content:flex-end';
    const cancel = el('button', 'btn', 'Cancel');
    cancel.type = 'button';
    const reset = el('button', 'btn ghost', 'Reset');
    reset.type = 'button';
    const use = el('button', 'btn primary', 'Use this photo');
    use.type = 'button';
    use.disabled = true;
    actions.append(reset, cancel, use);
    card.append(actions);

    backdrop.append(card);
    document.body.append(backdrop);

    let done = false;
    const close = (result) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    backdrop.onclick = (e) => { if (e.target === backdrop) close(null); };
    cancel.onclick = () => close(null);

    let img = null;
    // The visible frame, in source pixels, expressed as a scale plus an offset.
    let scale = 1;      // 1 = the whole of the shorter side fits the frame
    let offsetX = 0;    // top-left of the visible region, in source pixels
    let offsetY = 0;

    /** The source-pixel region currently framed. */
    const region = () => {
      const baseW = Math.min(img.width, img.height * aspect);
      const sw = baseW / scale;
      const sh = sw / aspect;
      return { sx: offsetX, sy: offsetY, sw, sh };
    };

    /** Keep the frame inside the photo, whatever the zoom or the drag did. */
    const clamp = () => {
      const { sw, sh } = region();
      offsetX = Math.min(Math.max(0, offsetX), Math.max(0, img.width - sw));
      offsetY = Math.min(Math.max(0, offsetY), Math.max(0, img.height - sh));
    };

    const draw = () => {
      const { sx, sy, sw, sh } = region();
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img.source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    };

    /** The preview canvas is sized to the box it is drawn in, times DPR. */
    const sizeCanvas = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = stage.clientWidth || 640;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round((width / aspect) * dpr);
    };

    const centre = () => {
      const { sw, sh } = region();
      offsetX = (img.width - sw) / 2;
      offsetY = (img.height - sh) / 2;
      clamp();
    };

    reset.onclick = () => {
      scale = 1;
      zoom.value = '1';
      centre();
      draw();
    };

    zoom.oninput = () => {
      const { sx, sy, sw, sh } = region();
      const cx = sx + sw / 2;
      const cy = sy + sh / 2;
      scale = Number(zoom.value);
      // Zoom about the middle of what is framed, not the corner of the photo.
      const next = region();
      offsetX = cx - next.sw / 2;
      offsetY = cy - next.sh / 2;
      clamp();
      draw();
    };

    // Drag to pan. Pointer events so a finger, a pen and a mouse are one path.
    let from = null;
    stage.addEventListener('pointerdown', (e) => {
      if (!img) return;
      from = { x: e.clientX, y: e.clientY, offsetX, offsetY };
      stage.setPointerCapture?.(e.pointerId);
      stage.classList.add('dragging');
    });
    stage.addEventListener('pointermove', (e) => {
      if (!from || !img) return;
      // A pixel on screen is (region width / canvas CSS width) source pixels.
      const perPixel = region().sw / (stage.clientWidth || 1);
      offsetX = from.offsetX - (e.clientX - from.x) * perPixel;
      offsetY = from.offsetY - (e.clientY - from.y) * perPixel;
      clamp();
      draw();
      if (e.cancelable) e.preventDefault();
    });
    const endDrag = () => {
      from = null;
      stage.classList.remove('dragging');
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    use.onclick = async () => {
      if (!img) return;
      use.disabled = true;
      use.textContent = 'Preparing…';
      try {
        const blob = await renderCrop(img, region(), aspect);
        const name = (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
        close(new File([blob], name, { type: 'image/jpeg' }));
      } catch (err) {
        hint.textContent = err.message || 'That image could not be prepared.';
        use.disabled = false;
        use.textContent = 'Use this photo';
      }
    };

    loadImage(file)
      .then((loaded) => {
        img = loaded;
        sizeCanvas();
        centre();
        draw();
        use.disabled = false;
        hint.textContent =
          `${img.width}×${img.height} · saved as a ${Math.min(MAX_OUTPUT_WIDTH, Math.round(region().sw))}px-wide JPEG`;
        window.addEventListener('resize', onResize);
      })
      .catch((err) => {
        hint.textContent = err.message;
      });

    const onResize = () => {
      if (!img || !backdrop.isConnected) {
        window.removeEventListener('resize', onResize);
        return;
      }
      sizeCanvas();
      draw();
    };
  });
}

/**
 * True when this browser can do the work at all.
 *
 * Everything here is 2010-era canvas plus File and toBlob, so this is really
 * only a guard for a very old WebView — the callers fall back to uploading
 * the file as chosen rather than refusing it.
 */
export function canCropImages() {
  return (
    typeof document !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.toBlob === 'function' &&
    typeof File === 'function' &&
    typeof FileReader === 'function'
  );
}
