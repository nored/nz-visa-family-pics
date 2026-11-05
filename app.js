import * as db from './db.js';
import { buildPdf, QUALITY, formatDate, monthLabel } from './pdf.js';

const $ = sel => document.querySelector(sel);
const STORE_EDGE = 2000; // long edge of the copy kept in the browser
const THUMB_EDGE = 400;

const DEFAULT_SETTINGS = { layout: '1', paper: 'a4', limitMB: 10 };

const state = {
  photos: new Map(), // id -> record
  settings: { ...DEFAULT_SETTINGS },
  urls: new Map(), // `${kind}:${id}` -> object URL
  tab: 'choose',
  busy: false,
  pdf: null, // {url, file}
  viewer: { ids: [], index: 0 },
};

// ---------- ordering ----------

const byDate = (a, b) => {
  const da = a.date || '9999', dbb = b.date || '9999';
  return da < dbb ? -1 : da > dbb ? 1 : a.added - b.added;
};
const allSorted = () => [...state.photos.values()].sort(byDate);
const selectedSorted = () => allSorted().filter(p => p.selected);
const needsWork = p => !p.date || !p.caption.trim();

function urlFor(rec, kind) {
  const key = `${kind}:${rec.id}`;
  if (!state.urls.has(key)) state.urls.set(key, URL.createObjectURL(kind === 'thumb' ? rec.thumb : rec.blob));
  return state.urls.get(key);
}
function dropUrls(id) {
  for (const kind of ['thumb', 'full']) {
    const key = `${kind}:${id}`;
    if (state.urls.has(key)) { URL.revokeObjectURL(state.urls.get(key)); state.urls.delete(key); }
  }
}

// ---------- image intake ----------

const isHeic = f => /image\/hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name || '');
const isImage = f => f && (f.type?.startsWith('image/') || isHeic(f) || /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i.test(f.name || ''));

let heicLoader = null;
function loadHeic2any() {
  heicLoader ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/heic2any.min.js';
    s.onload = () => res(window.heic2any);
    s.onerror = () => rej(new Error('Could not load the HEIC converter'));
    document.head.appendChild(s);
  });
  return heicLoader;
}

async function decodeAny(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* next */ }
  try {
    const url = URL.createObjectURL(blob);
    try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { URL.revokeObjectURL(url); }
  } catch { /* next */ }
  if (isHeic(blob)) {
    const heic2any = await loadHeic2any();
    const jpg = await heic2any({ blob, toType: 'image/jpeg', quality: 0.92 });
    return decodeAny(Array.isArray(jpg) ? jpg[0] : jpg);
  }
  throw new Error('not an image the browser can read');
}

async function drawToJpeg(src, edge, quality, rotate = 0) {
  const scale = Math.min(1, edge / Math.max(src.width, src.height));
  const w = Math.round(src.width * scale), h = Math.round(src.height * scale);
  const swap = rotate % 180 !== 0;
  const c = document.createElement('canvas');
  c.width = swap ? h : w; c.height = swap ? w : h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(rotate * Math.PI / 180);
  ctx.drawImage(src, -w / 2, -h / 2, w, h);
  const blob = await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Encoding failed')), 'image/jpeg', quality));
  const dims = { w: c.width, h: c.height };
  c.width = c.height = 0;
  return { blob, ...dims };
}

const pad = n => String(n).padStart(2, '0');
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function readExifDate(file) {
  try {
    // the lite build throws on the `pick` option, so parse the default segments
    const ex = await window.exifr.parse(file);
    const d = ex && (ex.DateTimeOriginal || ex.CreateDate || ex.DateTimeDigitized);
    if (d instanceof Date && !isNaN(d) && d.getFullYear() > 1900) return isoOf(d);
  } catch { /* no EXIF */ }
  return '';
}

