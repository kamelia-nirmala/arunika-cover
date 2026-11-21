// Fixed scenes for screenshots. `?shot=cover` shows the cover alone, full viewport, so a screenshot is exactly the
// artwork; `?shot=editor` opens the whole editor. Every other knob is read from the query — photo, caption/title,
// subtitle, tagline, layout, size, grade, the per-panel role labels, the photo and vertical crop of each panel, the
// seal and billing wording, and where the control rail is scrolled to — with the shot defaults below when it is
// absent. main.js owns the state; this file only parses the query, calls `setup` with plain values, applies the
// knobs main.js has no option for through the editor's own inputs, and flips window.__shotReady once paint settles.

import { LAYOUTS } from './cover.js';
import { GRADES } from './grades.js';
// The export sizes are read from the exporter for the same reason as the layouts and grades below: a ratio added
// there is valid in a shot link at once, with no second list here to forget.
import { SIZES as SIZE_TABLE } from './export.js';
// The sample table, so `photos=pier,...` matches the thumbnail labels the editor builds from the same list.
import { SAMPLE_PHOTOS } from './photos.js';

// The shot defaults are the poster the app should lead with: the tilted "miring" layout (four rotated panels, each
// with its own face-aware crop), the blockbuster teal-orange grade, and a title lock-up over the artwork. A bare
// `?shot=cover` therefore already shows every new feature; a scene only overrides what it wants to differ.
const DEFAULTS = {
  photo: 'pier',
  title: 'Sunset Heist',
  subtitle: 'Kota Arunika',
  tagline: 'Kota ini milik siapa yang berani.',
  layout: 'miring',
  sizeId: 'wide',
  gradeId: 'teal-orange',
  // The same wording the editor boots with, so a bare `?shot=cover` matches the app's own default poster.
  seal: 'ARUNIKA · EST. 2026',
  billing: 'ARUNIKA PICTURES',
};

// Read from the renderer and the exporter themselves, so a layout, grade or ratio added later is valid in a shot
// link without a second list here to forget. The literals below only cover a module that somehow exports nothing.
const SIZE_IDS = SIZE_TABLE && typeof SIZE_TABLE === 'object' ? Object.keys(SIZE_TABLE) : [];
const LAYOUT_IDS = Object.keys(LAYOUTS ?? {});
const GRADE_IDS = Array.isArray(GRADES) ? GRADES.map((grade) => grade.id).filter(Boolean) : [];
const SIZES = SIZE_IDS.length ? SIZE_IDS : ['wide', 'square', 'portrait'];
const LAYOUT_CHOICES = LAYOUT_IDS.length ? LAYOUT_IDS : ['hero-strip', 'grid', 'comic', 'hero', 'miring'];
const GRADE_CHOICES = GRADE_IDS.length ? GRADE_IDS : ['sunset', 'neon', 'noir', 'golden', 'vice', 'teal-orange'];

/** Reads a query value, trimmed, or the default when it is missing or blank. */
function read(query, key, fallback) {
  const raw = query?.get(key);
  if (raw == null) return fallback;
  const value = raw.trim();
  return value === '' ? fallback : value;
}

/**
 * Reads a line of copy for the poster: the query value or the default, with runs of whitespace collapsed and the
 * length capped, so a hand-typed link cannot push a title off the artwork.
 */
function readText(query, key, fallback, maxLength = 60) {
  return read(query, key, fallback).replace(/\s+/g, ' ').slice(0, maxLength);
}

/** Keeps a query value inside the set the editor can draw, so a bad link never breaks the preview. */
function readChoice(query, key, allowed, fallback) {
  const value = read(query, key, fallback).toLowerCase();
  return allowed.includes(value) ? value : fallback;
}

/** `labels=HERO,DRIVER,LOOKOUT` — one role label per panel, blanks dropped so they cannot clear a slot. */
function readLabels(query) {
  const raw = query?.get('labels');
  if (!raw) return [];
  return raw
    .split(/[,|]/)
    .map((label) => label.trim().slice(0, 18))
    .filter(Boolean)
    .slice(0, 4);
}

/** Whole-pixel scroll offset, or 0 when the query carries nothing usable. */
function readCount(query, key) {
  const value = Number(read(query, key, '0'));
  return Number.isFinite(value) ? Math.round(value) : 0;
}

