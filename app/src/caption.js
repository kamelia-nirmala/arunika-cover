// Lettering for the cover: the big display title drawn straight over the hero artwork (no band behind it — outline
// plus a drop shadow keep it readable), the wide-tracked subtitle and the one-line tagline beneath it, the small
// role label on every panel, the round seal, the billing block with its fake barcode, and the corner badges.
//
// The display face is Anton, shipped with the app in app/fonts/ (SIL Open Font License 1.1, see app/fonts/OFL.txt).
// Everything here degrades to Arial Black or the system sans if the font never loads.
//
// State contract (fractions of the cover, not pixels):
//   state.title      the poster title, drawn on top of the hero panel
//   state.subtitle   the tracked line under the title (may be empty)
//   state.tagline    one-line slogan under the subtitle (may be empty)
//   state.billing    studio name that opens the billing block
//   state.seal       { text, show } for the round corner stamp
//   panels[i].label  the role label of that panel (HERO / DRIVER / ...)
//   caption.size     font size as a fraction of the cover height
//   caption.x, .y    title baseline position as fractions of the cover width / height
//   caption.autoY    true to place the lock-up on the hero's own bottom edge (follows the layout)
//   caption.align    'left' | 'center' | 'right', anchored on caption.x
//   caption.outline  stroke width in pixels at h = 1080, scaled with h / 1080
//   caption.shadow   true to drop a soft black shadow under the letters
//   caption.spacing  tracking between letters, as a fraction of the font size
//   caption.tilt     rotation of the title in degrees, around the title baseline point

/** Family name of the bundled display face; registered by the page from app/fonts/. */
export const DISPLAY_FONT = 'Anton';

/** Points on the badge starburst. */
const STAR_POINTS = 12;

/** Title size never auto-shrinks below this, in pixels. */
const MIN_TITLE_SIZE = 12;

/** Title may occupy at most this share of the cover width. */
const MAX_TITLE_WIDTH = 0.92;

/** The reference height caption.outline and the thin strokes are measured against. */
const REFERENCE_HEIGHT = 1080;

/** Chooses `value` when it is a usable number, `fallback` otherwise. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The canvas font string for the display face at `size` pixels. */
function displayFont(size) {
  return `900 ${size}px '${DISPLAY_FONT}', 'Arial Black', sans-serif`;
}

/**
 * Width of `text` when each glyph is placed by hand with `spacingPx` between neighbours. Canvas 2D has no
 * dependable letter-spacing, so the tracking is measured and drawn glyph by glyph.
 */
function measureTrackedWidth(ctx, text, spacingPx) {
  const glyphs = Array.from(text);
  if (glyphs.length === 0) return 0;
  let width = 0;
  for (const glyph of glyphs) width += ctx.measureText(glyph).width;
  return width + spacingPx * (glyphs.length - 1);
}

/** Left edge of a tracked run of `width` anchored at `anchorX` for the given alignment. */
function trackedStartX(align, anchorX, width) {
  if (align === 'left') return anchorX;
  if (align === 'right') return anchorX - width;
  return anchorX - width / 2;
}

/**
 * Draws `text` glyph by glyph on the current baseline, from `anchorX` according to `align`, with `spacingPx`
 * between letters. `paint(glyph, x, y)` does the actual stroking or filling. Returns the total run width.
 */
function drawTrackedText(ctx, text, anchorX, baselineY, spacingPx, align, paint) {
  const glyphs = Array.from(text);
  if (glyphs.length === 0) return 0;
  const widths = glyphs.map((glyph) => ctx.measureText(glyph).width);
  let width = spacingPx * (glyphs.length - 1);
  for (const glyphWidth of widths) width += glyphWidth;
  let cursor = trackedStartX(align, anchorX, width);
  for (let i = 0; i < glyphs.length; i += 1) {
    paint(glyphs[i], cursor, baselineY);
    cursor += widths[i] + spacingPx;
  }
  return width;
}

/**
 * Finds the largest size (starting at `baseSize`, stepping down) at which `text` fits inside `maxWidth` once
 * tracked by `spacingRatio`. `fontFor(size)` supplies the font string. Returns the size, the tracking in pixels,
 * and the measured width.
 */
