// Photo plumbing for the cover: loading files and URLs into images, and painting one image into a panel rect
// with cover-fit, zoom and pan. Pan is a fraction (-1..1) of the slack between the scaled image and the rect,
// so 0 is centred and the image can never slide inside the panel and leave a gap.

/** The sample photos shipped with the app; `src` is relative to app/. */
export const SAMPLE_PHOTOS = [
  { id: 'pier', name: 'Dermaga Senja', src: 'samples/pier.jpg' },
  { id: 'boulevard', name: 'Boulevard', src: 'samples/boulevard.jpg' },
];

/** Loads a <input type="file"> File as an image, freeing the object URL once it has decoded. */
export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('loadImageFile: no file given'));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ img, name: file.name });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`loadImageFile: could not decode "${file.name}"`));
    };
    img.src = url;
  });
}

/** Loads an image from a URL and resolves once it can be drawn. */
export function loadImageUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`loadImageUrl: could not load "${url}"`));
    img.src = url;
  });
}

function positiveOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clamp(n, min, max) {
  return n < min ? min : n > max ? max : n;
}

/**
 * Pure cover-fit maths: where the scaled image lands inside `rect` ({x, y, w, h}).
 * Returns {dx, dy, dw, dh}; dx/dy are the top-left corner in the same space as rect.
 */
export function computePhotoPlacement(rect, imgWidth, imgHeight, crop = {}) {
  const zoom = positiveOr(crop.zoom, 1);
  const ox = clamp(Number(crop.ox) || 0, -1, 1);
  const oy = clamp(Number(crop.oy) || 0, -1, 1);
  const scale = Math.max(rect.w / imgWidth, rect.h / imgHeight) * zoom;
  const dw = imgWidth * scale;
  const dh = imgHeight * scale;
  // Half the overflow on each axis: the furthest the image may travel before an edge shows.
  const slackX = Math.max(0, (dw - rect.w) / 2);
  const slackY = Math.max(0, (dh - rect.h) / 2);
  return {
    dx: rect.x + (rect.w - dw) / 2 + ox * slackX,
    dy: rect.y + (rect.h - dh) / 2 + oy * slackY,
    dw,
    dh,
  };
}

/** Paints the "no photo yet" tile: a dark purple-to-black gradient plus a small centred hint. */
function drawEmptyPanel(ctx, rect) {
  const shade = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.h);
  shade.addColorStop(0, '#3a2150');
  shade.addColorStop(1, '#0b0610');
  ctx.fillStyle = shade;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  const size = clamp(Math.min(rect.w, rect.h) * 0.055, 10, 22);
  ctx.save();
  ctx.font = `600 ${size}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.fillText('TAMBAH FOTO', rect.x + rect.w / 2, rect.y + rect.h / 2);
  ctx.restore();
}

/**
 * Draws `img` into `rect` ({x, y, w, h}) of `ctx`, cover-fitted, cropped by {zoom, ox, oy}.
 * A missing or unusable image draws the empty-panel placeholder instead.
 */
export function drawPhotoInPanel(ctx, img, rect, crop = {}) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  const w = img ? Number(img.naturalWidth) : 0;
  const h = img ? Number(img.naturalHeight) : 0;
  if (!img || !(w > 0) || !(h > 0)) {
    drawEmptyPanel(ctx, rect);
    ctx.restore();
    return;
  }

  const { dx, dy, dw, dh } = computePhotoPlacement(rect, w, h, crop);
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}
