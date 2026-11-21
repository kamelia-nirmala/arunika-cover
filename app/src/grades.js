// Colour grading for the cover. drawCover() calls applyGrade() once, over the whole canvas, after the
// photo panels are painted and before the caption, so the type stays white on top of the tinted art.
//
// The pass has four steps, in this order:
//   1. base adjustments (contrast / saturation / warmth) — needs a filter round-trip through an offscreen canvas
//   2. the grade's own overlay (sunset wash, neon duotone, golden wash, vice duotone ...)
//   3. vignette
//   4. fine grain
// Every effect scales with `strength` (0..1); at 0 only the manual adjustments still apply.
// All artwork here is generated at runtime from gradients and random noise — no external images.

/** The grades offered by the editor, in picker order. */
export const GRADES = [
  { id: 'sunset', name: 'Sunset' },
  { id: 'neon', name: 'Neon' },
  { id: 'noir', name: 'Noir' },
  { id: 'golden', name: 'Golden Hour' },
  { id: 'vice', name: 'Vice' },
  { id: 'teal-orange', name: 'Teal Orange' },
  { id: 'mono', name: 'Mono' },
  { id: 'sepia', name: 'Sepia' },
  { id: 'cyberpunk', name: 'Cyberpunk' },
  { id: 'pastel', name: 'Pastel' },
];

const DEFAULT_GRADE = 'sunset';
const NO_ADJUST = { contrast: 0, saturation: 0, warmth: 0 };

const WARMTH_ALPHA_MAX = 0.25; // strongest warm/cool cast, at |warmth| = 100 and strength = 1
const VIGNETTE_ALPHA = 0.35; // corner darkness at strength = 1, the same ceiling for every grade
const NOIR_VIGNETTE_INNER = 0.12; // noir starts its falloff nearer the centre, so the corners read darker
const DEFAULT_VIGNETTE_INNER = 0.35; // ...while the coloured grades keep a wide clear middle
const GRAIN_ALPHA = 0.05; // grain opacity at strength = 1
const MAX_SCRATCH_CANVASES = 12; // offscreen canvases cached by size (preview + export sizes)

/**
 * The baked part of each grade, on top of the overlays painted below: the contrast / saturation / warmth
 * it adds to the manual sliders, an optional ctx.filter pass (`filter` is a function of strength, so a
 * half-strength grade stays half-applied), a grain multiplier and its own vignette falloff.
 * The five original grades paint only their overlay — noir's entry here replaces the old hard-coded
 * grayscale check in buildFilter(), so its look is unchanged.
 */
const GRADE_PRESETS = {
  noir: {
    tone: NO_ADJUST,
    filter: () => 'grayscale(1) contrast(1.15)',
    grain: 1,
    vignetteInner: NOIR_VIGNETTE_INNER,
  },
  'teal-orange': {
    tone: { contrast: 12, saturation: 10, warmth: 18 },
    grain: 1.1,
    vignetteInner: 0.3,
  },
  mono: {
    tone: { contrast: 16, saturation: 0, warmth: 0 },
    filter: (s) => `grayscale(${s.toFixed(3)}) contrast(${(1 + 0.18 * s).toFixed(3)})`,
    grain: 1.35,
    vignetteInner: 0.2,
  },
  sepia: {
    tone: { contrast: 6, saturation: -12, warmth: 30 },
    filter: (s) => `sepia(${(0.85 * s).toFixed(3)})`,
    grain: 1.4,
    vignetteInner: 0.24,
  },
  cyberpunk: {
    tone: { contrast: 18, saturation: 26, warmth: -14 },
    grain: 1.1,
    vignetteInner: 0.28,
  },
  pastel: {
    tone: { contrast: -14, saturation: -18, warmth: 8 },
    filter: (s) => `contrast(${(1 - 0.12 * s).toFixed(3)}) saturate(${(1 - 0.1 * s).toFixed(3)})`,
    grain: 0.55,
    vignetteInner: 0.45,
  },
};

// Offscreen canvases reused across redraws, keyed "<purpose>:<w>x<h>". A null value means "could not
// build one here" and is cached too, so a browser without any canvas support is not retried every frame.
const scratchCanvases = new Map();