function fitTrackedSize(ctx, text, baseSize, maxWidth, spacingRatio, fontFor) {
  let size = baseSize;
  for (;;) {
    ctx.font = fontFor(size);
    const spacing = spacingRatio * size;
    const width = measureTrackedWidth(ctx, text, spacing);
    if (width <= maxWidth || size <= MIN_TITLE_SIZE) return { size, spacing, width };
    size = Math.max(MIN_TITLE_SIZE, size - Math.max(1, size * 0.04));
  }
}

/** Path of a rounded rectangle; the caller fills and/or strokes it. */
function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Path of a pointed starburst (alternating outer and inner vertices, first point straight up). */
function starburstPath(ctx, cx, cy, outerRadius, innerRadius, points) {
  const step = Math.PI / points;
  ctx.beginPath();
  for (let i = 0; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = -Math.PI / 2 + i * step;
    const px = cx + Math.cos(angle) * radius;
    const py = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** Draws the top-left volume pill, e.g. "VOL. 1": translucent black capsule, white hairline, white bold text. */
function drawVolumePill(ctx, w, h, label) {
  const text = String(label).trim();
  if (!text) return;
  const scale = h / REFERENCE_HEIGHT;
  const fontSize = 0.028 * h;
  const padX = fontSize * 0.75;
  const padY = fontSize * 0.45;
  ctx.font = `700 ${fontSize}px '${DISPLAY_FONT}', 'Arial Black', sans-serif`;
  const textWidth = ctx.measureText(text).width;
  const boxW = textWidth + padX * 2;
  const boxH = fontSize + padY * 2;
  const x = 0.03 * w;
  const y = 0.03 * h;

  ctx.save();
  roundedRectPath(ctx, x, y, boxW, boxH, boxH / 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, 2 * scale);
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + boxW / 2, y + boxH / 2 + fontSize * 0.04);
  ctx.restore();
}

/** Draws the top-right starburst sticker in warning yellow, with the burst text in black across its middle. */
function drawStarburstBadge(ctx, w, h, label) {
  const text = String(label).trim().slice(0, 8);
  const scale = h / REFERENCE_HEIGHT;
  const outerRadius = 0.055 * h;
  const innerRadius = 0.038 * h;
  const cx = w - 0.035 * w - outerRadius;
  const cy = 0.03 * h + outerRadius;

  ctx.save();
  starburstPath(ctx, cx, cy, outerRadius, innerRadius, STAR_POINTS);
  ctx.fillStyle = '#ffcf3f';
  ctx.fill();
  ctx.lineWidth = Math.max(1, 2 * scale);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#181310';
  ctx.stroke();

  if (text) {
    const fontSize = 0.022 * h;
    ctx.font = `700 ${fontSize}px '${DISPLAY_FONT}', 'Arial Black', sans-serif`;
    ctx.fillStyle = '#181310';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + fontSize * 0.04);
  }
  ctx.restore();
}

/** Loads the display face. Resolution is best-effort: a failure is swallowed so the fallback stack draws. */
export async function ensureFonts() {
  try {
    await document.fonts.load(`80px ${DISPLAY_FONT}`);
    await document.fonts.ready;
  } catch (error) {
    console.warn(`caption: ${DISPLAY_FONT} unavailable, falling back to Arial Black`, error);
  }
}

/** Default baseline of the title, as a fraction of the cover height, when the caption carries no `y`. */
const DEFAULT_CAPTION_Y = 0.47;

/** Hero band assumed when the caller passes none: the 62% hero of the default layout. */
const DEFAULT_BAND = { x: 0, y: 0, w: 1, h: 0.62 };

/** Breathing room kept between the title lock-up and the hero's bottom edge, as a fraction of the cover height. */
const BAND_SAFE_MARGIN = 0.012;

/**
 * Top edge of the billing plate (its 10.4% height plus the 2.2% bottom inset), as a fraction of the cover height.
 * A full-height hero band such as `comic` reaches the bottom of the poster, so the lock-up is kept above this line
 * instead of colliding with the footer.
 */