// WhatsApp, Android and screenshot file names carry the date: IMG-20230514-WA0003, PXL_20230514_..., Screenshot 2024-05-01
function filenameDate(name) {
  const m = /(?:^|[^\d])((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[^\d]|$)/.exec(name || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function addFiles(fileList, { select = false } = {}) {
  const files = [...fileList].filter(isImage);
  if (!files.length) { setStatus('No images found in that selection.', true); return; }
  const known = new Set([...state.photos.values()].map(p => p.fp));
  let added = 0, skipped = 0;
  const failed = [];
  setBusy(true);
  showTab('choose');
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    showProgress(`Reading photo ${i + 1} of ${files.length}`);
    const fp = `${f.name}|${f.size}`;
    if (known.has(fp)) { skipped++; continue; }
    try {
      let date = await readExifDate(f), dateSource = date ? 'photo' : '';
      if (!date) { date = filenameDate(f.name); if (date) dateSource = 'filename'; }
      const src = await decodeAny(f);
      const full = await drawToJpeg(src, STORE_EDGE, 0.9);
      const thumb = await drawToJpeg(src, THUMB_EDGE, 0.78);
      if (src.close) src.close();
      const rec = {
        id: newId(), fp, name: f.name || 'photo', added: Date.now() + i,
        blob: full.blob, thumb: thumb.blob, w: full.w, h: full.h,
        date, dateSource, caption: '', selected: select,
      };
      await db.putPhoto(rec);
      state.photos.set(rec.id, rec);
      known.add(fp);
      added++;
      if (added % 12 === 0) renderGrid(); // let the grid fill while a big batch is still loading
    } catch (e) {
      console.error(e);
      failed.push(f.name || 'unnamed file');
    }
  }
  setBusy(false);
  hideProgress();
  invalidatePdf();
  renderAll();
  const msg = [];
  if (added) msg.push(`Added ${added} photo${added === 1 ? '' : 's'}.`);
  if (skipped) msg.push(`${skipped} already here.`);
  if (failed.length) msg.push(`Could not read ${failed.length}: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ', ...' : ''}.`);
  setStatus(msg.join(' '), failed.length > 0);
}

// ---------- persistence ----------

const saveTimers = new Map();
function saveSoon(rec) {
  clearTimeout(saveTimers.get(rec.id));
  saveTimers.set(rec.id, setTimeout(() => { saveTimers.delete(rec.id); db.putPhoto(rec); }, 300));
}
function flushSaves() {
  for (const [id, t] of saveTimers) { clearTimeout(t); db.putPhoto(state.photos.get(id)); }
  saveTimers.clear();
}

async function load() {
  const [photos, settings] = await Promise.all([db.getAllPhotos(), db.getMeta('settings')]);
  for (const p of photos) {
    p.caption ??= '';
    p.selected ??= true; // records from the first version were all meant for the PDF
    state.photos.set(p.id, p);
  }
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// ---------- rendering ----------

function renderGrid() {
  const grid = $('#grid');
  grid.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'tiles';
  const tpl = $('#tile-tpl').content.firstElementChild;
  let month = null;
  for (const rec of allSorted()) {
    const tile = tpl.cloneNode(true);
    tile.dataset.id = rec.id;
    tile.querySelector('img').src = urlFor(rec, 'thumb');
    const m = monthLabel(rec.date);
    if (m !== month) {
      month = m;
      const label = document.createElement('span');
      label.className = 'month';
      label.textContent = m === 'No date' ? m : m.replace(/^(\w{3})\w*/, '$1');
      tile.appendChild(label);
    }
    paintTile(tile, rec);
    wrap.appendChild(tile);
  }
  grid.appendChild(wrap);
  renderCounts();
}

function paintTile(tile, rec) {
  tile.classList.toggle('on', rec.selected);
  const pick = tile.querySelector('.pick');
  pick.setAttribute('aria-pressed', String(rec.selected));
  pick.setAttribute('aria-label', `${formatDate(rec.date) || 'No date'}${rec.selected ? ', selected' : ''}`);
}

function renderCards() {
  const list = $('#cards');
  list.textContent = '';
  const tpl = $('#card-tpl').content.firstElementChild;
  const sel = selectedSorted();
  sel.forEach((rec, i) => {
    const card = tpl.cloneNode(true);
    card.dataset.id = rec.id;
    const img = card.querySelector('img');
    img.src = urlFor(rec, 'full');
    img.width = rec.w; img.height = rec.h; // reserves space before the image loads
    card.querySelector('.fig').textContent = `Figure ${i + 1}`;
    card.querySelector('.f-date').value = rec.date;
    const cap = card.querySelector('.f-caption');
    cap.value = rec.caption;
    cap.setAttribute('enterkeyhint', i === sel.length - 1 ? 'done' : 'next');
    paintCard(card, rec);
    list.appendChild(card);
  });
  $('#captions-empty').hidden = sel.length > 0;
  renderCounts();
}

function paintCard(card, rec) {
  card.classList.toggle('todo', needsWork(rec));
  card.querySelector('.f-date').classList.toggle('need', !rec.date);
  const src = card.querySelector('.date-src');
  src.textContent = !rec.date ? 'add date' : rec.dateSource === 'filename' ? 'from file name' : '';
  src.classList.toggle('missing', !rec.date);
}

function renderCounts() {
  const total = state.photos.size;
  const sel = selectedSorted();
  const todo = sel.filter(needsWork).length;
  $('#tab-choose-n').textContent = total ? `${sel.length}/${total}` : '';
  $('#tab-captions-n').textContent = todo ? `${todo} to do` : sel.length ? '✓' : '';
  $('#choose-empty').hidden = total > 0;
  $('#choose-hint').hidden = total === 0;
  $('#cleanup').hidden = total === 0;
  $('#make-btn').disabled = state.busy || sel.length === 0;
  if (state.busy || state.pdf) return;
  if (!total) setStatus('');
  else if (!sel.length) setStatus('Tap the photos you want in the PDF.');
  else if (todo) setStatus(`${sel.length} selected · ${todo} need${todo === 1 ? 's' : ''} a caption or date`);
  else setStatus(`${sel.length} photo${sel.length === 1 ? '' : 's'} ready`);
}

function renderAll() { renderGrid(); renderCards(); }

function showTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  for (const t of ['choose', 'captions']) {
    $(`#${t}`).hidden = t !== tab;
    $(`#tab-${t}`).setAttribute('aria-selected', String(t === tab));
  }
  if (tab === 'captions') renderCards();
  else { flushSaves(); renderGrid(); }
  window.scrollTo({ top: 0 });
}

function setStatus(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}
function showProgress(text) { const p = $('#progress'); p.hidden = false; p.textContent = text; setStatus(text); }
function hideProgress() { $('#progress').hidden = true; }
function setBusy(b) {
  state.busy = b;
  document.body.classList.toggle('busy', b);
  for (const id of ['#file-input', '#folder-input']) $(id).disabled = b;
  renderCounts();
}

// Any change to photos, captions or options makes the last PDF stale.
function invalidatePdf() {
  if (!state.pdf) return;
  URL.revokeObjectURL(state.pdf.url);
  state.pdf = null;
  $('#make-btn').hidden = false;
  $('#dl-btn').hidden = true;
  $('#share-btn').hidden = true;
  renderCounts();
}

// ---------- viewer ----------

function openViewer(id) {
  state.viewer.ids = allSorted().map(p => p.id);
  state.viewer.index = Math.max(0, state.viewer.ids.indexOf(id));
  $('#viewer').hidden = false;
  document.body.classList.add('noscroll');
  paintViewer();
}
function closeViewer() {
  $('#viewer').hidden = true;
  document.body.classList.remove('noscroll');
  renderGrid();
}
function paintViewer() {
  const { ids, index } = state.viewer;
  const rec = state.photos.get(ids[index]);
  if (!rec) return closeViewer();
  $('#viewer-img').src = urlFor(rec, 'full');
  $('#viewer-pos').textContent = `${index + 1} / ${ids.length} · ${formatDate(rec.date) || 'no date'}`;
  const t = $('#viewer-toggle');
  t.textContent = rec.selected ? '✓ In PDF' : 'Add to PDF';
  t.classList.toggle('primary', rec.selected);
  $('#viewer-prev').disabled = index === 0;
  $('#viewer-next').disabled = index === ids.length - 1;
}
function stepViewer(d) {
  const v = state.viewer;
  v.index = Math.min(v.ids.length - 1, Math.max(0, v.index + d));
  paintViewer();
}

// ---------- events ----------

function toggleSelected(rec) {
  rec.selected = !rec.selected;
  db.putPhoto(rec);
  invalidatePdf();
}

function bind() {
  $('#tab-choose').addEventListener('click', () => showTab('choose'));
  $('#tab-captions').addEventListener('click', () => showTab('captions'));

  for (const id of ['#file-input', '#folder-input']) {
    $(id).addEventListener('change', async e => {
      const files = [...e.target.files];
      e.target.value = '';
      await addFiles(files);
    });
  }
  $('#select-all').addEventListener('click', async () => {
    for (const p of state.photos.values()) if (!p.selected) { p.selected = true; await db.putPhoto(p); }
    invalidatePdf(); renderGrid();
  });
  $('#select-none').addEventListener('click', async () => {
    for (const p of state.photos.values()) if (p.selected) { p.selected = false; await db.putPhoto(p); }
    invalidatePdf(); renderGrid();
  });
  $('#remove-unselected').addEventListener('click', async () => {
    const drop = [...state.photos.values()].filter(p => !p.selected);
    if (!drop.length) return setStatus('Every photo is selected.');
    if (!confirm(`Remove ${drop.length} photo${drop.length === 1 ? '' : 's'} that are not selected? Your originals are not touched.`)) return;
    for (const p of drop) { await db.deletePhoto(p.id); state.photos.delete(p.id); dropUrls(p.id); }
    renderAll();
  });
  $('#clear-all').addEventListener('click', async () => {
    if (!confirm('Remove all photos and captions from this app? Your originals are not touched.')) return;
    await db.clearAll();
    for (const id of state.photos.keys()) dropUrls(id);
    state.photos.clear();
    invalidatePdf();
    renderAll();
  });

  // grid: tap toggles, ⤢ opens the viewer
  $('#grid').addEventListener('click', e => {
    const tile = e.target.closest('.tile');
    if (!tile || state.busy) return;
    const rec = state.photos.get(tile.dataset.id);
    if (e.target.closest('.zoom')) return openViewer(rec.id);
    toggleSelected(rec);
    paintTile(tile, rec);
    renderCounts();
  });

  // viewer
  $('#viewer-close').addEventListener('click', closeViewer);
  $('#viewer-prev').addEventListener('click', () => stepViewer(-1));
  $('#viewer-next').addEventListener('click', () => stepViewer(1));
  $('#viewer-toggle').addEventListener('click', () => {
    toggleSelected(state.photos.get(state.viewer.ids[state.viewer.index]));
    paintViewer();
    renderCounts();
  });
  document.addEventListener('keydown', e => {
    if ($('#viewer').hidden) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowLeft') stepViewer(-1);
    else if (e.key === 'ArrowRight') stepViewer(1);
    else if ((e.key === ' ' || e.key === 'Enter') && !e.target.closest('button')) { e.preventDefault(); $('#viewer-toggle').click(); }
  });
  let touchX = null, touchY = null;
  const vimg = $('#viewer-img');
  vimg.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }, { passive: true });
  vimg.addEventListener('touchend', e => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
    touchX = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) stepViewer(dx < 0 ? 1 : -1);
  });

  // caption cards
  const cards = $('#cards');
  cards.addEventListener('input', e => {
    const card = e.target.closest('.card');
    if (!card) return;
    const rec = state.photos.get(card.dataset.id);
    if (e.target.classList.contains('f-caption')) rec.caption = e.target.value;
    else if (e.target.classList.contains('f-date')) { rec.date = e.target.value; rec.dateSource = e.target.value ? 'manual' : ''; }
    else return;
    paintCard(card, rec);
    saveSoon(rec);
    invalidatePdf();
    renderCounts();
  });
  // a changed date can move the photo; re-sort once the date input is left
  cards.addEventListener('change', e => {
    if (!e.target.classList.contains('f-date')) return;
    const id = e.target.closest('.card').dataset.id;
    flushSaves();
    renderCards();
    document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  cards.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || !e.target.classList.contains('f-caption') || e.isComposing) return;
    e.preventDefault();
    const next = e.target.closest('.card').nextElementSibling?.querySelector('.f-caption');
    if (next) { next.focus({ preventScroll: true }); next.closest('.card').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    else e.target.blur();
  });
  cards.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || state.busy) return;
    const rec = state.photos.get(btn.closest('.card').dataset.id);
    if (btn.dataset.act === 'drop') { toggleSelected(rec); renderCards(); }
    else if (btn.dataset.act === 'rotate') { await rotate(rec); renderCards(); }
  });

  // options
  const opts = { layout: '#s-layout', paper: '#s-paper', limitMB: '#s-limit' };
  for (const [key, sel] of Object.entries(opts)) {
    const el = $(sel);
    el.value = state.settings[key];
    el.addEventListener('input', () => {
      state.settings[key] = key === 'limitMB' ? Number(el.value) : el.value;
      db.setMeta('settings', state.settings);
      invalidatePdf();
    });
  }

  $('#make-btn').addEventListener('click', makePdf);
  $('#share-btn').addEventListener('click', () => {
    if (state.pdf) navigator.share({ files: [state.pdf.file], title: state.pdf.file.name }).catch(() => {});
  });

  // laptops: drag and drop, paste
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer.files.length && !state.busy) addFiles(e.dataTransfer.files);
  });
  window.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && !e.target.closest('input,textarea') && !state.busy) addFiles(files);
  });
}

