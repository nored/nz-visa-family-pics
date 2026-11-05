import * as db from './db.js';
import { buildPdf, QUALITY } from './pdf.js';

const $ = sel => document.querySelector(sel);
const STORE_EDGE = 2400; // long edge of the copy kept in the browser
const THUMB_EDGE = 480;

const DEFAULT_SETTINGS = {
  title: 'Photographs of our family', subtitle: '', names: '', reference: '',
  layout: '1', paper: 'a4', quality: 'auto', limitMB: 10,
};

const state = {
  photos: new Map(), // id -> record
  order: [],
  settings: { ...DEFAULT_SETTINGS },
  thumbUrls: new Map(),
  pdfUrl: null,
  busy: false,
};

// ---------- image intake ----------

const isHeic = f => /image\/hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name || '');

let heicLoader = null;
function loadHeic2any() {
  if (!heicLoader) {
    heicLoader = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/heic2any.min.js';
      s.onload = () => res(window.heic2any);
      s.onerror = () => rej(new Error('Could not load the HEIC converter'));
      document.head.appendChild(s);
    });
  }
  return heicLoader;
}

async function decodeAny(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch { /* try next */ }
  try {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { URL.revokeObjectURL(url); }
  } catch { /* try next */ }
  if (isHeic(blob)) {
    const heic2any = await loadHeic2any();
    const jpg = await heic2any({ blob, toType: 'image/jpeg', quality: 0.92 });
    return decodeAny(Array.isArray(jpg) ? jpg[0] : jpg);
  }
  throw new Error('This file is not an image the browser can read');
}

async function drawToJpeg(src, edge, quality, rotate = 0) {
  const sw = src.width, sh = src.height;
  const scale = Math.min(1, edge / Math.max(sw, sh));
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
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

async function addFiles(files) {
  files = [...files].filter(f => f && (f.type?.startsWith('image/') || isHeic(f) || !f.type));
  if (!files.length) return;
  const known = new Set([...state.photos.values()].map(p => p.fp));
  let added = 0, skipped = 0, failed = [];
  setBusy(true);
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    showProgress(`Reading photo ${i + 1} of ${files.length}`);
    const fp = `${f.name}|${f.size}`;
    if (known.has(fp)) { skipped++; continue; }
    try {
      let date = await readExifDate(f), dateSource = date ? 'exif' : '';
      if (!date) { date = filenameDate(f.name); if (date) dateSource = 'filename'; }
      const src = await decodeAny(f);
      const full = await drawToJpeg(src, STORE_EDGE, 0.9);
      const thumb = await drawToJpeg(src, THUMB_EDGE, 0.8);
      if (src.close) src.close();
      const rec = {
        id: newId(), fp, name: f.name || 'photo', added: Date.now(),
        blob: full.blob, thumb: thumb.blob, w: full.w, h: full.h,
        date, dateSource, monthOnly: false, place: '', people: '', caption: '',
      };
      await db.putPhoto(rec);
      state.photos.set(rec.id, rec);
      state.order.push(rec.id);
      known.add(fp);
      added++;
    } catch (e) {
      console.error(e);
      failed.push(f.name || 'unnamed file');
    }
  }
  await saveOrder();
  setBusy(false);
  hideProgress();
  render();
  const msg = [];
  if (added) msg.push(`Added ${added} photo${added === 1 ? '' : 's'}.`);
  if (skipped) msg.push(`Skipped ${skipped} already in the list.`);
  if (failed.length) msg.push(`Could not read: ${failed.join(', ')}.`);
  if (msg.length) setStatus(msg.join(' '), failed.length > 0);
}

// ---------- persistence ----------

const saveOrder = () => db.setMeta('order', state.order);
const saveTimers = new Map();
function saveRecordSoon(rec) {
  clearTimeout(saveTimers.get(rec.id));
  saveTimers.set(rec.id, setTimeout(() => { saveTimers.delete(rec.id); db.putPhoto(rec); }, 300));
}
let settingsTimer = null;
function saveSettingsSoon() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => db.setMeta('settings', state.settings), 300);
}