const FOOTER_TOP = 0.874;

/** Left/right edges of a tracked line drawn by `drawTrackedText` at `anchorX` with the given align. */
function trackedSpan(anchorX, width, align) {
  if (align === 'left') return { left: anchorX, right: anchorX + width };
  if (align === 'right') return { left: anchorX - width, right: anchorX };
  return { left: anchorX - width / 2, right: anchorX + width / 2 };
}

/** The hero band as fractions, tolerating a missing or malformed value. */
function safeBand(band) {
  if (!band || typeof band !== 'object') return DEFAULT_BAND;
  const x = numberOr(band.x, 0);
  const y = numberOr(band.y, 0);
  const w = numberOr(band.w, 1);
  const h = numberOr(band.h, DEFAULT_BAND.h);
  return { x, y, w, h };
}

/** Tagline size as a fraction of the cover height, before it is fitted to the width. */
const TAGLINE_SIZE = 0.026;

/**
 * Baseline offsets of the subtitle and the tagline under the title, in pixels. One function owns the vertical rhythm
 * so the containment check below and the actual drawing can never disagree about how tall the lock-up is.
 */
function lockupOffsets(titleSize, subtitleSize, hasSubtitle, hasTagline) {
  const subtitleDrop = hasSubtitle ? titleSize * 0.42 : 0;
  let taglineDrop = 0;
  if (hasTagline) {
    taglineDrop = hasSubtitle
      ? subtitleDrop + Math.max(subtitleSize * 1.7, titleSize * 0.3)
      : titleSize * 0.6;
  }
  return { subtitleDrop, taglineDrop };
}

/** How far the whole lock-up reaches below the title baseline, in pixels, descenders included. */
function lockupDepth(titleSize, subtitleSize, taglineSize, hasSubtitle, hasTagline) {
  const { subtitleDrop, taglineDrop } = lockupOffsets(titleSize, subtitleSize, hasSubtitle, hasTagline);
  let depth = titleSize * 0.2;
  if (hasSubtitle) depth = Math.max(depth, subtitleDrop + subtitleSize * 0.3);
  if (hasTagline) depth = Math.max(depth, taglineDrop + taglineSize * 0.9);
  return depth;
}

/**
 * Vertical anchor of the title baseline. In its default mode (`caption.autoY !== false`) the lock-up is pinned to the
 * bottom of the hero band, so one caption setting works on every layout: the 62% hero of `hero-strip`, the tall hero
 * of `comic`, and the half-height hero rows of `grid` / `miring` all keep the title on the artwork instead of spilling
 * over the strip below. Dragging the Y slider clears `autoY` and the authored value is used verbatim.
 */
function anchorBaselineY(h, band, caption, titleSize, subtitleSize, taglineSize, hasSubtitle, hasTagline) {
  const authored = numberOr(caption.y, DEFAULT_CAPTION_Y) * h;
  if (caption.autoY === false) return authored;
  const box = safeBand(band);
  // A band that runs to the bottom of the poster (the single-hero and comic layouts) stops at the billing plate.
  const bandBottom = Math.min(box.y + box.h, FOOTER_TOP);
  const bottom = bandBottom * h - BAND_SAFE_MARGIN * h;
  const depth = lockupDepth(titleSize, subtitleSize, taglineSize, hasSubtitle, hasTagline);
  const ceiling = bottom - depth;
  // A band too short for the lock-up still gets its baseline pinned to the ceiling rather than the floor.
  const floor = Math.min(box.y * h + titleSize * 0.9, ceiling);
  return Math.max(floor, Math.min(authored, ceiling));
}

/**
 * Shrinks a fitted tracked line until its box clears the seal disc. The title is the loudest thing on the poster, so
 * it keeps the largest size that does not run under the stamp; a line that already clears the disc (or a poster with
 * no seal) is returned untouched. `pad` is the gap kept from the disc, as a fraction of its radius.
 */