/* ---------- small numeric helpers ---------- */

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return n < min ? min : n > max ? max : n;
}

/** Strength clamped into 0..1; a missing or non-numeric value falls back to 1 (full grade). */
export function clampStrength(value) {
  return clamp(toNumber(value, 1), 0, 1);
}

/** Maps an unknown/empty grade id onto a grade we can draw. Exported so the fallback is testable. */
export function resolveGradeId(gradeId) {
  return GRADES.some((grade) => grade.id === gradeId) ? gradeId : DEFAULT_GRADE;
}

/** Every adjustment clamped into -100..100; missing pieces become 0. */
export function normalizeAdjust(adjust) {
  const a = adjust && typeof adjust === 'object' ? adjust : NO_ADJUST;
  return {
    contrast: clamp(toNumber(a.contrast, 0), -100, 100),
    saturation: clamp(toNumber(a.saturation, 0), -100, 100),
    warmth: clamp(toNumber(a.warmth, 0), -100, 100),
  };
}

/** A grade's baked tone faded by `strength` (0 -> neutral), so a half-strength grade is half-baked. */
function scaleTone(tone, strength) {
  if (!tone) return NO_ADJUST;
  return {
    contrast: tone.contrast * strength,
    saturation: tone.saturation * strength,
    warmth: tone.warmth * strength,
  };
}

/** Manual sliders plus the grade's baked tone, clamped back into the slider range. */
function combineTone(manual, baked) {
  return {
    contrast: clamp(manual.contrast + baked.contrast, -100, 100),
    saturation: clamp(manual.saturation + baked.saturation, -100, 100),
    warmth: clamp(manual.warmth + baked.warmth, -100, 100),
  };
}

/* ---------- offscreen canvases ---------- */

function createCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') {
    try {
      return new OffscreenCanvas(w, h);
    } catch {
      /* fall through to a DOM canvas */
    }
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      return canvas;
    } catch {
      /* no canvas available in this environment */
    }
  }
  return null;
}

/** Cached offscreen canvas for `purpose` at this exact size; `build` runs only on the first request. */
function getScratchCanvas(purpose, w, h, build) {
  const key = `${purpose}:${w}x${h}`;
  if (scratchCanvases.has(key)) return scratchCanvases.get(key);

  const canvas = build(w, h);
  // Cheap eviction: the cache only ever holds a handful of export sizes, so clear it when it grows.
  if (scratchCanvases.size >= MAX_SCRATCH_CANVASES) scratchCanvases.clear();
  scratchCanvases.set(key, canvas);
  return canvas;
}

/**
 * Runs a canvas filter over the whole cover: copy the canvas into a scratch surface, then draw that copy
 * back through ctx.filter. Returns false (cover untouched) when no scratch surface is available.
 */
function applyFilterPass(ctx, w, h, filter) {
  const source = ctx.canvas;
  if (!source) return false;

  const scratch = getScratchCanvas('filter', w, h, createCanvas);
  if (!scratch) return false;

  const sctx = scratch.getContext('2d');
  if (!sctx || typeof sctx.drawImage !== 'function') return false;

  try {
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(source, 0, 0, w, h);

    ctx.save();
    ctx.filter = filter;
    // 'copy' replaces the canvas with the filtered copy instead of blending on top of the unfiltered pixels.
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(scratch, 0, 0, w, h);
    ctx.restore();
    return true;
  } catch {
    return false; // the unfiltered cover is still on screen, which beats a blank one
  }
}

/* ---------- step 1: base adjustments ---------- */

/** Builds the ctx.filter string for this call, or '' when nothing needs a filter round-trip. */
function buildFilter(gradeId, tone, strength) {
  const parts = [];
  // An identity "contrast(100%) saturate(100%)" pass would only cost a full-canvas copy, so skip it.
  if (tone.contrast !== 0 || tone.saturation !== 0) {
    parts.push(`contrast(${100 + tone.contrast}%) saturate(${100 + tone.saturation}%)`);
  }
  // Grades that are defined by a filter (noir's grayscale, mono's, sepia's) ride the same offscreen pass,
  // after the manual adjustments. Their filter builder takes `strength` so a partial grade stays partial.
  const preset = GRADE_PRESETS[gradeId];
  if (preset && typeof preset.filter === 'function' && strength > 0) parts.push(preset.filter(strength));
  return parts.join(' ');
}

