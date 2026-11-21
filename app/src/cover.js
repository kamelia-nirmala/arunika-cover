// Cover renderer: turns the app state into a multi-panel poster-style cover.
// Order matters: backdrop (navy sky + sun disc) -> photo panels with white borders -> colour grade -> caption
// and badges. Each step is a named function so the drawing order stays readable.

import { drawPhotoInPanel, computePhotoPlacement } from './photos.js';
import { applyGrade } from './grades.js';
import {
  drawCaption,
  drawBadges,
  drawPanelLabel,
  drawSeal,
  drawFooter,
  DEFAULT_PANEL_LABELS,
} from './caption.js';

const GAP = 0.015; // gutter between neighbouring panels, as a fraction of the cover
const BORDER_RATIO = 0.006; // panel border thickness, as a fraction of the cover width

// Below: layout table. Every rect is a fraction (0..1) of the cover, so one table serves every export size.
const STRIP_W = (1 - 2 * GAP) / 3; // three equal strips under the hero panel
const CELL = (1 - GAP) / 2; // one cell of the 2x2 grid

// Tilted ("miring") layout: inset panels with a wider gutter, so a rotated corner still has room on the cover
// and two neighbouring panels can never touch at the largest tilt (see TILT_DEGREES).
const TILT_MARGIN = 0.035;
const TILT_GAP = 0.05;
const TILT_CELL = (1 - 2 * TILT_MARGIN - TILT_GAP) / 2;
const TILT_DEGREES = [2.5, -3, 2.8, -2.4]; // alternating direction, kept inside ±2..3°

// Face-aware framing per panel slot. No detector runs offline, so the heuristic assumes the face sits in the upper
// third of the photo, horizontally centred: a box of FACE_SPAN tall by FACE_WIDE wide, centred on (FACE_X, FACE_Y).
// Each slot says how tight to crop and where that face centre should land inside its own panel, so one photo reads
// as full face / half body / close detail / wide instead of four copies.
const FACE_X = 0.5;
const FACE_Y = 0.28;
const FACE_SPAN = 0.18; // brows-to-chin, as a fraction of the photo height
const FACE_WIDE = 0.3; // temple-to-temple, as a fraction of the photo width
const FACE_MARGIN = 1.2; // headroom kept around that box, so no crop shaves the eyes or the chin
const PANEL_ROLES = [
  { zoom: 1, u: 0.5, v: 0.34 },      // 0 · wajah penuh  — loosest crop, face in the upper third
  { zoom: 1.32, u: 0.5, v: 0.32 },   // 1 · setengah badan — tighter, body filling the lower half
  { zoom: 1.7, u: 0.5, v: 0.42 },    // 2 · detail dekat — the tightest crop of the set
  { zoom: 1.12, u: 0.5, v: 0.46 },   // 3 · lebar        — loose and low, a wide establishing frame
];
// Small per-slot drift on the assumed face position, so panels of the same photo are not merely scaled copies.
const PANEL_DRIFT = [
  { x: 0, y: 0 },
  { x: 0.02, y: -0.03 },
  { x: -0.02, y: 0.04 },
  { x: 0.03, y: -0.02 },
];