function shrinkClearOfSeal(ctx, text, fitted, opts) {
  if (!text || !fitted) return fitted;
  const { anchorX, align, baselineY, disc, fontFor, floor } = opts;
  if (!disc) return fitted;
  const pad = numberOr(opts.pad, 0.12);
  const step = numberOr(opts.step, 0.05);

  const { cx, cy, r } = disc;
  const top = baselineY - fitted.size * 0.82;
  const bottom = baselineY + fitted.size * 0.2;
  // Only a line whose vertical band overlaps the stamp can collide with it.
  if (bottom < cy - r || top > cy + r) return fitted;

  const spacingRatio = fitted.size > 0 ? fitted.spacing / fitted.size : 0;
  let current = fitted;
  for (let i = 0; i < 24; i += 1) {
    const span = trackedSpan(anchorX, current.width, align);
    const clear = span.right + r * pad <= cx - r || span.left - r * pad >= cx + r;
    if (clear) return current;
    if (current.size <= floor) return current;
    const next = Math.max(floor, current.size - Math.max(1, current.size * step));
    const spacing = spacingRatio * next;
    ctx.font = fontFor(next);
    current = { size: next, spacing, width: measureTrackedWidth(ctx, text, spacing) };
  }
  return current;
}

/** Draws the title (tilted, outlined, tracked) straight over the hero artwork, then subtitle and tagline. */
export function drawCaption(ctx, w, h, state, band) {
  const caption = state?.caption ?? {};
  const title = String(state?.title ?? '').trim().toUpperCase();
  const subtitle = String(state?.subtitle ?? '').trim().toUpperCase();
  const tagline = String(state?.tagline ?? '').trim().toUpperCase();
  if (!title && !subtitle && !tagline) return;

  const baseSize = Math.max(MIN_TITLE_SIZE, numberOr(caption.size, 0.11) * h);
  const align = caption.align === 'left' || caption.align === 'right' ? caption.align : 'center';
  const anchorX = numberOr(caption.x, 0.5) * w;
  const spacingRatio = Math.max(0, numberOr(caption.spacing, 0.02));
  const outline = Math.max(0, numberOr(caption.outline, 8)) * (h / REFERENCE_HEIGHT);
  const tilt = numberOr(caption.tilt, 0) * (Math.PI / 180);
  const disc = sealDisc(w, h, band, state?.seal);

  const fittedBase = title
    ? fitTrackedSize(ctx, title, baseSize, w * MAX_TITLE_WIDTH, spacingRatio, displayFont)
    : { size: baseSize, spacing: spacingRatio * baseSize, width: 0 };

  const subtitleFont = (size) => `700 ${size}px '${DISPLAY_FONT}', 'Arial Black', sans-serif`;
  const subtitleSize = Math.max(MIN_TITLE_SIZE * 0.6, fittedBase.size * 0.3);
  const taglineBase = tagline
    ? fitTrackedSize(ctx, tagline, Math.max(MIN_TITLE_SIZE * 0.6, TAGLINE_SIZE * h), w * MAX_TITLE_WIDTH, TAGLINE_TRACKING, taglineFont)
    : null;
  const taglineSize = taglineBase ? taglineBase.size : 0;

  // Fit against the seal with the size the anchor will use, then re-anchor: a title the stamp pushed smaller sits
  // lower in the band, so repeating the pair until it is stable keeps the drawn size and the anchor consistent.
  let fitted = fittedBase;
  let baselineY = anchorBaselineY(h, band, caption, fitted.size, subtitleSize, taglineSize, Boolean(subtitle), Boolean(tagline));
  for (let pass = 0; pass < 3; pass += 1) {
    const next = shrinkClearOfSeal(ctx, title, fittedBase, {
      anchorX, align, baselineY, disc, fontFor: displayFont, floor: MIN_TITLE_SIZE,
    });
    const anchor = anchorBaselineY(h, band, caption, next.size, subtitleSize, taglineSize, Boolean(subtitle), Boolean(tagline));
    if (next.size === fitted.size && anchor === baselineY) break;
    fitted = next;
    baselineY = anchor;
  }

  const { subtitleDrop, taglineDrop } = lockupOffsets(fitted.size, subtitleSize, Boolean(subtitle), Boolean(tagline));
  const subtitleY = baselineY + subtitleDrop;

  const fittedSubtitle = subtitle
    ? shrinkClearOfSeal(
      ctx,
      subtitle,
      fitTrackedSize(ctx, subtitle, subtitleSize, w * MAX_TITLE_WIDTH, 0.12, subtitleFont),
      {
        anchorX,
        align,
        baselineY: subtitleY,
        disc,
        fontFor: subtitleFont,
        floor: MIN_TITLE_SIZE * 0.6,
        pad: 0.2,
      },
    )
    : null;

  const taglineY = baselineY + taglineDrop;
  const fittedTagline = fittedSubtitle || tagline
    ? shrinkClearOfSeal(ctx, tagline, taglineBase, {
      anchorX,
      align,
      baselineY: taglineY,
      disc,
      fontFor: taglineFont,
      floor: MIN_TITLE_SIZE * 0.6,
      pad: 0.2,
    })
    : null;

  // The title sits directly on the hero image: the outline plus the drop shadow carry its contrast, with no band
  // painted behind it, so the artwork keeps showing through the letters.
  if (title) {
    ctx.save();
    ctx.translate(anchorX, baselineY);
    if (tilt !== 0) ctx.rotate(tilt);
    ctx.font = displayFont(fitted.size);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (caption.shadow) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
      ctx.shadowBlur = fitted.size * 0.28;
      ctx.shadowOffsetY = fitted.size * 0.07;
    }

    const paint = (glyph, x, y) => {
      if (outline > 0) {
        ctx.lineWidth = outline;
        ctx.strokeStyle = '#000000';
        ctx.strokeText(glyph, x, y);
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillText(glyph, x, y);
    };

    drawTrackedText(ctx, title, 0, 0, fitted.spacing, align, paint);

    // Shadow must not leak into the subtitle, tagline or the badges.
    ctx.shadowColor = 'rgba(0, 0, 0, 0)';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.restore();
  }

  if (fittedSubtitle) {
    ctx.save();
    ctx.font = subtitleFont(fittedSubtitle.size);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const thin = Math.max(1, 2 * (h / REFERENCE_HEIGHT));
    const paint = (glyph, x, y) => {
      ctx.lineWidth = thin;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.strokeText(glyph, x, y);
      ctx.fillStyle = '#ffd9a0';
      ctx.fillText(glyph, x, y);
    };
    drawTrackedText(ctx, subtitle, anchorX, subtitleY, fittedSubtitle.spacing, align, paint);
    ctx.restore();
  }

  if (fittedTagline) {
    // Directly under the title lock-up, so the slogan reads as part of the heading rather than a footer line.
    drawTagline(ctx, h, tagline, fittedTagline, taglineY, anchorX, align);
  }
}