async function load() {
  const [photos, order, settings] = await Promise.all([db.getAllPhotos(), db.getMeta('order'), db.getMeta('settings')]);
  for (const p of photos) state.photos.set(p.id, p);
  const ids = new Set(state.photos.keys());
  state.order = (order || []).filter(id => ids.has(id));
  for (const p of photos.sort((a, b) => a.added - b.added)) if (!state.order.includes(p.id)) state.order.push(p.id);
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// ---------- rendering ----------

function missing(rec) {
  const m = [];
  if (!rec.date) m.push('date');
  if (!rec.caption.trim()) m.push('description');
  return m;
}

function dateSourceText(rec) {
  if (!rec.date) return 'No date in the photo. Enter the date it was taken.';
  if (rec.dateSource === 'exif') return 'Date read from the photo.';
  if (rec.dateSource === 'filename') return 'Date read from the file name. Check it.';
  return '';
}

function render() {
  const list = $('#list');
  for (const url of state.thumbUrls.values()) URL.revokeObjectURL(url);
  state.thumbUrls.clear();
  list.textContent = '';
  const tpl = $('#item-tpl');
  state.order.forEach((id, idx) => {
    const rec = state.photos.get(id);
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = id;
    const url = URL.createObjectURL(rec.thumb);
    state.thumbUrls.set(id, url);
    const img = node.querySelector('.thumb');
    img.src = url;
    img.alt = rec.caption || `Photo ${idx + 1}`;
    node.querySelector('.fig').textContent = `${idx + 1}`;
    const fDate = node.querySelector('.f-date');
    fDate.value = rec.date;
    node.querySelector('.f-month').checked = !!rec.monthOnly;
    node.querySelector('.f-place').value = rec.place;
    node.querySelector('.f-people').value = rec.people;
    node.querySelector('.f-caption').value = rec.caption;
    node.querySelector('.date-src').textContent = dateSourceText(rec);
    node.querySelector('[data-act=up]').disabled = idx === 0;
    node.querySelector('[data-act=down]').disabled = idx === state.order.length - 1;
    markMissing(node, rec);
    list.appendChild(node);
  });
  updateCounts();
}

function markMissing(node, rec) {
  const m = missing(rec);
  node.classList.toggle('incomplete', m.length > 0);
  node.querySelector('.f-date').classList.toggle('need', !rec.date);
  node.querySelector('.f-caption').classList.toggle('need', !rec.caption.trim());
  node.querySelector('.date-src').classList.toggle('missing', !rec.date);
}

function updateCounts() {
  const n = state.order.length;
  const incomplete = state.order.filter(id => missing(state.photos.get(id)).length).length;
  $('#count').textContent = n ? `(${n})` : '';
  $('#empty').hidden = n > 0;
  $('#sort-btn').hidden = n < 2;
  const btn = $('#make-btn');
  btn.disabled = state.busy || n === 0;
  if (!state.busy) {
    if (n === 0) setStatus('Add photos to start.');
    else if (incomplete) setStatus(`${incomplete} photo${incomplete === 1 ? ' needs' : 's need'} a date or description.`);
    else setStatus(`${n} photo${n === 1 ? '' : 's'} ready.`);
  }
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
  $('#make-btn').disabled = b || state.order.length === 0;
  $('#file-input').disabled = b;
  document.body.classList.toggle('busy', b);
}

function settingsHint() {
  const s = state.settings;
  const parts = [s.names || 'no names yet', s.layout === '2' ? '2 per page' : '1 per page', s.paper === 'letter' ? 'Letter' : 'A4'];
  $('#settings-hint').textContent = parts.join(' · ');
}

// ---------- events ----------

function bindSettings() {
  const map = { title: '#s-title', subtitle: '#s-subtitle', names: '#s-names', reference: '#s-reference',
    layout: '#s-layout', paper: '#s-paper', quality: '#s-quality', limitMB: '#s-limit' };
  for (const [key, sel] of Object.entries(map)) {
    const el = $(sel);
    el.value = state.settings[key];
    el.addEventListener('input', () => {
      state.settings[key] = key === 'limitMB' ? Number(el.value) : el.value;
      saveSettingsSoon();
      settingsHint();
    });
  }
  settingsHint();
  if (!state.settings.names) $('#settings-card').open = true;
}

function bindList() {
  const list = $('#list');
  list.addEventListener('input', e => {
    const li = e.target.closest('.item');
    if (!li) return;
    const rec = state.photos.get(li.dataset.id);
    const t = e.target;
    if (t.classList.contains('f-date')) { rec.date = t.value; rec.dateSource = t.value ? 'manual' : ''; li.querySelector('.date-src').textContent = dateSourceText(rec); }
    else if (t.classList.contains('f-month')) rec.monthOnly = t.checked;
    else if (t.classList.contains('f-place')) rec.place = t.value;
    else if (t.classList.contains('f-people')) rec.people = t.value;
    else if (t.classList.contains('f-caption')) rec.caption = t.value;
    else return;
    markMissing(li, rec);
    saveRecordSoon(rec);
    updateCounts();
  });
  list.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || state.busy) return;
    const id = btn.closest('.item').dataset.id;
    const i = state.order.indexOf(id);
    const act = btn.dataset.act;
    if (act === 'up' && i > 0) [state.order[i - 1], state.order[i]] = [state.order[i], state.order[i - 1]];
    else if (act === 'down' && i < state.order.length - 1) [state.order[i + 1], state.order[i]] = [state.order[i], state.order[i + 1]];
    else if (act === 'remove') {
      if (!confirm('Remove this photo?')) return;
      state.order.splice(i, 1);
      state.photos.delete(id);
      await db.deletePhoto(id);
    } else if (act === 'rotate') {
      await rotate(id);
    } else return;
    await saveOrder();
    render();
    const again = document.querySelector(`.item[data-id="${CSS.escape(id)}"] button[data-act="${act}"]`);
    if (again && !again.disabled) again.focus();
  });
}