export const LAYOUTS = {
  'hero-strip': {
    name: 'Hero + strip',
    panels: [
      { x: 0, y: 0, w: 1, h: 0.62 },
      { x: 0, y: 0.635, w: STRIP_W, h: 0.35 },
      { x: STRIP_W + GAP, y: 0.635, w: STRIP_W, h: 0.35 },
      { x: 2 * (STRIP_W + GAP), y: 0.635, w: STRIP_W, h: 0.35 },
    ],
  },
  grid: {
    name: 'Grid 2x2',
    panels: [
      { x: 0, y: 0, w: CELL, h: CELL },
      { x: CELL + GAP, y: 0, w: CELL, h: CELL },
      { x: 0, y: CELL + GAP, w: CELL, h: CELL },
      { x: CELL + GAP, y: CELL + GAP, w: CELL, h: CELL },
    ],
  },
  comic: {
    name: 'Comic columns',
    panels: [
      { x: 0, y: 0, w: STRIP_W, h: 1 },
      { x: STRIP_W + GAP, y: 0, w: STRIP_W, h: 1 },
      { x: 2 * (STRIP_W + GAP), y: 0, w: STRIP_W, h: 1 },
    ],
  },
  hero: {
    name: 'Single hero',
    panels: [{ x: 0, y: 0, w: 1, h: 1 }],
  },
  miring: {
    name: 'Miring (tilted)',
    // Same 2x2 rhythm as `grid`, but inset and spaced out so each panel can be rotated without clipping.
    tilt: TILT_DEGREES,
    panels: [
      { x: TILT_MARGIN, y: TILT_MARGIN, w: TILT_CELL, h: TILT_CELL },
      { x: TILT_MARGIN + TILT_CELL + TILT_GAP, y: TILT_MARGIN, w: TILT_CELL, h: TILT_CELL },
      { x: TILT_MARGIN, y: TILT_MARGIN + TILT_CELL + TILT_GAP, w: TILT_CELL, h: TILT_CELL },
      { x: TILT_MARGIN + TILT_CELL + TILT_GAP, y: TILT_MARGIN + TILT_CELL + TILT_GAP, w: TILT_CELL, h: TILT_CELL },
    ],
  },
};

const FALLBACK_LAYOUT = 'hero-strip';
const EMPTY_CROP = { zoom: 1, ox: 0, oy: 0 };
const NO_ADJUST = { contrast: 0, saturation: 0, warmth: 0 };

