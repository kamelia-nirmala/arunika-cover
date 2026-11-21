// PNG export for Arunika Cover. The preview canvas is whatever size the editor is showing, so export never reuses
// it: `renderCover` builds a fresh offscreen canvas at the requested export size and hands that to
// `drawCover(canvas, state)` from ./cover.js — that renderer works off the canvas it is given, so the same state
// paints a 1920×1080 poster or a 1080×1350 portrait with no extra scaling code here.
import { drawCover } from './cover.js';

/** The three poster sizes the app offers, in CSS label form for the size picker chips. */
export const SIZES = {
  wide: { w: 1920, h: 1080, ratio: '16:9', label: '16:9 · 1920 × 1080' },
  square: { w: 1080, h: 1080, ratio: '1:1', label: '1:1 · 1080 × 1080' },
  portrait: { w: 1080, h: 1350, ratio: '4:5', label: '4:5 · 1080 × 1350' },
};

/** Size used when the caller asks for an id that is not in SIZES. */
const FALLBACK_SIZE_ID = 'wide';

/** A font that never settles must not block the download forever. */
const FONT_TIMEOUT_MS = 2000;

/** Resolves an export size, falling back to `wide` for unknown ids. */
function resolveSize(sizeId) {
  return SIZES[sizeId] || SIZES[FALLBACK_SIZE_ID];
}

/**
 * Waits for the display face to be usable. `document.fonts.ready` resolves once every pending face settles; the
 * race keeps a broken font from hanging the export. Missing FontFaceSet (older/odd environments) is not an error.
 */
async function waitForFonts() {
  const fonts = typeof document !== 'undefined' ? document.fonts : null;
  if (!fonts || !fonts.ready) return;
  let timer = null;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, FONT_TIMEOUT_MS);
    });
    await Promise.race([fonts.ready, timeout]);
  } catch {
    // A rejected font-load promise is not worth failing the export over; the renderer's fallback face draws.
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Promise wrapper around the callback-shaped `canvas.toBlob`; rejects when the encoder returns null. */
function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas tidak menghasilkan PNG (toBlob mengembalikan null)'));
      }, 'image/png');
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Renders `state` onto a fresh offscreen canvas at the export size for `sizeId` and returns that canvas.
 * The canvas is detached from the DOM, which is all `drawCover` needs.
 */
export async function renderCover(state, sizeId) {
  const size = resolveSize(sizeId);

  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;

  await waitForFonts();

  drawCover(canvas, state);
  return canvas;
}

/**
 * Renders the cover at `sizeId`, encodes it as PNG and starts a browser download named
 * `arunika-cover-<w>x<h>.png`. Resolves with that file name once the click has been dispatched.
 */
export async function exportCover(state, sizeId) {
  const size = resolveSize(sizeId);
  const canvas = await renderCover(state, sizeId);

  const blob = await canvasToPngBlob(canvas);
  const url = URL.createObjectURL(blob);
  const filename = `arunika-cover-${size.w}x${size.h}.png`;

  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    // The anchor has to be in the document for the click to count as a user-agent download in some browsers.
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Revoking immediately can cancel the download in Safari/Firefox; one tick is enough for the click to take.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return filename;
}
