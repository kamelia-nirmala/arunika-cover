// Arunika Cover — editor wiring. One state object drives every control, drawCover(canvas, state) paints the preview,
// and the controls only ever mutate state then redraw. `?shot=` hands the page to shots.js instead (./shots.js).
import { drawCover, panelRects, LAYOUTS } from './cover.js';
import { loadImageFile, loadImageUrl, SAMPLE_PHOTOS } from './photos.js';
import { ensureFonts, DEFAULT_PANEL_LABELS } from './caption.js';
import { GRADES, resolveGradeId } from './grades.js';
import { SIZES, exportCover } from './export.js';
import { runShot } from './shots.js';

/* ---------- state ---------- */

/** Default title baseline on the cover, as a fraction of its height — the lower edge of the 62% hero band. */
const CAPTION_Y_DEFAULT = 0.47;

const state = {
  layout: 'hero-strip',
  sizeId: 'wide',
  gradeId: 'sunset',
  gradeStrength: 1,
  adjust: { contrast: 0, saturation: 0, warmth: 0 },
  title: 'SUNSET HEIST',
  subtitle: 'KOTA ARUNIKA',
  tagline: 'Kota ini milik siapa yang berani.',
  caption: { size: 0.11, x: 0.5, y: CAPTION_Y_DEFAULT, autoY: true, align: 'center', outline: 8, shadow: true, spacing: 0.02, tilt: -2 },
  badges: { vol: 'VOL. 1', burst: 'BARU' },
  seal: { text: 'ARUNIKA · EST. 2026', show: true },
  billing: 'ARUNIKA PICTURES',
  photos: [],
  panels: [],
};

// Panel plan per layout, in sample ids. The hero comes first, then the strip tiles, so panels[0] is always the big one.
const PANEL_PLAN = {
  'hero-strip': ['pier', 'boulevard', 'pier', 'boulevard'],
  grid: ['pier', 'boulevard', 'boulevard', 'pier'],
  comic: ['pier', 'boulevard', 'pier'],
  hero: ['pier'],
  miring: ['pier', 'boulevard', 'boulevard', 'pier'],
};
const LAYOUT_FALLBACK = ['hero-strip', 'grid', 'comic', 'hero', 'miring'];
const SIZE_IDS = ['wide', 'square', 'portrait'];
// Default vertical pan for the big hero panel. A cover-fit 720x720 sample centred in a wide hero rect shows only
// the middle band (shoulders), so the hero starts high in the frame instead: oy +1 is the top of the photo and
// 0.84 frames y ~37..289 of the sample, which is hat-to-chin with the face safely inside.
const HERO_OY = 0.84;

let activePanel = 0;      // index into state.panels, mirrored by #panelPicker
let photoNames = [];      // parallel to state.photos, for labels and the sample plan
let drag = null;          // { i, x, y, w, h, ox, oy } while dragging a panel
let drawWarned = false;

/* ---------- dom ---------- */

const el = (id) => document.getElementById(id);
const canvas = el('cover');
const statusEl = el('status');