/** Converts one fractional rect to whole pixels, snapping its edges so neighbouring panels never overlap. */
function toPixelRect(rect, w, h) {
  const x0 = Math.min(w, Math.round(rect.x * w));
  const y0 = Math.min(h, Math.round(rect.y * h));
  const x1 = Math.min(w, Math.round((rect.x + rect.w) * w));
  const y1 = Math.min(h, Math.round((rect.y + rect.h) * h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Resolves a layout id to its panel table entry, falling back to the hero-strip layout. */
function resolveLayout(layoutId) {
  return LAYOUTS[layoutId] || LAYOUTS[FALLBACK_LAYOUT];
}

/** Panel rectangles in pixels for `layoutId`; unknown layouts fall back to 'hero-strip'. */
export function panelRects(layoutId, w, h) {
  return resolveLayout(layoutId).panels.map((rect) => toPixelRect(rect, w, h));
}

/** Clamps a number into 0..1, treating a missing/invalid value as the given fallback. */
function clampUnit(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** Clamps a number into [lo, hi]; a missing/non-finite value falls back to `lo`. */
function clamp(value, lo, hi) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Face-aware framing for panel `index`: solve the crop that puts the assumed face (FACE_X, FACE_Y — upper third,
 * horizontally centred, plus a small per-slot drift) at the slot's own focal point inside the panel.
 *
 * The maths is the inverse of computePhotoPlacement: the window a crop shows is
 *   ox = [u·rect.w − FACE_X·dw − (rect.w − dw)/2] / slackX
 * where dw/slackX follow from the crop zoom. The result is clamped to ±1, which is exactly the range that still
 * covers the panel — so no solution can ever leave a gap. A tall panel has no vertical slack at all and simply
 * saturates there.
 */
function framingFor(index, rect, imgW, imgH, zoom) {
  const role = PANEL_ROLES[index % PANEL_ROLES.length];
  const drift = PANEL_DRIFT[index % PANEL_DRIFT.length];
  const faceX = clamp(FACE_X + drift.x, 0.05, 0.95);
  const faceY = clamp(FACE_Y + drift.y, 0.05, 0.95);

  const scale = Math.max(rect.w / imgW, rect.h / imgH) * zoom;
  const dw = imgW * scale;
  const dh = imgH * scale;
  const slackX = Math.max(0, (dw - rect.w) / 2);
  const slackY = Math.max(0, (dh - rect.h) / 2);

  const axis = (want, face, size, drawn, slack) => (
    slack > 0
      ? clamp((want * size - face * drawn - (size - drawn) / 2) / slack, -1, 1)
      : 0
  );

  return {
    zoom,
    ox: axis(role.u, faceX, rect.w, dw, slackX),
    oy: axis(role.v, faceY, rect.h, dh, slackY),
  };
}

/**
 * Crop for one panel. The manual crop stored by the editor ({zoom, ox, oy} in state.panels) is the base: its zoom
 * multiplies the slot's role zoom, and a pan the user actually set is kept as-is. On top of that, the face-aware
 * solution places the assumed head at the slot's focal point — so an untouched axis (pan 0) is framed by the
 * heuristic, the four slots read as full face / half body / close detail / wide, and no two slots of the same photo
 * land on the same window.
 */
export function panelCrop(layoutId, index, rect, panel, imgW, imgH, zoomBias = 0) {
  const hasManual = Boolean(panel)
    && (panel.zoom !== undefined || panel.ox !== undefined || panel.oy !== undefined);
  const base = hasManual
    ? {
      zoom: clamp(Number(panel.zoom ?? 1), 1, 4),
      ox: clamp(Number(panel.ox ?? 0), -1, 1),
      oy: clamp(Number(panel.oy ?? 0), -1, 1),
    }
    : EMPTY_CROP;

  const role = PANEL_ROLES[index % PANEL_ROLES.length];
  const tilted = layoutId === 'miring';
  // Wide panels take the role zoom at full strength; tall ones already crop hard, so it is eased off.
  const aspect = rect.w > 0 && rect.h > 0 ? rect.w / rect.h : 1;
  const shape = clamp(0.94 + 0.06 * aspect, 0.94, 1.08);
  const roleZoom = 1 + (role.zoom - 1) * shape * (tilted ? 1.04 : 1);
  const boost = Math.max(0, zoomBias); // extra tightness asked for by the duplicate guard
  // The role zoom and the guard boost both scale the user's zoom, so a manual crop stays the base of the framing
  // instead of being overwritten by the heuristic.
  let factor = roleZoom + boost;

  const w = Number(imgW) || 0;
  const h = Number(imgH) || 0;
  // A zoom the user set is their call: the face headroom guard only limits the automatic framing, where it keeps
  // the assumed face (plus margin) inside the panel. Capping a manual zoom as well would flatten every panel of a
  // zoomed photo onto the same value — exactly the copy-paste look this layout is meant to avoid.
  const autoZoom = base.zoom <= 1;
  if (autoZoom && w > 0 && h > 0) {
    const fit = Math.max(rect.w / w, rect.h / h);
    const winH = rect.h / (h * fit); // fraction of the photo height visible at zoom 1
    const winW = rect.w / (w * fit);
    const maxZoom = Math.min(
      winH / (FACE_SPAN * FACE_MARGIN),
      winW / (FACE_WIDE * FACE_MARGIN),
    );
    factor = Math.min(factor, Math.max(1, maxZoom));
  }
  const zoom = clamp(base.zoom * factor, 1, 4);
  const framing = w > 0 && h > 0
    ? framingFor(index, rect, w, h, zoom)
    : { zoom, ox: 0, oy: 0 };

  // A hand-set pan is authoritative on its axis: the user already placed the face, so only a neutral (0) axis takes
  // the heuristic. Every slot still gets its own role zoom, which keeps the windows distinct on its own — and the
  // duplicate guard below covers the pathological cases.
  const pick = (manual, auto) => (manual !== 0 ? manual : clamp(auto, -1, 1));
  return {
    zoom,
    ox: pick(base.ox, framing.ox),
    oy: pick(base.oy, framing.oy),
  };
}

/**
 * The window a crop shows of the source image, as fractions of the image (0..1). Two panels with the same numbers
 * show exactly the same pixels — which is what drawCover refuses to let happen twice for one photo.
 */
export function cropWindow(rect, imgWidth, imgHeight, crop) {
  const place = computePhotoPlacement(rect, imgWidth, imgHeight, crop);
  if (!(place.dw > 0) || !(place.dh > 0)) return null;
  return {
    sx: (rect.x - place.dx) / place.dw,
    sy: (rect.y - place.dy) / place.dh,
    sw: rect.w / place.dw,
    sh: rect.h / place.dh,
  };
}

/**
 * Two windows read as the same crop when they overlap almost entirely. 0.97 is the line: above it the viewer sees
 * the same framing twice, which is exactly the copy-paste look N1 removes.
 */
const DUPLICATE_IOU = 0.97;

/** Overlap of two crop windows (source-image fractions) as intersection-over-union, 1 when identical. */
function windowIoU(a, b) {
  if (!a || !b) return 0;
  const iw = Math.min(a.sx + a.sw, b.sx + b.sw) - Math.max(a.sx, b.sx);
  const ih = Math.min(a.sy + a.sh, b.sy + b.sh) - Math.max(a.sy, b.sy);
  const inter = Math.max(0, iw) * Math.max(0, ih);
  const union = a.sw * a.sh + b.sw * b.sh - inter;
  return union > 0 ? inter / union : 1;
}

/** Signature for the window a crop shows, used as the cheap first check before the (costlier) IoU comparison. */
const WINDOW_STEP = 400; // 1/400 = 0.25% of the photo side

function windowKey(win) {
  if (!win) return '';
  const q = (v) => Math.round(clamp(v, 0, 1) * WINDOW_STEP);
  return [q(win.sx), q(win.sy), q(win.sw), q(win.sh)].join('|');
}

/** True when the crop window still sits inside the photo (no backdrop showing through the panel). */
function windowFits(rect, w, h, crop) {
  const win = cropWindow(rect, w, h, crop);
  if (!win) return false;
  const eps = 1e-6;
  return win.sx >= -eps && win.sy >= -eps
    && win.sx + win.sw <= 1 + eps && win.sy + win.sh <= 1 + eps;
}

/**
 * Alternative crops for a colliding panel, cheapest first: a few tighter zooms, then pans ordered by how far
 * they stray from the crop the user (or the role heuristic) chose. Ordering by distance keeps a manual pan as
 * intact as the duplicate guard allows.
 */
function variedCrops(layoutId, index, rect, panel, w, h, crop) {
  const out = [];
  for (let step = 1; step <= 6; step += 1) {
    out.push(panelCrop(layoutId, index, rect, panel, w, h, step * 0.08));
  }

  const axis = [];
  for (let v = -1; v <= 1.0001; v += 0.05) axis.push(Math.round(v * 100) / 100);
  const pairs = [];
  axis.forEach((ox) => axis.forEach((oy) => {
    const cost = Math.abs(ox - crop.ox) + Math.abs(oy - crop.oy);
    if (cost > 0) pairs.push({ ox, oy, cost });
  }));
  pairs.sort((a, b) => a.cost - b.cost || a.ox - b.ox || a.oy - b.oy);
  pairs.forEach(({ ox, oy }) => out.push({ zoom: crop.zoom, ox, oy }));

  // Last resort for a photo with slack on neither axis: tighten the user's own zoom a notch, which always widens
  // the visible window and so always differs from the window it collided with.
  for (let step = 1; step <= 3; step += 1) {
    out.push({ zoom: clamp(crop.zoom * (1 + step * 0.06), 1, 4), ox: crop.ox, oy: crop.oy });
  }
  return out;
}

/**
 * Crop for a panel that is guaranteed to differ from every earlier panel showing the same photo. The role framing
 * is tried first; if its window collides (a manual crop pinning the panel, or a panel shape whose slack collapses
 * the pan), the zoom and then the pan are nudged until a genuinely different frame is found. `seen` holds the
 * windows already used for this photo on the current cover.
 */
function uniquePanelCrop(layoutId, index, rect, panel, photo, seen) {
  const w = photo ? Number(photo.naturalWidth) : 0;
  const h = photo ? Number(photo.naturalHeight) : 0;
  const crop = panelCrop(layoutId, index, rect, panel, w, h);
  if (!(w > 0) || !(h > 0)) return crop;

  // A window is "taken" when it overlaps an existing one almost exactly — an identical key is only the fast path.
  const clashes = (win) => {
    if (!win) return false;
    if (seen.keys.has(windowKey(win))) return true;
    return seen.windows.some((other) => windowIoU(win, other) >= DUPLICATE_IOU);
  };
  const take = (win) => {
    seen.keys.add(windowKey(win));
    seen.windows.push(win);
  };

  const base = cropWindow(rect, w, h, crop);
  if (!clashes(base)) {
    take(base);
    return crop;
  }

  for (const candidate of variedCrops(layoutId, index, rect, panel, w, h, crop)) {
    if (!windowFits(rect, w, h, candidate)) continue;
    const win = cropWindow(rect, w, h, candidate);
    if (clashes(win)) continue;
    take(win);
    return candidate;
  }

  // Every distinct framing is taken (only reachable with a photo whose slack is zero on both axes).
  take(base);
  return crop;
}

/** The window bookkeeping for one photo, created on first use. */
function seenFor(map, photo) {
  let seen = map.get(photo);
  if (!seen) {
    seen = { keys: new Set(), windows: [] };
    map.set(photo, seen);
  }
  return seen;
}

/** The top band of a layout (its first row of panels) — the area the sun disc sits in, and where the title anchors. */
export function heroBandFor(layoutId) {
  return heroBand(LAYOUTS[layoutId] ? layoutId : FALLBACK_LAYOUT);
}

function heroBand(layoutId) {
  const panels = resolveLayout(layoutId).panels;
  let top = Infinity;
  for (const p of panels) top = Math.min(top, p.y);
  const row = panels.filter((p) => p.y === top);
  const left = Math.min(...row.map((p) => p.x));
  const right = Math.max(...row.map((p) => p.x + p.w));
  const bottom = Math.max(...row.map((p) => p.y + p.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Paints the navy-violet sky and the soft sun disc burning in the top-right of the hero area. */
function drawSunsetBackdrop(ctx, w, h, layoutId) {
  ctx.save();
  ctx.fillStyle = '#1a0b2e';
  ctx.fillRect(0, 0, w, h);

  const band = heroBand(layoutId);
  const cx = (band.x + band.w * 0.78) * w;
  const cy = (band.y + band.h * 0.3) * h;
  const radius = w * 0.45;
  const sun = ctx.createRadialGradient(cx, cy, Math.max(1, radius * 0.04), cx, cy, radius);
  sun.addColorStop(0, 'rgba(255, 216, 156, 0.95)');
  sun.addColorStop(0.32, 'rgba(255, 138, 74, 0.6)');
  sun.addColorStop(0.66, 'rgba(210, 58, 128, 0.24)');
  sun.addColorStop(1, 'rgba(26, 11, 46, 0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Picks the drawable image for a panel entry, or null when the slot is empty (-1 / no photo). */
function resolvePanelPhoto(photos, photoIndex) {
  if (!Array.isArray(photos) || !Number.isInteger(photoIndex) || photoIndex < 0) return null;
  const entry = photos[photoIndex];
  if (!entry) return null;
  // state.photos holds { img, name }; accept a bare image too so a stray caller still draws something.
  if (entry.img) return entry.img;
  return typeof entry === 'object' && entry.naturalWidth ? entry : null;
}

/** Outline drawn inside the panel bounds so the white frame stays crisp on every export size. */
function strokePanelBorder(ctx, rect, coverWidth) {
  const line = Math.max(1, coverWidth * BORDER_RATIO);
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = line;
  ctx.strokeRect(rect.x + line / 2, rect.y + line / 2, Math.max(0, rect.w - line), Math.max(0, rect.h - line));
  ctx.restore();
}

/**
 * Draws one panel: the cropped photo (or the placeholder when empty) plus its frame, then its role label.
 * `tilt` rotates the whole panel (photo + frame + label) around its centre; the clip is applied inside that rotated
 * space, so the rotated rectangle stays crisp instead of showing a rotated square of backdrop.
 */
function drawPanel(ctx, rect, coverWidth, coverHeight, photo, crop, tilt, label, lift, insetX) {
  const degrees = typeof tilt === 'number' && Number.isFinite(tilt) ? tilt : 0;
  if (degrees !== 0) {
    ctx.save();
    ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
    ctx.rotate((degrees * Math.PI) / 180);
    ctx.translate(-(rect.x + rect.w / 2), -(rect.y + rect.h / 2));
    drawPhotoInPanel(ctx, photo, rect, crop);
    strokePanelBorder(ctx, rect, coverWidth);
    drawPanelLabel(ctx, rect, label, coverHeight, lift, insetX);
    ctx.restore();
    return;
  }
  drawPhotoInPanel(ctx, photo, rect, crop);
  strokePanelBorder(ctx, rect, coverWidth);
  drawPanelLabel(ctx, rect, label, coverHeight, lift, insetX);
}

/** Tilt in degrees for panel `index` of a layout, or 0 for the untilted layouts. */
function panelTilt(layoutId, index) {
  const layout = resolveLayout(layoutId);
  if (!Array.isArray(layout.tilt) || !layout.tilt.length) return 0;
  const value = layout.tilt[index % layout.tilt.length];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The role label for panel `index`: the panel's own text, else the default for that slot. */
function panelLabelFor(index, panel) {
  if (panel && typeof panel.label === 'string') {
    // An explicitly cleared label stays cleared; only a missing one falls back to the slot default.
    return panel.label;
  }
  return DEFAULT_PANEL_LABELS[index % DEFAULT_PANEL_LABELS.length];
}

/** Renders the whole cover from `state` onto `canvas` (the canvas supplies its own pixel size). */
export function drawCover(canvas, state) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const s = state || {};

  const layoutId = LAYOUTS[s.layout] ? s.layout : FALLBACK_LAYOUT;
  const rects = panelRects(layoutId, w, h);
  const panels = Array.isArray(s.panels) ? s.panels : [];
  // One window bag per photo: two panels must never show the same frame of the same source image. A panel with no
  // photo (or one that has not decoded yet) is skipped by uniquePanelCrop, so an empty slot never claims a window.
  const seenByPhoto = new Map();

  drawSunsetBackdrop(ctx, w, h, layoutId);

  rects.forEach((rect, index) => {
    const panel = panels[index] || null;
    const photo = resolvePanelPhoto(s.photos, panel ? panel.photo : -1);
    const crop = uniquePanelCrop(layoutId, index, rect, panel, photo, seenFor(seenByPhoto, photo));
    // The volume pill lives in the cover's top-left corner, so a panel that owns that corner starts its label lower
    // and lines it up with the pill's left edge.
    const ownsCorner = rect.x <= w * 0.05 && rect.y <= h * 0.05;
    const lift = ownsCorner ? h * 0.075 : 0;
    const insetX = ownsCorner ? w * 0.03 : 0;
    drawPanel(
      ctx,
      rect,
      w,
      h,
      photo,
      crop,
      panelTilt(layoutId, index),
      panelLabelFor(index, panel),
      lift,
      insetX,
    );
  });

  applyGrade(
    ctx,
    w,
    h,
    s.gradeId || 'sunset',
    clampUnit(s.gradeStrength, 1),
    s.adjust || NO_ADJUST,
  );

  // Drawn after the grade so the type stays white and sharp on top of the tinted artwork. The title sits on the
  // hero image itself (no band), so it is painted straight over the artwork the grade just tinted.
  const band = heroBand(layoutId);
  drawSeal(ctx, w, h, band, s.seal);
  drawCaption(ctx, w, h, s, band);
  drawFooter(ctx, w, h, s);
  drawBadges(ctx, w, h, s);
}