/** The display-spaced caps the tagline is set in; its size is fitted once by the caller. */
function taglineFont(size) {
  return `700 ${size}px '${DISPLAY_FONT}', 'Arial Black', sans-serif`;
}

/** Tracking of the one-line slogan, as a fraction of its font size. */
const TAGLINE_TRACKING = 0.14;

/** Small tracked caps for the one-line slogan, outlined so it stays readable over a busy photo. */
function drawTagline(ctx, h, text, fitted, baselineY, anchorX, align) {
  const thin = Math.max(1, 2.2 * (h / REFERENCE_HEIGHT));
  ctx.save();
  ctx.font = taglineFont(fitted.size);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const paint = (glyph, x, y) => {
    ctx.lineWidth = thin;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.strokeText(glyph, x, y);
    ctx.fillStyle = '#fff2df';
    ctx.fillText(glyph, x, y);
  };
  drawTrackedText(ctx, text, anchorX, baselineY, fitted.spacing, align, paint);
  ctx.restore();
}

/* ---------- role labels ---------- */

/** Default role label per panel index, used when a panel carries no label of its own. */
export const DEFAULT_PANEL_LABELS = ['HERO', 'DRIVER', 'LOOKOUT', 'BOSS'];

/**
 * Draws the small role label of one panel (HERO / DRIVER / ...): a translucent black capsule with a hairline and
 * tracked white caps, anchored inside the panel's top-left corner so it never fights the title, the seal or the
 * corner badges. `lift` pushes it down clear of the volume pill when the panel owns the cover's top-left corner.
 * The caller draws it inside the panel's own (possibly rotated) space, so a tilted panel keeps a straight label.
 */