/**
 * `crop=0,84|1,0|2,100` — a per-panel vertical pan in -100..100 (the editor's panY slider units), so a scene can
 * reframe the slot the face heuristic gets wrong (a mouth-only close-up, say) without a second renderer. A pair may
 * carry a third value, the zoom percentage (`2,80,140` = pan 80 at 140%), which is what turns a repeated sample into
 * a distinct composition — a tight detail instead of a second copy of the hero framing. Panels with no entry keep the
 * framing the renderer chose.
 */
function readCrops(query) {
  const raw = query?.get('crop');
  if (!raw) return [];
  const out = [];
  raw.split('|').forEach((triple) => {
    const [index, value, zoom] = triple.split(/[,:]/);
    const panel = Number(String(index ?? '').trim());
    const pan = Number(String(value ?? '').trim());
    if (!Number.isInteger(panel) || panel < 0 || panel > 3) return;
    if (!Number.isFinite(pan)) return;
    const entry = { panel, pan: Math.min(100, Math.max(-100, pan)) };
    // The editor's zoom slider runs 100..300 (see #zoomRange); anything outside that is not a framing it can draw.
    const percent = Number(String(zoom ?? '').trim());
    if (Number.isFinite(percent) && percent > 0) entry.zoom = Math.min(300, Math.max(100, percent)) / 100;
    out.push(entry);
  });
  return out;
}

/** `photos=pier,boulevard,boulevard,pier` — the sample id dropped onto each panel, blanks dropped. */
function readPanelPhotos(query) {
  const raw = query?.get('photos');
  if (!raw) return [];
  return raw
    .split(/[,|]/)
    .map((id) => id.trim().slice(0, 24))
    .slice(0, 4);
}

function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