function setStatus(text, tone = '') {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle('is-good', tone === 'good');
  statusEl.classList.toggle('is-bad', tone === 'bad');
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* ---------- sample + module shape helpers ---------- */

/** URL for a sample id, tolerating SAMPLE_PHOTOS being a map, a list of ids or a list of objects. */
function sampleUrl(id) {
  const fallback = `samples/${id}.jpg`;
  const list = Array.isArray(SAMPLE_PHOTOS) ? SAMPLE_PHOTOS : null;
  const pick = (entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') return entry.src ?? entry.url ?? entry.href ?? null;
    return null;
  };
  if (list) {
    const hit = list.find((entry) => {
      const name = typeof entry === 'string' ? entry : entry?.id ?? entry?.name ?? entry?.slug ?? '';
      return String(name).includes(id);
    });
    return pick(hit) ?? fallback;
  }
  if (SAMPLE_PHOTOS && typeof SAMPLE_PHOTOS === 'object') return pick(SAMPLE_PHOTOS[id]) ?? fallback;
  return fallback;
}

// state.photos holds { img, name } entries — cover.js reads entry.img, so both loaders are normalised to that shape.
const photoEntry = (img, name) => ({ img, name });

async function loadSample(id) {
  try {
    const loaded = await loadImageUrl(sampleUrl(id));
    const img = loaded?.img ?? loaded;
    return img ? photoEntry(img, id) : null;
  } catch (err) {
    console.error(`sample ${id} failed to load`, err);
    return null;
  }
}

const imageOf = (entry) => entry?.img ?? entry ?? null;

/** Layout ids the module actually offers, falling back to the four the editor is designed around. */
function layoutIds() {
  const known = LAYOUTS && typeof LAYOUTS === 'object' ? Object.keys(LAYOUTS) : [];
  if (!known.length) return LAYOUT_FALLBACK;
  const shared = LAYOUT_FALLBACK.filter((id) => known.includes(id));
  return shared.length ? shared : LAYOUT_FALLBACK;
}

/** Grade ids the module offers. GRADES is a list of { id, name } records, so read their ids — not array indices. */
function gradeIds() {
  if (Array.isArray(GRADES)) {
    const ids = GRADES
      .map((grade) => (typeof grade === 'string' ? grade : grade?.id))
      .filter((id) => typeof id === 'string' && id);
    return ids.length ? ids : ['sunset'];
  }
  const known = GRADES && typeof GRADES === 'object' ? Object.keys(GRADES) : [];
  return known.length ? known : ['sunset'];
}

/** Chip label for a grade: its `name` when grades.js carries one, else the id in Title Case. */
function gradeLabel(id) {
  const entry = Array.isArray(GRADES)
    ? GRADES.find((grade) => (typeof grade === 'string' ? grade : grade?.id) === id)
    : GRADES?.[id];
  const name = typeof entry === 'string' ? entry : entry?.name;
  if (typeof name === 'string' && name) return name;
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const indexOfName = (name) => photoNames.indexOf(name);

/* ---------- panels ---------- */

function buildPanels(layout, preferredPhoto) {
  const plan = PANEL_PLAN[layout] ?? ['pier'];
  // The hero panel (index 0 of hero-strip / hero) starts high in the photo so faces stay in frame.
  const heroLayout = layout === 'hero-strip' || layout === 'hero';
  return plan.map((id, i) => {
    const wants = i === 0 && Number.isInteger(preferredPhoto) ? preferredPhoto : indexOfName(id);
    const index = wants >= 0 && wants < state.photos.length
      ? wants
      : state.photos.length ? i % state.photos.length : 0;
    // A label the user already typed for this slot survives a layout switch; otherwise the slot default applies.
    const previous = state.panels[i];
    const label = previous && typeof previous.label === 'string'
      ? previous.label
      : DEFAULT_PANEL_LABELS[i % DEFAULT_PANEL_LABELS.length];
    return {
      photo: index,
      zoom: 1,
      ox: 0,
      oy: i === 0 && heroLayout ? HERO_OY : 0,
      label,
    };
  });
}

function resetPanels(layout, preferredPhoto) {
  state.panels = buildPanels(layout, preferredPhoto);
  activePanel = 0;
  buildPanelPicker();
  buildPanelLabels();
  syncPanelControls();
}

function active() {
  return state.panels[activePanel] ?? null;
}

function setActivePanel(index) {
  if (index < 0 || index >= state.panels.length) return;
  activePanel = index;
  const picker = el('panelPicker');
  if (picker) picker.value = String(index);
  syncPanelControls();
  markThumbs();
}

function panelLabel(layout, i) {
  if (layout === 'hero-strip') return i === 0 ? '1 · Hero' : `${i + 1} · Strip ${i}`;
  if (layout === 'hero') return '1 · Hero';
  return `${i + 1} · Panel`;
}

function buildPanelPicker() {
  const picker = el('panelPicker');
  if (!picker) return;
  picker.replaceChildren();
  state.panels.forEach((panel, i) => {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = panelLabel(state.layout, i);
    picker.append(option);
  });
  picker.value = String(clamp(activePanel, 0, Math.max(0, state.panels.length - 1)));
  picker.disabled = state.panels.length === 0;
}

/** One small text input per panel, so each role label (HERO / DRIVER / ...) can be retyped from the editor. */
function buildPanelLabels() {
  const list = el('panelLabels');
  if (!list) return;
  list.replaceChildren();
  state.panels.forEach((panel, i) => {
    const field = document.createElement('label');
    field.className = 'field panel-label-field';

    const head = document.createElement('span');
    head.className = 'field-head';
    const name = document.createElement('span');
    name.textContent = `Label panel ${i + 1}`;
    head.append(name);

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 18;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dataset.panelLabel = String(i);
    input.value = typeof panel.label === 'string' ? panel.label : '';
    input.placeholder = DEFAULT_PANEL_LABELS[i % DEFAULT_PANEL_LABELS.length];
    input.setAttribute('aria-label', `Label peran panel ${i + 1}`);
    input.addEventListener('input', (event) => {
      const target = state.panels[i];
      if (!target) return;
      target.label = event.target.value;
      redraw();
    });
    // Focus follows the panel: typing a label also makes that panel the active crop target.
    input.addEventListener('focus', () => setActivePanel(i));

    field.append(head, input);
    list.append(field);
  });
  list.hidden = state.panels.length === 0;
}

/** Pushes state.panels[i].label into the per-panel inputs without stomping the field being typed in. */
function syncPanelLabelInputs() {
  const list = el('panelLabels');
  if (!list) return;
  list.querySelectorAll('[data-panel-label]').forEach((input) => {
    const i = Number(input.dataset.panelLabel);
    const panel = state.panels[i];
    if (!panel || document.activeElement === input) return;
    input.value = typeof panel.label === 'string' ? panel.label : '';
  });
}

/** Assigns a photo index to a panel and recentres it. */
function assignPhoto(photoIndex, panelIndex = activePanel) {
  if (photoIndex < 0 || photoIndex >= state.photos.length) return;
  const panel = state.panels[panelIndex];
  if (!panel) return;
  panel.photo = photoIndex;
  panel.zoom = 1;
  panel.ox = 0;
  panel.oy = 0;
  syncPanelControls();
  markThumbs();
  redraw();
}

/* ---------- canvas ---------- */

function applyCanvasSize() {
  const size = SIZES?.[state.sizeId];
  if (!size || !canvas) return;
  if (canvas.width !== size.w) canvas.width = size.w;
  if (canvas.height !== size.h) canvas.height = size.h;
}

function redraw() {
  if (!canvas) return;
  try {
    drawCover(canvas, state);
  } catch (err) {
    if (!drawWarned) {
      drawWarned = true;
      console.error('drawCover failed', err);
      setStatus(`Gagal menggambar cover: ${err.message}`, 'bad');
    }
  }
}

function rectsNow() {
  if (!canvas) return [];
  try {
    return panelRects(state.layout, canvas.width, canvas.height).map((rect) => ({
      x: rect.x ?? rect.left ?? 0,
      y: rect.y ?? rect.top ?? 0,
      w: rect.w ?? rect.width ?? 0,
      h: rect.h ?? rect.height ?? 0,
    }));
  } catch (err) {
    console.error('panelRects failed', err);
    return [];
  }
}

function canvasPoint(event) {
  const box = canvas.getBoundingClientRect();
  const scaleX = box.width ? canvas.width / box.width : 1;
  const scaleY = box.height ? canvas.height / box.height : 1;
  return { x: (event.clientX - box.left) * scaleX, y: (event.clientY - box.top) * scaleY };
}

function hitTest(rects, x, y) {
  for (let i = rects.length - 1; i >= 0; i -= 1) {
    const r = rects[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
  }
  return -1;
}

/* ---------- control sync ---------- */

function setRange(id, value) {
  const input = el(id);
  if (input && document.activeElement !== input) input.value = String(value);
}

function setReadout(id, text) {
  const out = el(id);
  if (out) out.textContent = text;
}

function syncChoice(container, key, value) {
  if (!container) return;
  container.querySelectorAll(`[data-${key}]`).forEach((chip) => {
    chip.setAttribute('aria-pressed', chip.dataset[key] === value ? 'true' : 'false');
  });
}

function syncCaptionAutoState() {
  const button = el('captionYAuto');
  const auto = state.caption.autoY !== false;
  if (!button) return;
  button.setAttribute('aria-pressed', auto ? 'true' : 'false');
  button.disabled = auto;
  button.title = auto
    ? 'Posisi Y sedang dikurung agar judul tetap di area panel hero'
    : 'Kembalikan posisi Y ke auto (dikurung di area panel hero)';
}

function syncCaptionControls() {
  const cap = state.caption;
  const title = el('titleInput');
  const subtitle = el('subtitleInput');
  const tagline = el('taglineInput');
  const billing = el('billingInput');
  const sealText = el('sealInput');
  if (title && document.activeElement !== title) title.value = state.title;
  if (subtitle && document.activeElement !== subtitle) subtitle.value = state.subtitle;
  if (tagline && document.activeElement !== tagline) tagline.value = state.tagline ?? '';
  if (billing && document.activeElement !== billing) billing.value = state.billing ?? '';
  if (sealText && document.activeElement !== sealText) sealText.value = state.seal?.text ?? '';
  setRange('captionSizeRange', cap.size * 100);
  setRange('captionXRange', cap.x * 100);
  setRange('captionYRange', cap.y * 100);
  setRange('captionOutline', cap.outline);
  setRange('captionSpacingRange', cap.spacing * 100);
  const align = el('captionAlign');
  if (align) align.value = cap.align;
  const shadow = el('captionShadow');
  if (shadow) shadow.checked = Boolean(cap.shadow);
  const sealToggle = el('sealToggle');
  if (sealToggle) sealToggle.checked = state.seal?.show !== false;
  syncCaptionAutoState();
  setReadout('captionSizeRangeOut', `${Math.round(cap.size * 1000) / 10}%`);
  setReadout('captionXRangeOut', `${Math.round(cap.x * 100)}%`);
  setReadout('captionYRangeOut', cap.autoY === false ? `${Math.round(cap.y * 100)}%` : 'auto');
  setReadout('captionOutlineOut', `${Math.round(cap.outline)}px`);
  setReadout('captionSpacingRangeOut', `${Math.round(cap.spacing * 1000) / 10}%`);
}

function syncGradeControls() {
  syncChoice(el('gradePicker'), 'grade', state.gradeId);
  setRange('gradeStrength', Math.round(state.gradeStrength * 100));
  setRange('contrastRange', state.adjust.contrast);
  setRange('saturationRange', state.adjust.saturation);
  setRange('warmthRange', state.adjust.warmth);
  setReadout('gradeStrengthOut', `${Math.round(state.gradeStrength * 100)}%`);
  const signed = (n) => (n > 0 ? `+${n}` : String(n));
  setReadout('contrastRangeOut', signed(state.adjust.contrast));
  setReadout('saturationRangeOut', signed(state.adjust.saturation));
  setReadout('warmthRangeOut', signed(state.adjust.warmth));
}

function syncPanelControls() {
  const panel = active();
  setRange('zoomRange', panel ? Math.round(panel.zoom * 100) : 100);
  setRange('panXRange', panel ? Math.round(panel.ox * 100) : 0);
  setRange('panYRange', panel ? Math.round(panel.oy * 100) : 0);
  setReadout('zoomRangeOut', `${panel ? Math.round(panel.zoom * 100) : 100}%`);
  setReadout('panXRangeOut', panel ? String(Math.round(panel.ox * 100)) : '0');
  setReadout('panYRangeOut', panel ? String(Math.round(panel.oy * 100)) : '0');
  syncPanelLabelInputs();
}

function syncControls() {
  syncChoice(el('layoutPicker'), 'layout', state.layout);
  syncChoice(el('sizePicker'), 'size', state.sizeId);
  syncSizeLabels();
  syncCaptionControls();
  syncGradeControls();
  syncPanelControls();
  markThumbs();
}

/**
 * Keeps the size chips and export buttons reading from SIZES, which is the only place a ratio lives.
 * The markup carries the same strings for a first paint without JS; this just stops the two drifting.
 */
function syncSizeLabels() {
  SIZE_IDS.forEach((sizeId) => {
    const size = SIZES?.[sizeId];
    if (!size) return;
    const chip = document.querySelector(`#sizePicker [data-size="${sizeId}"]`);
    if (chip) chip.textContent = size.label ?? `${size.w} × ${size.h}`;
    const button = el(`export-${sizeId}`);
    if (button) button.textContent = `Export ${size.label ?? `${size.w} × ${size.h}`}`;
  });
}

/* ---------- photo list ---------- */

const THUMB_MAX_SIDE = 160; // longest side of a thumbnail, in CSS pixels of the source image
const thumbCache = new WeakMap(); // img element -> data URL, so a redraw does not re-encode pixels

/**
 * Thumbnail source for a library entry: the decoded pixels drawn into a small offscreen canvas and
 * returned as a JPEG data URL. The blob: URL of an uploaded file is revoked by loadImageFile() once it
 * decodes, so reusing img.currentSrc/img.src there would hit ERR_FILE_NOT_FOUND and leave the thumb blank.
 * Falls back to '' when the image cannot be drawn yet.
 */
function thumbSrc(entry) {
  const img = imageOf(entry);
  if (!img) return '';
  const cached = thumbCache.get(img);
  if (cached) return cached;

  const w = Number(img.naturalWidth) || 0;
  const h = Number(img.naturalHeight) || 0;
  if (!(w > 0) || !(h > 0)) return '';

  const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  let url = '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(img, 0, 0, tw, th);
      url = canvas.toDataURL('image/jpeg', 0.75);
    }
  } catch {
    url = '';
  }
  if (url) thumbCache.set(img, url);
  return url;
}

function markThumbs() {
  const list = el('photoList');
  if (!list) return;
  const current = active()?.photo;
  list.querySelectorAll('.photo-thumb').forEach((thumb) => {
    thumb.setAttribute('aria-current', Number(thumb.dataset.index) === current ? 'true' : 'false');
  });
}

function buildPhotoList() {
  const list = el('photoList');
  if (!list) return;
  list.replaceChildren();
  state.photos.forEach((photo, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'photo-thumb';
    button.dataset.index = String(i);
    button.title = `Pasang foto ${i + 1} ke panel aktif`;
    button.setAttribute('aria-label', `Foto ${i + 1}: ${photoNames[i] ?? 'foto'}`);

    const img = document.createElement('img');
    const src = thumbSrc(photo);
    // Setting src='' would resolve to the page URL and log a 404, so only touch it when we have pixels.
    if (src) img.src = src;
    img.alt = '';
    img.decoding = 'async';

    const number = document.createElement('span');
    number.textContent = String(i + 1);

    button.append(img, number);
    button.addEventListener('click', () => assignPhoto(i));
    list.append(button);
  });
  markThumbs();
}

/* ---------- adding photos ---------- */

function firstEmptyPanel() {
  return state.panels.findIndex((panel) => panel.photo < 0 || panel.photo >= state.photos.length || panel.photo == null);
}

/** Adds images (already loaded) to the library and drops them onto empty panels first, then the active one. */
function addPhotos(images, names) {
  if (!images.length) return 0;
  const before = state.photos.length;
  images.forEach((img, i) => {
    state.photos.push(img);
    photoNames.push(names[i] ?? `foto-${before + i + 1}`);
  });
  images.forEach((_, i) => {
    const target = firstEmptyPanel();
    assignPhoto(before + i, target !== -1 ? target : activePanel);
  });
  buildPhotoList();
  buildPanelPicker();
  setStatus(`${images.length} foto ditambahkan`, 'good');
  return images.length;
}

async function addFiles(fileList) {
  const files = Array.from(fileList ?? []).filter((file) => file.type.startsWith('image/'));
  if (!files.length) {
    setStatus('Tidak ada berkas gambar yang bisa dipakai', 'bad');
    return;
  }
  const loaded = [];
  const names = [];
  for (const file of files) {
    try {
      const result = await loadImageFile(file);
      const img = imageOf(result);
      if (!img) continue;
      loaded.push(photoEntry(img, file.name));
      names.push(result?.name ? result.name.replace(/\.[^.]+$/, '') : file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      console.error(`failed to load ${file.name}`, err);
    }
  }
  if (!loaded.length) {
    setStatus('Foto gagal dimuat', 'bad');
    return;
  }
  addPhotos(loaded, names);
}

/* ---------- grade + layout chip populations ---------- */

function buildGradeChips() {
  const picker = el('gradePicker');
  if (!picker) return;
  const ids = gradeIds();
  // Chips the markup does not own (e.g. stale index chips from an earlier build) would set an unknown grade.
  picker.querySelectorAll('[data-grade]').forEach((chip) => {
    if (!ids.includes(chip.dataset.grade)) chip.remove();
  });
  const present = new Set(Array.from(picker.querySelectorAll('[data-grade]'), (chip) => chip.dataset.grade));
  ids.forEach((id) => {
    if (present.has(id)) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.grade = id;
    chip.textContent = gradeLabel(id);
    picker.append(chip);
  });
  picker.querySelectorAll('[data-grade]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.gradeId = chip.dataset.grade;
      syncGradeControls();
      redraw();
    });
  });
  syncChoice(picker, 'grade', state.gradeId);
}