export function drawPanelLabel(ctx, rect, text, coverHeight, lift = 0, insetX = 0) {
  const label = String(text ?? '').trim().toUpperCase().slice(0, 18);
  if (!label || !(rect.w > 0) || !(rect.h > 0)) return;

  const scale = coverHeight / REFERENCE_HEIGHT;
  const inset = Math.max(4, coverHeight * 0.016);
  const padX = 0.78;
  const padY = 0.42;
  // The chip must stay inside its panel, so on a narrow strip panel the type steps down until the capsule fits
  // instead of running off the edge or being clipped by the neighbouring panel.
  const room = Math.max(0, Math.min(rect.w, rect.w - 2 * Math.max(inset, insetX)));

  let fontSize = Math.max(8, 0.02 * coverHeight);
  let textWidth = 0;
  for (;;) {
    ctx.save();
    ctx.font = `700 ${fontSize}px '${DISPLAY_FONT}', 'Arial Black', sans-serif`;
    textWidth = ctx.measureText(label).width;
    ctx.restore();
    const boxW = textWidth + fontSize * padX * 2;
    if (boxW <= room || fontSize <= 8) break;
    fontSize = Math.max(8, fontSize - Math.max(0.5, fontSize * 0.08));
  }

  ctx.save();
  ctx.font = `700 ${fontSize}px '${DISPLAY_FONT}', 'Arial Black', sans-serif`;
  const boxW = textWidth + fontSize * padX * 2;
  const boxH = fontSize + fontSize * padY * 2;

  // `insetX` lets a panel that owns the cover's top-left corner line its chip up with the volume pill above it.
  const x0 = rect.x + Math.max(inset, insetX);
  const x = Math.min(x0, Math.max(rect.x, rect.x + rect.w - inset - boxW));
  const y = Math.min(rect.y + inset + lift, Math.max(rect.y, rect.y + rect.h - inset - boxH));

  ctx.fillStyle = 'rgba(8, 5, 13, 0.72)';
  roundedRectPath(ctx, x, y, boxW, boxH, boxH * 0.24);
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.4 * scale);
  ctx.strokeStyle = 'rgba(255, 236, 208, 0.72)';
  ctx.stroke();

  ctx.fillStyle = '#fff3e1';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + boxW / 2, y + boxH / 2 + fontSize * 0.04);
  ctx.restore();
}

/* ---------- seal ---------- */

/** Seal radius as a fraction of the cover's short side. */
const SEAL_RADIUS = 0.082;

/** Seal ink: a cool mint that stands off both the warm sunset wash and a magenta grade. */
const SEAL_INK = '#9df0dd';

/** Fallback seal wording, used when state.seal carries no text. */
const SEAL_TEXT = 'ARUNIKA · EST. 2026';

/**
 * Draws the round rubber stamp in the corner of the hero band: a dark backing disc (so the pale ink reads on any
 * grade), a thick outer ring, a thin inner ring, the wording running around the circle, and a star in the middle.
 * `band` is the hero area as fractions of the cover ({x, y, w, h}); `seal` is state.seal ({text, show}).
 */
/**
 * Centre and radius of the seal disc in pixels. Shared by the stamp itself and by the title's clearance check, so the
 * two never disagree about where the disc sits.
 */
function sealGeometry(w, h, band) {
  const box = band && typeof band === 'object' ? band : { x: 0, y: 0, w: 1, h: 0.62 };
  const r = Math.max(12, SEAL_RADIUS * Math.min(w, h));
  // Keep the whole disc inside a 3.5% safe margin: a poster cropped a couple of percent must not shave the seal.
  const safe = w * 0.035;
  const cx = Math.max(r + safe, (box.x + box.w) * w - r - safe);
  // Stay clear of the billing plate even when the hero band reaches the bottom of the cover (single-hero layout).
  const cy = Math.min((box.y + box.h) * h - r * 1.6, h * 0.845 - r);
  return { cx, cy, r };
}