async function rotate(id) {
  const rec = state.photos.get(id);
  setBusy(true);
  try {
    const src = await decodeAny(rec.blob);
    const full = await drawToJpeg(src, STORE_EDGE, 0.92, 90);
    const thumb = await drawToJpeg(src, THUMB_EDGE, 0.8, 90);
    if (src.close) src.close();
    Object.assign(rec, { blob: full.blob, thumb: thumb.blob, w: full.w, h: full.h });
    await db.putPhoto(rec);
  } finally { setBusy(false); }
}

function bindIntake() {
  $('#file-input').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    await addFiles(files);
  });
  $('#sort-btn').addEventListener('click', async () => {
    const pos = new Map(state.order.map((id, i) => [id, i]));
    state.order.sort((a, b) => {
      const da = state.photos.get(a).date || '9999', dbb = state.photos.get(b).date || '9999';
      return da < dbb ? -1 : da > dbb ? 1 : pos.get(a) - pos.get(b);
    });
    await saveOrder();
    render();
    setStatus('Sorted by date, oldest first. Photos without a date are at the end.');
  });
  // drag and drop on laptops
  const drop = $('#drop');
  let depth = 0;
  window.addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files')) { depth++; drop.hidden = false; } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) drop.hidden = true; });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    depth = 0; drop.hidden = true;
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  // paste screenshots
  window.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && !e.target.closest('input,textarea')) addFiles(files);
  });
  $('#clear-btn').addEventListener('click', async () => {
    if (!confirm('Delete all photos and descriptions from this browser? This cannot be undone.')) return;
    await db.clearAll();
    state.photos.clear(); state.order = [];
    $('#out-card').hidden = true;
    render();
  });
}

// ---------- PDF ----------

async function makePdf() {
  if (state.busy || !state.order.length) return;
  const recs = state.order.map(id => state.photos.get(id));
  const bad = recs.map((r, i) => ({ i, m: missing(r) })).filter(x => x.m.length);
  if (bad.length) {
    const first = document.querySelector(`.item[data-id="${CSS.escape(recs[bad[0].i].id)}"]`);
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    first?.querySelector('.need')?.focus({ preventScroll: true });
    const nums = bad.slice(0, 8).map(x => x.i + 1).join(', ') + (bad.length > 8 ? ', ...' : '');
    setStatus(`Every photo needs a date and a description. Missing in photo ${nums}.`, true);
    return;
  }
  setBusy(true);
  try {
    const { bytes, quality, pages, overLimit } = await buildPdf(recs, state.settings, showProgress);
    if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    state.pdfUrl = URL.createObjectURL(blob);
    const fname = `family-photos-${new Date().toISOString().slice(0, 10)}.pdf`;
    const mb = (bytes.length / 1024 / 1024).toFixed(1);
    $('#out-info').textContent = `${fname}: ${pages} pages, ${mb} MB, ${QUALITY[quality].label.toLowerCase()} image quality.`;
    const warn = $('#out-warn');
    warn.hidden = !overLimit;
    if (overLimit) {
      warn.textContent = `This file is over your ${state.settings.limitMB} MB limit even at the smallest image quality. Remove some photos and create the PDF again.`;
    }
    const dl = $('#out-download');
    dl.href = state.pdfUrl; dl.download = fname;
    $('#out-open').href = state.pdfUrl;
    const file = new File([blob], fname, { type: 'application/pdf' });
    const share = $('#out-share');
    share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    share.onclick = () => navigator.share({ files: [file], title: fname }).catch(() => {});
    $('#out-card').hidden = false;
    $('#out-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setStatus(`PDF ready: ${pages} pages, ${mb} MB.`);
  } catch (e) {
    console.error(e);
    setStatus(`PDF failed: ${e.message}`, true);
  } finally {
    hideProgress();
    setBusy(false);
  }
}

// ---------- share target and service worker ----------

async function drainInbox() {
  const items = await db.takeInbox();
  if (!items.length) return;
  const files = items.map(it => (it.file instanceof File ? it.file : new File([it.file], it.name || 'shared.jpg', { type: it.type || 'image/jpeg' })));
  await addFiles(files);
}

async function main() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker not registered', e));
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  await load();
  bindSettings();
  bindList();
  bindIntake();
  $('#make-btn').addEventListener('click', makePdf);
  render();
  await drainInbox();
  if (location.search.includes('shared')) history.replaceState(null, '', location.pathname);
}

main().catch(e => { console.error(e); setStatus(`Start-up failed: ${e.message}`, true); });