/** Waits for the display face the caption uses, without letting a missing font hang the shot. */
async function fontsReady() {
  try {
    await Promise.race([
      document.fonts?.ready ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch {
    /* a font that never resolves is not worth blocking the screenshot */
  }
}

/**
 * Types a value into one of the editor's text fields and lets the editor's own `input` listener take it, which is
 * how the tagline reaches state: setup() has no option for it, and mutating state from here would mean a second
 * copy of the editor's rules. Returns false when the field is not on the page.
 */
function typeInto(id, value) {
  if (typeof value !== 'string' || value === '') return false;
  const input = document.getElementById(id);
  if (!input) return false;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** Fills the per-panel role-label inputs built by buildPanelLabels(). */
function typeIntoLabels(labels) {
  if (!Array.isArray(labels) || !labels.length) return;
  labels.forEach((text, index) => {
    const input = document.querySelector(`#panelLabels [data-panel-label="${index}"]`);
    if (!input) return;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// Card headings in the control rail, so a scene can ask for the section its screenshot is about instead of a pixel
// offset that drifts whenever a card above it grows.
const CARD_ALIASES = {
  foto: 'foto',
  photo: 'foto',
  layout: 'layout',
  ukuran: 'ukuran',
  size: 'ukuran',
  grade: 'grade',
  caption: 'caption',
  judul: 'caption',
  panel: 'panel',
  crop: 'panel',
  export: 'export',
};

/** Scrolls the control rail to a card (and `scroll` extra pixels), clamped to the rail's own scroll range. */
function scrollRail(scrollTo, extra) {
  const rail = document.querySelector('.controls');
  if (!rail) return;
  const wanted = CARD_ALIASES[String(scrollTo ?? '').toLowerCase()];
  let top = 0;
  if (wanted) {
    const card = Array.from(rail.querySelectorAll('.panel')).find((panel) => {
      const head = panel.querySelector('h2')?.textContent ?? '';
      return head.trim().toLowerCase().startsWith(wanted);
    });
    if (card) {
      // Rect maths instead of offsetTop: the rail itself is not a positioned ancestor, so offsetParent is the body.
      top = rail.scrollTop + (card.getBoundingClientRect().top - rail.getBoundingClientRect().top);
    }
  }
  const limit = Math.max(0, rail.scrollHeight - rail.clientHeight);
  rail.scrollTop = Math.max(0, Math.min(top + extra, limit));
}

/**
 * Drops the sample in `photoId` onto panel `index` through the editor's own thumbnail button, so the editor's
 * assignPhoto() does the wiring (it also resets that panel's crop to the neutral default). The id is matched
 * against the sample's own name (`pier` -> "Dermaga Senja") as well as its file, because the thumbnail's aria-label
 * carries the display name, not the id. Returns false when the library holds no such sample.
 */
function assignPanelPhoto(index, photoId) {
  const thumbs = Array.from(document.querySelectorAll('#photoList .photo-thumb'));
  if (!thumbs.length) return false;
  const wanted = String(photoId ?? '').trim().toLowerCase();
  if (!wanted) return false;
  const names = thumbNamesFor(wanted);
  const hit = thumbs.find((thumb) => {
    const label = (thumb.getAttribute('aria-label') ?? '').toLowerCase();
    return names.some((name) => label.includes(name));
  });
  if (!hit) return false;
  const picker = document.getElementById('panelPicker');
  if (picker) {
    picker.value = String(index);
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  }
  hit.click();
  return true;
}

/** The strings a thumbnail label may carry for a sample id: its display name and its file stem. */
function thumbNamesFor(id) {
  const sample = SAMPLE_PHOTOS.find((photo) => String(photo?.id ?? '').toLowerCase() === id);
  const stems = [id];
  const src = sample?.src ?? '';
  const stem = src.split('/').pop()?.replace(/\.[a-z0-9]+$/i, '');
  if (stem) stems.push(stem.toLowerCase());
  if (sample?.name) stems.push(sample.name.toLowerCase());
  return stems.filter(Boolean);
}

/**
 * Sets the active panel's framing through the editor's own sliders: the vertical pan in its -100..100 units, and the
 * zoom percentage when the scene asked for one (the editor's zoom slider runs 100..300).
 */
function setPanelPan(index, pan, zoom) {
  const picker = document.getElementById('panelPicker');
  if (picker) {
    picker.value = String(index);
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (Number.isFinite(zoom)) {
    const zoomSlider = document.getElementById('zoomRange');
    if (zoomSlider) {
      zoomSlider.value = String(Math.round(zoom * 100));
      zoomSlider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  const slider = document.getElementById('panYRange');
  if (!slider) return false;
  slider.value = String(Math.round(pan));
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/**
 * Applies the knobs the editor has no setup() option for — tagline, seal and billing wording, the per-panel photo
 * and vertical crop, the role labels and the rail's scroll position — through its own DOM inputs, after `setup`
 * has built the panels. Photos come before crops: assignPhoto() resets a panel's crop, so a pan set first would be
 * wiped by the photo that follows it.
 */
function applyShotExtras(options) {
  typeInto('taglineInput', options.tagline);
  typeInto('sealInput', options.seal);
  typeInto('billingInput', options.billing);
  options.photos.forEach((id, index) => assignPanelPhoto(index, id));
  options.crops.forEach(({ panel, pan, zoom }) => setPanelPan(panel, pan, zoom));
  typeIntoLabels(options.labels);
  scrollRail(options.scrollTo, options.scroll);
}

export async function runShot(shot, query, setup) {
  const mode = shot === 'cover' || shot === 'editor' ? shot : 'editor';
  const params = query ?? new URLSearchParams();

  // `caption` is the older spelling of `title`; an explicit `title` wins.
  const title = readText(params, 'title', readText(params, 'caption', DEFAULTS.title, 40), 40);

  const options = {
    photo: read(params, 'photo', DEFAULTS.photo),
    title,
    subtitle: readText(params, 'subtitle', DEFAULTS.subtitle, 40),
    tagline: readText(params, 'tagline', DEFAULTS.tagline, 60),
    layout: readChoice(params, 'layout', LAYOUT_CHOICES, DEFAULTS.layout),
    sizeId: readChoice(params, 'size', SIZES, DEFAULTS.sizeId),
    gradeId: readChoice(params, 'grade', GRADE_CHOICES, DEFAULTS.gradeId),
    // The stamp and the billing block default to the wording the app ships with; a scene names its own only when
    // the copy is part of the artwork it is showing.
    seal: readText(params, 'seal', DEFAULTS.seal, 34),
    billing: readText(params, 'billing', DEFAULTS.billing, 40),
    photos: readPanelPhotos(params),
    crops: readCrops(params),
    labels: readLabels(params),
    scrollTo: read(params, 'scrollto', ''),
    scroll: readCount(params, 'scroll'),
  };

  document.body.classList.toggle('shot-cover', mode === 'cover');
  document.body.dataset.shot = mode;

  if (typeof setup !== 'function') {
    window.__shotReady = true;
    return;
  }

  try {
    await setup(options);
    // After setup, so the panels and label inputs exist; every call below repaints through the editor.
    applyShotExtras(options);
  } finally {
    await fontsReady();
    await nextPaint();
    window.__shotReady = true;
  }
}