/** The seal's disc, or null when the stamp is hidden or has no text. */
export function sealDisc(w, h, band, seal) {
  const cfg = seal && typeof seal === 'object' ? seal : {};
  const text = String(cfg.text ?? SEAL_TEXT).trim();
  if (cfg.show === false || !text) return null;
  return sealGeometry(w, h, band);
}

export function drawSeal(ctx, w, h, band, seal) {
  const cfg = seal && typeof seal === 'object' ? seal : {};
  const text = String(cfg.text ?? SEAL_TEXT).trim().toUpperCase();
  if (!sealDisc(w, h, band, seal)) return;

  const { cx, cy, r } = sealGeometry(w, h, band);
  const line = Math.max(1, r * 0.012);

  ctx.save();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(9, 5, 15, 0.5)';
  ctx.fill();

  ctx.strokeStyle = SEAL_INK;
  ctx.lineWidth = Math.max(1.5, r * 0.095);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.92, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = Math.max(1, r * 0.035);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2);
  ctx.stroke();

  // Wording runs clockwise starting at the left of the circle (9 o'clock) and sweeps over the top, one glyph per
  // slot, each upright and facing outward. The glyph size is capped by the arc each slot actually gets, so a long
  // seal text shrinks to stay legible instead of piling letters on top of each other.
  const glyphs = Array.from(text).slice(0, 34);
  const step = (Math.PI * 2) / Math.max(1, glyphs.length);
  const ring = r * 0.76;
  const arcPerSlot = ring * step;
  const fontSize = Math.max(6, Math.min(r * 0.26, arcPerSlot * 0.92));
  glyphs.forEach((glyph, i) => {
    if (glyph === ' ') return;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-Math.PI / 2 + i * step);
    ctx.font = `700 ${fontSize}px '${DISPLAY_FONT}', 'Arial Black', sans-serif`;
    ctx.fillStyle = SEAL_INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, 0, -ring);
    ctx.restore();
  });

  // Star at the centre, so the ring reads as a stamp rather than a plain circle.
  starburstPath(ctx, cx, cy, r * 0.33, r * 0.14, 5);
  ctx.fillStyle = SEAL_INK;
  ctx.fill();
  ctx.lineWidth = Math.max(1, line);
  ctx.strokeStyle = 'rgba(9, 5, 15, 0.5)';
  ctx.stroke();

  ctx.restore();
}

/* ---------- billing block + barcode ---------- */

/** Geometry of the billing plate in pixels: a wide dark box across the bottom of the cover. */
function footerPlate(w, h) {
  const height = Math.max(40, Math.round(h * 0.104));
  const inset = Math.round(w * 0.028);
  const bottom = Math.round(h * 0.022);
  return { x: inset, y: h - bottom - height, w: Math.max(0, w - inset * 2), h: height };
}

/** FNV-1a over the title, so the barcode is stable for a title and changes when it changes. */
function hashText(text) {
  let hash = 2166136261;
  for (const ch of String(text)) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic bar/gap pattern (in units of 1..3 and 1..2) for a seed — same title, same barcode, every render. */
function barPattern(seed, count) {
  let state = seed || 1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    bars.push({ bar: 1 + Math.floor(next() * 3), gap: 1 + Math.floor(next() * 2) });
  }
  return bars;
}

/** Three lines of small caps in the poster-billing idiom, opened by the studio name from state.billing. */
function billingLines(state) {
  const studio = String(state?.billing ?? '').trim().toUpperCase() || 'ARUNIKA PICTURES';
  const title = String(state?.title ?? '').trim().toUpperCase();
  return [
    `${studio} PRESENTS`,
    title ? `A ${title} FILM` : 'A FILM BY ARUNIKA',
    'ARUNIKA · 2026 · ALL RIGHTS RESERVED',
  ];
}