/**
 * Warm (orange) or cool (blue) cast, painted as an overlay so midtones keep shape.
 * `warmth` is the finished, clamped value (-100..100) that combineTone() already faded: the manual slider
 * contributes all of it and a grade's baked warmth only `strength` of it, so scaling here again would fade
 * the slider's own warmth twice and wipe it out completely at strength 0.
 */
function drawWarmthCast(ctx, w, h, warmth) {
  if (!warmth) return;
  const alpha = (Math.abs(warmth) / 100) * WARMTH_ALPHA_MAX;
  if (alpha <= 0) return;

  const rgb = warmth > 0 ? '255, 140, 40' : '60, 120, 255';
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = alpha; // absolute: `strength` is already baked into the value
  ctx.fillStyle = `rgb(${rgb})`;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/* ---------- step 2: the grade overlays ---------- */

/** Sunset: a full-frame warm tint, a warm-to-hot vertical wash rising from the bottom, plus a top-right glow. */
function drawSunsetLook(ctx, w, h, strength) {
  ctx.save();
  ctx.globalAlpha = strength;

  // Full-frame orange-to-magenta tint, so a bright midday photo (turquoise sea, blue sky) turns warm all over
  // instead of only along the bottom. Two passes of the same vertical gradient:
  //   'soft-light' keeps every highlight and shadow readable while pushing the hue,
  //   'color' at low alpha pulls the remaining blue fully towards orange without touching luminance.
  // Without the 'color' pass a saturated turquoise stays bluer than it is warm and the grade reads as daylight.
  const tint = ctx.createLinearGradient(0, 0, 0, h);
  tint.addColorStop(0, 'rgb(255, 140, 30)');
  tint.addColorStop(0.55, 'rgb(255, 90, 70)');
  tint.addColorStop(1, 'rgb(200, 40, 135)');

  ctx.globalCompositeOperation = 'soft-light';
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = 'color';
  ctx.globalAlpha = strength * 0.3; // hue only: luminance (and so the photo's detail) stays put
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = strength;

  const wash = ctx.createLinearGradient(0, h * 0.35, 0, h);
  wash.addColorStop(0, 'rgba(255, 120, 60, 0)');
  wash.addColorStop(0.6, 'rgba(255, 95, 95, 0.26)');
  wash.addColorStop(1, 'rgba(255, 60, 140, 0.55)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);

  const glowX = w * 0.82;
  const glowY = h * 0.16;
  const glow = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, Math.max(w, h) * 0.55);
  glow.addColorStop(0, 'rgba(255, 170, 90, 0.25)');
  glow.addColorStop(1, 'rgba(255, 170, 90, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

/** Neon: magenta half / cyan half duotone with a diagonal sweep so the two sides bleed into each other. */
function drawNeonLook(ctx, w, h, strength) {
  ctx.save();
  ctx.globalAlpha = strength;
  ctx.globalCompositeOperation = 'overlay';

  const half = w / 2;
  ctx.fillStyle = 'rgba(255, 0, 140, 0.18)';
  ctx.fillRect(0, 0, half, h);
  ctx.fillStyle = 'rgba(0, 220, 255, 0.18)';
  ctx.fillRect(half, 0, w - half, h);

  const sweep = ctx.createLinearGradient(0, 0, w, h);
  sweep.addColorStop(0, 'rgba(0, 220, 255, 0.15)');
  sweep.addColorStop(0.5, 'rgba(140, 90, 255, 0.12)');
  sweep.addColorStop(1, 'rgba(255, 0, 140, 0.15)');
  ctx.fillStyle = sweep;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

/** Noir needs no colour of its own — the grayscale filter pass does the work; the vignette is heavier. */
function drawNoirLook() {
  /* intentionally empty: see buildFilter() and drawVignette() */
}

/** Golden hour: a flat gold wash plus a soft warm glow high in the middle of the frame. */
function drawGoldenLook(ctx, w, h, strength) {
  ctx.save();
  ctx.globalAlpha = strength;

  ctx.fillStyle = 'rgba(255, 190, 80, 0.22)';
  ctx.fillRect(0, 0, w, h);

  const cx = w * 0.5;
  const cy = h * 0.18;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.6);
  glow.addColorStop(0, 'rgba(255, 235, 150, 0.3)');
  glow.addColorStop(1, 'rgba(255, 235, 150, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

/** Vice: pink-to-teal duotone across the diagonal, blended so the hues tint whatever is underneath. */
function drawViceLook(ctx, w, h, strength) {
  ctx.save();
  ctx.globalAlpha = strength;
  ctx.globalCompositeOperation = 'overlay';

  const sweep = ctx.createLinearGradient(0, 0, w, h);
  sweep.addColorStop(0, 'rgba(255, 45, 149, 0.2)');
  sweep.addColorStop(1, 'rgba(0, 200, 200, 0.2)');
  ctx.fillStyle = sweep;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

/**
 * Teal Orange: the blockbuster split — cyan pushed into the shadows and a hot orange wash over the
 * highs, meeting along a horizontal horizon band. 'color' carries the hue, 'soft-light' the punch.
 */
function drawTealOrangeLook(ctx, w, h, strength) {
  ctx.save();
  ctx.globalAlpha = strength;

  // Cool teal from the top of frame down to the horizon band.
  const teal = ctx.createLinearGradient(0, 0, 0, h);
  teal.addColorStop(0, 'rgba(0, 128, 145, 0.55)');
  teal.addColorStop(0.45, 'rgba(0, 100, 120, 0.3)');
  teal.addColorStop(0.62, 'rgba(0, 90, 110, 0)');
  teal.addColorStop(1, 'rgba(0, 0, 0, 0)');

  ctx.globalCompositeOperation = 'color';
  ctx.globalAlpha = strength * 0.45;
  ctx.fillStyle = teal;
  ctx.fillRect(0, 0, w, h);

  // Warm orange from the horizon band down to the bottom edge.
  const orange = ctx.createLinearGradient(0, h * 0.45, 0, h);
  orange.addColorStop(0, 'rgba(255, 140, 40, 0)');
  orange.addColorStop(0.5, 'rgba(255, 145, 55, 0.34)');
  orange.addColorStop(1, 'rgba(255, 110, 30, 0.55)');

  ctx.globalCompositeOperation = 'soft-light';
  ctx.globalAlpha = strength;
  ctx.fillStyle = orange;
  ctx.fillRect(0, 0, w, h);

  // A tight warm highlight where the two halves meet, so the horizon reads as backlit.
  const band = ctx.createLinearGradient(0, h * 0.42, 0, h * 0.62);
  band.addColorStop(0, 'rgba(255, 190, 120, 0)');
  band.addColorStop(0.5, 'rgba(255, 190, 120, 0.16)');
  band.addColorStop(1, 'rgba(255, 190, 120, 0)');
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

/**
 * Mono is a split-toned black-and-white print rather than a flat desaturate: the grayscale filter pass
 * removes the colour, then a cool-to-warm duotone ramp is blended back over it — cyan in the shadows,
 * a faint warm tone in the highlights. 'color' carries the hue at low alpha so luminance (and therefore all
 * the print's detail) survives; that is what separates mono from noir, which stays neutral.
 */
function drawMonoLook(ctx, w, h, strength) {
  ctx.save();

  // Duotone ramp down the frame: cool shadows at the top, warm highlights at the bottom.
  const duotone = ctx.createLinearGradient(0, 0, 0, h);
  duotone.addColorStop(0, 'rgb(70, 110, 150)');
  duotone.addColorStop(0.5, 'rgb(150, 150, 148)');
  duotone.addColorStop(1, 'rgb(215, 195, 160)');

  ctx.globalCompositeOperation = 'color';
  ctx.globalAlpha = strength * 0.3; // hue only: the grayscale pass keeps the tones
  ctx.fillStyle = duotone;
  ctx.fillRect(0, 0, w, h);

  // A faint 'soft-light' pass of the same ramp adds the print's contrast without flattening it.
  ctx.globalCompositeOperation = 'soft-light';
  ctx.globalAlpha = strength * 0.25;
  ctx.fillStyle = duotone;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

/** Sepia: an aged-paper wash plus a soft warm bloom, so the frame looks printed rather than merely brown. */
function drawSepiaLook(ctx, w, h, strength) {
  ctx.save();

  ctx.globalAlpha = strength * 0.4;
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgb(238, 214, 176)';
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = 'source-over';
  const bloom = ctx.createRadialGradient(w * 0.5, h * 0.4, 0, w * 0.5, h * 0.4, Math.max(w, h) * 0.7);
  bloom.addColorStop(0, 'rgba(255, 233, 195, 0.22)');
  bloom.addColorStop(1, 'rgba(255, 233, 195, 0)');
  ctx.globalAlpha = strength;
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

/**
 * Cyberpunk: magenta lows against cyan highlights, split diagonally, plus a faint scanline comb so the
 * frame reads as a screen rather than a photo.
 */
function drawCyberpunkLook(ctx, w, h, strength) {
  ctx.save();
  ctx.globalAlpha = strength;
  ctx.globalCompositeOperation = 'overlay';

  const magenta = ctx.createLinearGradient(0, h, w, 0);
  magenta.addColorStop(0, 'rgba(255, 0, 160, 0.32)');
  magenta.addColorStop(0.5, 'rgba(180, 40, 255, 0.1)');
  magenta.addColorStop(1, 'rgba(255, 0, 160, 0)');
  ctx.fillStyle = magenta;
  ctx.fillRect(0, 0, w, h);

  const cyan = ctx.createLinearGradient(w, 0, 0, h);
  cyan.addColorStop(0, 'rgba(0, 240, 255, 0.3)');
  cyan.addColorStop(0.5, 'rgba(0, 200, 255, 0.08)');
  cyan.addColorStop(1, 'rgba(0, 240, 255, 0)');
  ctx.fillStyle = cyan;
  ctx.fillRect(0, 0, w, h);

  // Scanlines: one dark hairline every 4px of a reference 1080-high frame, scaled with the canvas.
  ctx.globalCompositeOperation = 'source-over';
  const step = Math.max(3, Math.round((h / 1080) * 5));
  ctx.globalAlpha = strength * 0.14;
  ctx.fillStyle = 'rgb(0, 0, 0)';
  for (let y = 0; y < h; y += step) ctx.fillRect(0, y, w, Math.max(1, step / 4));

  ctx.restore();
}

/** Pastel: a pale lavender-to-peach veil that lifts the blacks and mutes the saturation. */
function drawPastelLook(ctx, w, h, strength) {
  ctx.save();

  const veil = ctx.createLinearGradient(0, 0, w, h);
  veil.addColorStop(0, 'rgba(198, 214, 255, 0.34)');
  veil.addColorStop(0.5, 'rgba(255, 214, 235, 0.3)');
  veil.addColorStop(1, 'rgba(255, 232, 200, 0.34)');

  // 'screen' lifts the shadows into milky pastel instead of tinting them; alpha keeps detail visible.
  ctx.globalAlpha = strength * 0.55;
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = strength * 0.18;
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

const GRADE_PAINTERS = {
  sunset: drawSunsetLook,
  neon: drawNeonLook,
  noir: drawNoirLook,
  golden: drawGoldenLook,
  vice: drawViceLook,
  'teal-orange': drawTealOrangeLook,
  mono: drawMonoLook,
  sepia: drawSepiaLook,
  cyberpunk: drawCyberpunkLook,
  pastel: drawPastelLook,
};

/** Paints the overlay for `gradeId` (already resolved to a known id). */
function drawGradeLook(ctx, w, h, gradeId, strength) {
  const painter = GRADE_PAINTERS[gradeId] || GRADE_PAINTERS[DEFAULT_GRADE];
  painter(ctx, w, h, strength);
}

/* ---------- step 3: vignette ---------- */

/** Darkens the corners evenly; `strength` scales the darkness and `inner` sets where the falloff starts. */
function drawVignette(ctx, w, h, strength, inner) {
  const alpha = clamp(VIGNETTE_ALPHA * strength, 0, 1);
  if (alpha <= 0) return;

  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.hypot(w, h) / 2; // reaches the corners
  const shade = ctx.createRadialGradient(cx, cy, Math.max(1, radius * inner), cx, cy, radius);
  shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
  shade.addColorStop(1, `rgba(0, 0, 0, ${alpha.toFixed(3)})`);

  ctx.save();
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/* ---------- step 4: grain ---------- */

/** True when a Uint32Array writes bytes in little-endian order (every common platform, but not assumed). */
function isLittleEndian() {
  const probe = new Uint32Array([1]);
  return new Uint8Array(probe.buffer)[0] === 1;
}

/** Packs an opaque mid-grey level into the 32-bit word the Uint32Array view expects for this machine. */
function packGrey(level, littleEndian) {
  // Opaque alpha plus the same level in R, G and B; byte order decides whether R is the high or low byte.
  const rgb = (level << 16) | (level << 8) | level;
  return littleEndian ? 0xff000000 | rgb : ((rgb << 8) | 0xff) >>> 0;
}

/** One-off noise tile: mid-grey pixels jittered around neutral, so 'overlay' only adds texture. */
function buildNoise(w, h) {
  const canvas = createCanvas(w, h);
  if (!canvas) return null;

  const nctx = canvas.getContext('2d');
  if (!nctx || typeof nctx.createImageData !== 'function') return null;

  try {
    const image = nctx.createImageData(w, h);
    // One random sample per pixel, written as a 32-bit word: far fewer ops than four byte writes.
    const pixels = new Uint32Array(image.data.buffer);
    const littleEndian = isLittleEndian();
    for (let i = 0; i < pixels.length; i += 1) {
      const level = 96 + ((Math.random() * 64) | 0); // 96..159, mid-grey keeps overlay neutral
      pixels[i] = packGrey(level, littleEndian);
    }
    nctx.putImageData(image, 0, 0);
    return canvas;
  } catch {
    return null;
  }
}

/** Lays the cached noise tile over the cover at very low opacity; skipped silently if noise is unavailable. */
function drawGrain(ctx, w, h, strength, multiplier = 1) {
  const alpha = GRAIN_ALPHA * strength * multiplier;
  if (alpha <= 0) return;

  const noise = getScratchCanvas('noise', w, h, buildNoise);
  if (!noise) return;

  ctx.save();
  try {
    ctx.globalAlpha = alpha; // absolute: strength is already inside `alpha`
    ctx.globalCompositeOperation = 'overlay';
    ctx.drawImage(noise, 0, 0, w, h);
  } catch {
    /* grain is decorative: a failed blit must never abort the render */
  } finally {
    ctx.restore();
  }
}

/* ---------- entry point ---------- */

/**
 * Grades the whole canvas: base adjustments, the grade's overlay, a vignette and grain.
 * `strength` is clamped to 0..1 (0 keeps the manual adjustments but drops every grade effect);
 * `adjust` holds contrast / saturation / warmth in -100..100; unknown grade ids fall back to sunset.
 */
export function applyGrade(ctx, w, h, gradeId, strength, adjust) {
  if (!ctx || typeof ctx.fillRect !== 'function') return;

  const width = toNumber(w, 0);
  const height = toNumber(h, 0);
  if (!(width > 0) || !(height > 0)) return;

  const amount = clampStrength(strength);
  const grade = resolveGradeId(gradeId);
  const preset = GRADE_PRESETS[grade] || null;
  // The grade's baked tone rides on top of the user's sliders and fades out with `strength`, so a
  // half-strength grade is half-baked rather than "preset tone + half the overlay".
  const tone = combineTone(normalizeAdjust(adjust), scaleTone(preset?.tone, amount));

  try {
    // 1. base adjustments (and the grade's own filter pass) — one offscreen round-trip, never stacked per effect
    const filter = buildFilter(grade, tone, amount);
    if (filter) applyFilterPass(ctx, width, height, filter);
    // `tone` already has the grade's share of warmth faded by `amount`; the manual slider's share must survive.
    drawWarmthCast(ctx, width, height, tone.warmth);

    if (amount > 0) {
      // 2. the grade overlay, 3. vignette, 4. grain
      drawGradeLook(ctx, width, height, grade, amount);
      drawVignette(ctx, width, height, amount, preset?.vignetteInner ?? DEFAULT_VIGNETTE_INNER);
      drawGrain(ctx, width, height, amount, preset?.grain ?? 1);
    }
  } finally {
    // Always hand the canvas back in a known state: the caption is drawn next and must not inherit effects.
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