async function rotate(rec) {
  setBusy(true);
  try {
    const src = await decodeAny(rec.blob);
    const full = await drawToJpeg(src, STORE_EDGE, 0.92, 90);
    const thumb = await drawToJpeg(src, THUMB_EDGE, 0.78, 90);
    if (src.close) src.close();
    Object.assign(rec, { blob: full.blob, thumb: thumb.blob, w: full.w, h: full.h });
    dropUrls(rec.id);
    await db.putPhoto(rec);
    invalidatePdf();
  } finally { setBusy(false); }
}

// ---------- PDF ----------

async function makePdf() {
  if (state.busy) return;
  flushSaves();
  const recs = selectedSorted();
  if (!recs.length) return;
  const todo = recs.filter(needsWork);
  if (todo.length) {
    showTab('captions');
    const card = document.querySelector(`.card[data-id="${CSS.escape(todo[0].id)}"]`);
    card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    (card?.querySelector('.f-date.need') || card?.querySelector('.f-caption'))?.focus({ preventScroll: true });
    setStatus(`${todo.length} photo${todo.length === 1 ? ' needs' : 's need'} a caption or date.`, true);
    return;
  }
  setBusy(true);
  try {
    const { bytes, pages, quality, overLimit } = await buildPdf(recs, state.settings, setStatus);
    const fname = `family-photos-${isoOf(new Date())}.pdf`;
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const file = new File([blob], fname, { type: 'application/pdf' });
    state.pdf = { url: URL.createObjectURL(blob), file };
    const dl = $('#dl-btn');
    dl.href = state.pdf.url; dl.download = fname; dl.hidden = false;
    $('#make-btn').hidden = true;
    $('#share-btn').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    const mb = (bytes.length / 1024 / 1024).toFixed(1);
    if (overLimit) setStatus(`${pages} pages, ${mb} MB. Over your ${state.settings.limitMB} MB limit even at the lowest quality; take some photos out.`, true);
    else setStatus(`${pages} page${pages === 1 ? '' : 's'}, ${mb} MB, ${QUALITY[quality].label} quality`);
  } catch (e) {
    console.error(e);
    setStatus(`PDF failed: ${e.message}`, true);
  } finally {
    setBusy(false);
  }
}

// ---------- start ----------

async function drainInbox() {
  const items = await db.takeInbox();
  if (!items.length) return;
  const files = items.map(it => (it.file instanceof File ? it.file : new File([it.file], it.name || 'shared.jpg', { type: it.type || 'image/jpeg' })));
  await addFiles(files, { select: true }); // photos shared one by one from the gallery are a deliberate choice
}

async function main() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker not registered', e));
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if (!window.matchMedia('(pointer: fine)').matches) document.body.classList.add('touch');
  await load();
  bind();
  renderAll();
  await drainInbox();
  if (location.search.includes('shared')) history.replaceState(null, '', location.pathname);
}

main().catch(e => { console.error(e); setStatus(`Start-up failed: ${e.message}`, true); });