/** Draws the billing text block inside the plate; every line is trimmed to the width it is given. */
function drawBillingBlock(ctx, h, state, x, y, width, height) {
  if (!(width > 4) || !(height > 4)) return;
  const lines = billingLines(state);
  const size = Math.max(7, Math.min(0.0155 * h, height / (lines.length + 1.2)));
  const stepY = size * 1.55;

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 ${size}px '${DISPLAY_FONT}', 'Arial Black', sans-serif`;
  lines.forEach((line, i) => {
    const baseline = y + size + i * stepY;
    if (baseline > y + height) return;
    ctx.fillStyle = i === lines.length - 1 ? 'rgba(244, 236, 226, 0.66)' : '#f6ede1';
    let text = line;
    while (text.length > 1 && ctx.measureText(text).width > width) text = text.slice(0, -1);
    ctx.fillText(text, x, baseline);
  });
  ctx.restore();
}

/** Draws the fake barcode: a cream ticket with dark bars and a short code, all derived from the title. */
function drawBarcode(ctx, h, state, x, y, width, height) {
  if (!(width > 8) || !(height > 8)) return;
  const seed = hashText(`${state?.title ?? ''}|${state?.billing ?? ''}|ARUNIKA`);
  const bars = barPattern(seed, 46);
  const total = bars.reduce((sum, bar) => sum + bar.bar + bar.gap, 0);
  const unit = width / Math.max(1, total);
  const padY = height * 0.12;
  const barsBottom = y + height - height * 0.26;
  const codeText = `AQ-${seed.toString(36).toUpperCase().slice(0, 6)}`;

  ctx.save();
  ctx.fillStyle = 'rgba(255, 251, 244, 0.95)';
  ctx.fillRect(x, y, width, height);

  ctx.fillStyle = '#100b16';
  let cursor = x + unit * 0.5;
  for (const bar of bars) {
    const barW = Math.max(0.7, bar.bar * unit);
    ctx.fillRect(cursor, y + padY, barW, Math.max(1, barsBottom - (y + padY)));
    cursor += (bar.bar + bar.gap) * unit;
  }

  ctx.font = `600 ${Math.max(6, Math.min(height * 0.17, 13 * (h / REFERENCE_HEIGHT)))}px 'Courier New', monospace`;
  ctx.fillStyle = '#100b16';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(codeText, x + width / 2, y + height - height * 0.08);
  ctx.restore();
}

/**
 * Draws the billing plate at the bottom of the poster: the film-style billing lines on the left, the barcode
 * ticket on the right. Both are generated from `state`, so a title change regenerates the barcode deterministically.
 */
export function drawFooter(ctx, w, h, state) {
  const plate = footerPlate(w, h);
  if (!(plate.w > 0) || !(plate.h > 0)) return;

  const scale = h / REFERENCE_HEIGHT;
  const pad = Math.round(plate.h * 0.17);

  ctx.save();
  roundedRectPath(ctx, plate.x, plate.y, plate.w, plate.h, Math.min(plate.h * 0.14, 10));
  ctx.fillStyle = 'rgba(8, 5, 14, 0.7)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.4 * scale);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.stroke();
  ctx.restore();

  const inner = { y: plate.y + pad, h: plate.h - pad * 2 };
  const barcodeW = Math.min(plate.w * 0.3, plate.h * 3.1);
  const barcodeX = plate.x + plate.w - pad - barcodeW;
  const textW = Math.max(0, barcodeX - plate.x - pad * 2);

  drawBillingBlock(ctx, h, state, plate.x + pad, inner.y, textW, inner.h);
  drawBarcode(ctx, h, state, barcodeX, inner.y, barcodeW, inner.h);
}

/** Draws the corner badges: the volume pill on the left, the starburst sticker on the right. */
export function drawBadges(ctx, w, h, state) {
  const badges = state?.badges ?? {};
  if (badges.vol) drawVolumePill(ctx, w, h, badges.vol);
  if (badges.burst) drawStarburstBadge(ctx, w, h, badges.burst);
}