function buildLayoutChips() {
  const picker = el('layoutPicker');
  if (!picker) return;
  const ids = layoutIds();
  const present = new Set(Array.from(picker.querySelectorAll('[data-layout]'), (chip) => chip.dataset.layout));
  ids.forEach((id) => {
    if (present.has(id)) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.layout = id;
    chip.textContent = id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    picker.append(chip);
  });
  picker.querySelectorAll('[data-layout]').forEach((chip) => {
    if (!ids.includes(chip.dataset.layout)) chip.hidden = true;
    chip.addEventListener('click', () => {
      state.layout = chip.dataset.layout;
      resetPanels(state.layout);
      syncControls();
      redraw();
    });
  });
  syncChoice(picker, 'layout', state.layout);
}

/* ---------- events ---------- */

function wireControls() {
  buildLayoutChips();
  buildGradeChips();

  el('photoInput')?.addEventListener('change', async (event) => {
    await addFiles(event.target.files);
    event.target.value = '';
  });

  const drop = el('dropZone');
  if (drop) {
    const stop = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (event) => {
      stop(event);
      drop.classList.add('is-over');
    }));
    ['dragleave', 'dragend'].forEach((type) => drop.addEventListener(type, (event) => {
      stop(event);
      drop.classList.remove('is-over');
    }));
    drop.addEventListener('drop', async (event) => {
      stop(event);
      drop.classList.remove('is-over');
      await addFiles(event.dataTransfer?.files);
    });
    // Dropping anywhere else must not navigate away from the editor.
    ['dragover', 'drop'].forEach((type) => window.addEventListener(type, (event) => {
      if (drop.contains(event.target)) return;
      event.preventDefault();
    }));
  }

  document.querySelectorAll('#sampleRow [data-sample]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.sample;
      const known = indexOfName(id);
      if (known !== -1) {
        const target = firstEmptyPanel();
        assignPhoto(known, target !== -1 ? target : activePanel);
        setStatus(`Foto ${id} dipasang`, 'good');
        return;
      }
      setStatus(`Memuat foto ${id}…`);
      const entry = await loadSample(id);
      if (!entry) {
        setStatus(`Foto ${id} gagal dimuat`, 'bad');
        return;
      }
      state.photos.push(entry);
      photoNames.push(entry.name ?? id);
      const target = firstEmptyPanel();
      assignPhoto(state.photos.length - 1, target !== -1 ? target : activePanel);
      buildPhotoList();
      buildPanelPicker();
      setStatus(`Foto ${id} dipasang`, 'good');
    });
  });

  el('sizePicker')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-size]');
    if (!chip) return;
    state.sizeId = chip.dataset.size;
    applyCanvasSize();
    syncChoice(el('sizePicker'), 'size', state.sizeId);
    redraw();
  });

  el('gradeStrength')?.addEventListener('input', (event) => {
    state.gradeStrength = Number(event.target.value) / 100;
    setReadout('gradeStrengthOut', `${event.target.value}%`);
    redraw();
  });

  const adjustBindings = [
    ['contrastRange', 'contrast'],
    ['saturationRange', 'saturation'],
    ['warmthRange', 'warmth'],
  ];
  adjustBindings.forEach(([id, key]) => {
    el(id)?.addEventListener('input', (event) => {
      const value = Number(event.target.value);
      state.adjust[key] = value;
      setReadout(`${id}Out`, value > 0 ? `+${value}` : String(value));
      redraw();
    });
  });

  el('titleInput')?.addEventListener('input', (event) => {
    state.title = event.target.value;
    redraw();
  });

  el('subtitleInput')?.addEventListener('input', (event) => {
    state.subtitle = event.target.value;
    redraw();
  });

  el('taglineInput')?.addEventListener('input', (event) => {
    state.tagline = event.target.value;
    redraw();
  });

  el('billingInput')?.addEventListener('input', (event) => {
    state.billing = event.target.value;
    redraw();
  });

  el('sealInput')?.addEventListener('input', (event) => {
    state.seal.text = event.target.value;
    redraw();
  });

  el('sealToggle')?.addEventListener('change', (event) => {
    state.seal.show = event.target.checked;
    redraw();
  });

  el('captionSizeRange')?.addEventListener('input', (event) => {
    state.caption.size = Number(event.target.value) / 100;
    setReadout('captionSizeRangeOut', `${event.target.value}%`);
    redraw();
  });

  el('captionXRange')?.addEventListener('input', (event) => {
    state.caption.x = Number(event.target.value) / 100;
    setReadout('captionXRangeOut', `${event.target.value}%`);
    redraw();
  });

  el('captionYRange')?.addEventListener('input', (event) => {
    // Dragging the slider takes over from the automatic clamp; the Auto chip restores it.
    state.caption.y = Number(event.target.value) / 100;
    state.caption.autoY = false;
    syncCaptionAutoState();
    setReadout('captionYRangeOut', `${event.target.value}%`);
    redraw();
  });

  el('captionYAuto')?.addEventListener('click', () => {
    // Auto = the default placement (the lower edge of the hero), clamped per layout so it never spills.
    state.caption.autoY = true;
    state.caption.y = CAPTION_Y_DEFAULT;
    syncCaptionAutoState();
    syncCaptionControls();
    redraw();
  });

  el('captionAlign')?.addEventListener('change', (event) => {
    state.caption.align = event.target.value;
    redraw();
  });

  el('captionOutline')?.addEventListener('input', (event) => {
    state.caption.outline = Number(event.target.value);
    setReadout('captionOutlineOut', `${event.target.value}px`);
    redraw();
  });

  el('captionShadow')?.addEventListener('change', (event) => {
    state.caption.shadow = event.target.checked;
    redraw();
  });

  el('captionSpacingRange')?.addEventListener('input', (event) => {
    state.caption.spacing = Number(event.target.value) / 100;
    setReadout('captionSpacingRangeOut', `${event.target.value}%`);
    redraw();
  });

  el('panelPicker')?.addEventListener('change', (event) => {
    setActivePanel(Number(event.target.value));
  });

  el('zoomRange')?.addEventListener('input', (event) => {
    const panel = active();
    if (!panel) return;
    panel.zoom = Number(event.target.value) / 100;
    setReadout('zoomRangeOut', `${event.target.value}%`);
    redraw();
  });

  el('panXRange')?.addEventListener('input', (event) => {
    const panel = active();
    if (!panel) return;
    panel.ox = clamp(Number(event.target.value) / 100, -1, 1);
    setReadout('panXRangeOut', String(Math.round(panel.ox * 100)));
    redraw();
  });

  el('panYRange')?.addEventListener('input', (event) => {
    const panel = active();
    if (!panel) return;
    panel.oy = clamp(Number(event.target.value) / 100, -1, 1);
    setReadout('panYRangeOut', String(Math.round(panel.oy * 100)));
    redraw();
  });

  SIZE_IDS.forEach((sizeId) => {
    el(`export-${sizeId}`)?.addEventListener('click', () => doExport(sizeId));
  });

  wireCanvasGestures();
}

async function doExport(sizeId) {
  const size = SIZES?.[sizeId];
  if (!size) {
    setStatus(`Ukuran ${sizeId} tidak tersedia`, 'bad');
    return;
  }
  const buttons = SIZE_IDS.map((id) => el(`export-${id}`)).filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; });
  setStatus(`Menyiapkan PNG ${size.w} × ${size.h}…`);
  try {
    await exportCover(state, sizeId);
    setStatus(`Tersimpan arunika-cover-${size.w}x${size.h}.png`, 'good');
  } catch (err) {
    console.error('exportCover failed', err);
    setStatus(`Export gagal: ${err.message}`, 'bad');
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

/* ---------- canvas gestures: pick, drag to pan, wheel to zoom ---------- */

function wireCanvasGestures() {
  if (!canvas || canvas.dataset.wired === 'true') return;
  canvas.dataset.wired = 'true';
  canvas.tabIndex = 0;

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const point = canvasPoint(event);
    const rects = rectsNow();
    const index = hitTest(rects, point.x, point.y);
    if (index === -1) return;
    setActivePanel(index);
    const rect = rects[index];
    const panel = state.panels[index];
    drag = {
      i: index,
      x: point.x,
      y: point.y,
      w: Math.max(1, rect.w),
      h: Math.max(1, rect.h),
      ox: panel.ox,
      oy: panel.oy,
    };
    canvas.setPointerCapture?.(event.pointerId);
    canvas.classList.add('is-panning');
    event.preventDefault();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const panel = state.panels[drag.i];
    if (!panel) return;
    const point = canvasPoint(event);
    panel.ox = clamp(drag.ox + (point.x - drag.x) / drag.w, -1, 1);
    panel.oy = clamp(drag.oy + (point.y - drag.y) / drag.h, -1, 1);
    syncPanelControls();
    redraw();
  });

  const endDrag = (event) => {
    if (!drag) return;
    drag = null;
    canvas.classList.remove('is-panning');
    if (event?.pointerId != null) canvas.releasePointerCapture?.(event.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', (event) => { if (drag && event.buttons === 0) endDrag(event); });

  canvas.addEventListener('wheel', (event) => {
    const panel = active();
    if (!panel) return;
    event.preventDefault();
    const step = event.deltaY > 0 ? -0.05 : 0.05;
    panel.zoom = clamp(panel.zoom + step, 1, 3);
    syncPanelControls();
    redraw();
  }, { passive: false });
}

/* ---------- boot ---------- */

async function initEditor() {
  setStatus('Memuat foto contoh…');
  const [pier, boulevard] = await Promise.all([loadSample('pier'), loadSample('boulevard')]);
  state.photos = [pier, boulevard].filter(Boolean);
  photoNames = state.photos.map((photo) => photo.name);
  if (!state.photos.length) setStatus('Foto contoh tidak termuat — tambahkan foto sendiri', 'bad');
  else setStatus('Siap — pilih panel, atur grade, lalu export');

  resetPanels(state.layout);
  applyCanvasSize();
  await ensureFonts();
  buildPhotoList();
  syncControls();
  redraw();
}

/** Shot mode: shots.js resolves the query into plain values and this applies them to state. */
async function setupShot(options) {
  const opts = options ?? {};
  const chosen = opts.photo ?? 'pier';
  const [pier, boulevard] = await Promise.all([loadSample('pier'), loadSample('boulevard')]);
  state.photos = [pier, boulevard].filter(Boolean);
  photoNames = state.photos.map((photo) => photo.name);

  const wanted = state.photos[indexOfName(chosen)] ?? state.photos[0] ?? null;
  state.layout = opts.layout ?? state.layout;
  state.sizeId = opts.sizeId ?? state.sizeId;
  state.gradeId = resolveGradeId(opts.gradeId ?? state.gradeId);
  if (opts.title) state.title = opts.title;
  if (opts.subtitle) state.subtitle = opts.subtitle;

  resetPanels(state.layout, wanted ? state.photos.indexOf(wanted) : -1);
  // The shot's photo leads the composition: hero first, then whatever the plan filled in.
  // The hero keeps the same default vertical framing the editor starts with, so shots show faces too.
  if (wanted && state.panels.length) {
    state.panels[0].photo = state.photos.indexOf(wanted);
    state.panels[0].zoom = 1;
    state.panels[0].ox = 0;
    state.panels[0].oy = HERO_OY;
  }

  applyCanvasSize();
  await ensureFonts();
  buildPhotoList();
  syncControls();
  redraw();
  if (document.body.classList.contains('shot-cover')) setStatus('');
  else setStatus('Mode pratinjau — kontrol bisa diubah');
}

async function boot() {
  wireControls();
  const query = new URLSearchParams(location.search);
  const shot = query.get('shot');
  if (shot) {
    await runShot(shot, query, setupShot);
    return;
  }
  await initEditor();
}

boot().catch((err) => {
  console.error('Arunika Cover failed to start', err);
  setStatus(`Editor gagal dimuat: ${err.message}`, 'bad');
});
