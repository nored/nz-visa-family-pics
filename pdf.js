// PDF typesetting with pdf-lib and FPE Roman, a TrueType conversion of Latin Modern (the default LaTeX typeface).
// Runs entirely in the browser. Uses the globals PDFLib and fontkit from vendor/.

const PAPER = { a4: [595.28, 841.89], letter: [612, 792] };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export const QUALITY = {
  high: { edge: 2400, q: 0.88, label: 'High' },
  standard: { edge: 1800, q: 0.82, label: 'Standard' },
  small: { edge: 1400, q: 0.75, label: 'Small' },
  tiny: { edge: 1000, q: 0.7, label: 'Very small' },
};
const AUTO_ORDER = ['high', 'standard', 'small', 'tiny'];

export function formatDate(iso, monthOnly) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m) return '';
  return monthOnly ? `${MONTHS[m - 1]} ${y}` : `${d} ${MONTHS[m - 1]} ${y}`;
}

function todayIso() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

let fontBytes = null;
async function loadFontBytes() {
  if (fontBytes) return fontBytes;
  const names = ['regular', 'bold', 'italic'];
  const bufs = await Promise.all(names.map(n =>
    fetch(`fonts/fperoman-${n}.ttf`).then(r => {
      if (!r.ok) throw new Error(`Font ${n} failed to load (${r.status})`);
      return r.arrayBuffer();
    })));
  fontBytes = Object.fromEntries(names.map((n, i) => [n, bufs[i]]));
  return fontBytes;
}

// ---------- image re-encoding ----------

async function decodeBlob(blob) {
  if (self.createImageBitmap) {
    try { return await createImageBitmap(blob); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function encodeJpeg(blob, edge, quality) {
  const src = await decodeBlob(blob);
  const w0 = src.width, h0 = src.height;
  const scale = Math.min(1, edge / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  const out = await new Promise((res, rej) =>
    canvas.toBlob(b => (b ? res(b) : rej(new Error('JPEG encoding failed'))), 'image/jpeg', quality));
  canvas.width = canvas.height = 0; // free memory on iOS
  return { bytes: new Uint8Array(await out.arrayBuffer()), w, h };
}

// ---------- text handling ----------

function makeSanitizer(fonts) {
  const sets = Object.values(fonts).map(f => new Set(f.getCharacterSet()));
  const ok = cp => sets.every(s => s.has(cp));
  const subst = { 0x2026: '...', 0x2013: '-', 0x2014: '-', 0x2018: "'", 0x2019: "'", 0x201C: '"', 0x201D: '"', 0x00A0: ' ' };
  return (text) => {
    let out = '';
    const typographic = String(text || '').replace(/\s+/g, ' ').replace(/(\p{L})'(\p{L})/gu, '$1’$2');
    for (const ch of typographic) {
      const cp = ch.codePointAt(0);
      if (ok(cp)) out += ch;
      else if (subst[cp] && [...subst[cp]].every(c => ok(c.codePointAt(0)))) out += subst[cp];
      else if (/\p{Extended_Pictographic}|\p{M}|[️‍]/u.test(ch)) continue; // emoji, joiners
      else {
        const base = ch.normalize('NFD')[0];
        out += ok(base.codePointAt(0)) ? base : '?';
      }
    }
    return out.trim();
  };
}

// Break styled runs into lines. runs: [{text, font, size}]
function breakLines(runs, width) {
  const tokens = [];
  for (const r of runs) {
    for (const word of r.text.split(' ').filter(Boolean)) {
      let w = r.font.widthOfTextAtSize(word, r.size);
      if (w <= width) { tokens.push({ text: word, font: r.font, size: r.size, w }); continue; }
      // a single word wider than the line: hard-break by characters
      let chunk = '';
      for (const ch of word) {
        const next = chunk + ch;
        if (r.font.widthOfTextAtSize(next, r.size) > width && chunk) {
          tokens.push({ text: chunk, font: r.font, size: r.size, w: r.font.widthOfTextAtSize(chunk, r.size) });
          chunk = ch;
        } else chunk = next;
      }
      if (chunk) tokens.push({ text: chunk, font: r.font, size: r.size, w: r.font.widthOfTextAtSize(chunk, r.size) });
    }
  }
  const lines = [];
  let cur = [], curW = 0;
  for (const t of tokens) {
    const space = cur.length ? spaceWidth(cur[cur.length - 1]) : 0;
    if (cur.length && curW + space + t.w > width) {
      lines.push(cur); cur = [t]; curW = t.w;
    } else { cur.push(t); curW += space + t.w; }
  }
  if (cur.length) lines.push(cur);
  return lines;
}
const spaceWidth = t => t.font.widthOfTextAtSize(' ', t.size);
const lineNatural = line => line.reduce((s, t, i) => s + t.w + (i ? spaceWidth(line[i - 1]) : 0), 0);

// Draw lines. align: 'justify' | 'center' | 'left'. Returns total height used.
function drawLines(page, lines, x, yTop, width, size, leading, align, color) {
  const ascent = size * 0.75;
  lines.forEach((line, i) => {
    const baseline = yTop - ascent - i * leading;
    const natural = lineNatural(line);
    const last = i === lines.length - 1;
    let cx = x, gapExtra = 0;
    if (align === 'center' || (align === 'justify' && lines.length === 1)) cx = x + (width - natural) / 2;
    else if (align === 'justify' && !last && line.length > 1) gapExtra = (width - natural) / (line.length - 1);
    line.forEach((t, j) => {
      if (j) cx += spaceWidth(line[j - 1]) + gapExtra;
      page.drawText(t.text, { x: cx, y: baseline, size: t.size, font: t.font, color });
      cx += t.w;
    });
  });
  return linesHeight(lines.length, size, leading);
}
const linesHeight = (n, size, leading) => (n ? size * 0.75 + (n - 1) * leading + size * 0.3 : 0);

function fitText(text, font, size, width) {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(text.slice(0, mid).trimEnd() + '...', size) <= width) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + '...';
}

// ---------- document ----------

/**
 * photos: [{blob, date, monthOnly, place, people, caption}]
 * settings: {title, subtitle, names, reference, layout (1|2), paper, quality, limitMB}
 * onProgress(message)
 */
export async function buildPdf(photos, settings, onProgress = () => {}) {
  const limit = Math.max(0.1, Number(settings.limitMB) || 10) * 1024 * 1024;
  const order = settings.quality === 'auto' ? AUTO_ORDER : [settings.quality];
  let result = null;
  for (const key of order) {
    const preset = QUALITY[key];
    const isLast = key === order[order.length - 1];
    const images = [];
    let imageBytes = 0;
    for (let i = 0; i < photos.length; i++) {
      onProgress(`Compressing photo ${i + 1} of ${photos.length} (${preset.label.toLowerCase()} quality)`);
      const e = await encodeJpeg(photos[i].blob, preset.edge, preset.q);
      images.push(e);
      imageBytes += e.bytes.length;
      if (!isLast && imageBytes > limit) break; // the images alone are already too big
    }
    if (!isLast && imageBytes > limit) continue;
    const { bytes, pages } = await typeset(photos, images, settings, onProgress);
    result = { bytes, pages, quality: key, overLimit: bytes.length > limit };
    if (bytes.length <= limit) break;
  }
  return result;
}

async function typeset(photos, images, settings, onProgress) {
  const { PDFDocument, rgb } = self.PDFLib;
  const ink = rgb(0, 0, 0), grey = rgb(0.35, 0.35, 0.35);

  onProgress('Typesetting');
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(self.fontkit);
  const fb = await loadFontBytes();
  const F = {
    regular: await pdf.embedFont(fb.regular, { subset: false }),
    bold: await pdf.embedFont(fb.bold, { subset: false }),
    italic: await pdf.embedFont(fb.italic, { subset: false }),
  };
  const clean = makeSanitizer(F);

  const [PW, PH] = PAPER[settings.paper] || PAPER.a4;
  const M = { x: 64, top: 64, bottom: 64 };
  const CW = PW - 2 * M.x;
  const contentTop = PH - M.top, contentBottom = M.bottom;

  const title = clean(settings.title) || 'Photographs of our family';
  const subtitle = clean(settings.subtitle);
  const names = clean(settings.names);
  const reference = clean(settings.reference);
  const perPage = Number(settings.layout) === 2 ? 2 : 1;

  const items = photos.map(p => ({
    date: formatDate(p.date, p.monthOnly),
    place: clean(p.place),
    people: clean(p.people),
    caption: clean(p.caption),
    iso: p.date,
  }));

  // ---- cover page measurement ----
  const coverBlocks = [];
  const addBlock = (text, font, size, leading, gapBefore, align = 'center') => {
    if (!text) return;
    const lines = breakLines([{ text, font, size }], CW);
    coverBlocks.push({ lines, size, leading, gapBefore, align });
  };
  addBlock(title, F.bold, 20, 25, 40);
  addBlock(subtitle, F.italic, 12.5, 16, 12);
  addBlock(names, F.regular, 13, 17, 22);
  addBlock(reference, F.regular, 10.5, 14, 8);
  addBlock(`Prepared ${formatDate(todayIso())}`, F.italic, 10.5, 14, 6);

  const dated = items.map(i => i.iso).filter(Boolean).sort();
  const range = dated.length
    ? (formatDate(dated[0].slice(0, 7) + '-01', true) === formatDate(dated[dated.length - 1].slice(0, 7) + '-01', true)
      ? `taken in ${formatDate(dated[0], true)}`
      : `dated from ${formatDate(dated[0], true)} to ${formatDate(dated[dated.length - 1], true)}`)
    : '';
  const n = items.length;
  const summary = `This document contains ${n} photograph${n === 1 ? '' : 's'}${range ? ' ' + range : ''}. `
    + 'Each photograph is printed with the date it was taken and a description.';
  addBlock(summary, F.regular, 11, 14.5, 30, 'justify');

  let coverHeight = 0;
  for (const b of coverBlocks) coverHeight += b.gapBefore + linesHeight(b.lines.length, b.size, b.leading);
  const LIST_HEAD_GAP = 26, LIST_HEAD = 16, ROW = 15;
  const firstListY = contentTop - coverHeight - LIST_HEAD_GAP - LIST_HEAD;
  const rowsFirst = Math.max(0, Math.floor((firstListY - contentBottom) / ROW));
  const rowsNext = Math.floor((contentTop - contentBottom) / ROW);
  const listPages = 1 + (n > rowsFirst ? Math.ceil((n - rowsFirst) / rowsNext) : 0);
  const figPages = Math.ceil(n / perPage);
  const totalPages = listPages + figPages;
  const pageOf = i => listPages + Math.floor(i / perPage) + 1;

  const footer = (page, num) => {
    const t = `Page ${num} of ${totalPages}`;
    page.drawText(t, { x: (PW - F.regular.widthOfTextAtSize(t, 9)) / 2, y: 34, size: 9, font: F.regular, color: grey });
  };
  const header = (page) => {
    const half = CW / 2 - 8;
    const left = fitText(title, F.italic, 9, names ? half : CW);
    page.drawText(left, { x: M.x, y: PH - 42, size: 9, font: F.italic, color: grey });
    if (names) {
      const right = fitText(names, F.italic, 9, half);
      page.drawText(right, { x: PW - M.x - F.italic.widthOfTextAtSize(right, 9), y: PH - 42, size: 9, font: F.italic, color: grey });
    }
    page.drawLine({ start: { x: M.x, y: PH - 48 }, end: { x: PW - M.x, y: PH - 48 }, thickness: 0.4, color: grey });
  };

  // ---- cover page and list of photographs ----
  let page = pdf.addPage([PW, PH]);
  let pageNum = 1;
  let y = contentTop;
  for (const b of coverBlocks) {
    y -= b.gapBefore;
    y -= drawLines(page, b.lines, M.x, y, CW, b.size, b.leading, b.align, ink);
  }
  y -= LIST_HEAD_GAP;
  page.drawText('List of photographs', { x: M.x, y: y - 12, size: 12, font: F.bold, color: ink });
  y -= LIST_HEAD;
  let rowsLeft = rowsFirst;
  const numW = 26, pageColW = 30;
  for (let i = 0; i < n; i++) {
    if (rowsLeft <= 0) {
      footer(page, pageNum);
      page = pdf.addPage([PW, PH]); pageNum++;
      header(page);
      y = contentTop; rowsLeft = rowsNext;
    }
    const it = items[i];
    const base = y - 11;
    const num = `${i + 1}`;
    page.drawText(num, { x: M.x + numW - 8 - F.regular.widthOfTextAtSize(num, 10), y: base, size: 10, font: F.regular, color: ink });
    const pnum = `${pageOf(i)}`;
    const pnW = F.regular.widthOfTextAtSize(pnum, 10);
    page.drawText(pnum, { x: PW - M.x - pnW, y: base, size: 10, font: F.regular, color: ink });
    const textW = CW - numW - pageColW;
    const head = [it.date, it.place].filter(Boolean).join(', ');
    const entry = fitText(head + (it.caption ? `. ${it.caption}` : ''), F.regular, 10, textW);
    page.drawText(entry, { x: M.x + numW, y: base, size: 10, font: F.regular, color: ink });
    // dot leaders
    const dotsStart = M.x + numW + F.regular.widthOfTextAtSize(entry, 10) + 6;
    const dotsEnd = PW - M.x - pnW - 6;
    for (let dx = Math.ceil(dotsStart / 4.5) * 4.5; dx < dotsEnd; dx += 4.5) {
      page.drawText('.', { x: dx, y: base, size: 10, font: F.regular, color: grey });
    }
    y -= ROW; rowsLeft--;
  }
  footer(page, pageNum);

  // ---- figure pages ----
  const CAP = 10, CAP_LEAD = 13, GAP_IMG_CAP = 9, GAP_FIG = 22;
  const slotH = perPage === 1 ? (contentTop - contentBottom) : (contentTop - contentBottom - GAP_FIG) / 2;
  for (let i = 0; i < n; i++) {
    onProgress(`Placing photo ${i + 1} of ${n}`);
    const slot = i % perPage;
    if (slot === 0) {
      page = pdf.addPage([PW, PH]); pageNum++;
      header(page); footer(page, pageNum);
    }
    const it = items[i];
    const img = await pdf.embedJpg(images[i].bytes);
    const runs = [{ text: `Photograph ${i + 1}.`, font: F.bold, size: CAP }];
    const meta = [it.date, it.place].filter(Boolean).join(', ');
    if (meta) runs.push({ text: meta + '.', font: F.italic, size: CAP });
    if (it.caption) runs.push({ text: /[.!?]$/.test(it.caption) ? it.caption : it.caption + '.', font: F.regular, size: CAP });
    if (it.people) runs.push({ text: `Shown: ${it.people}${/[.!?]$/.test(it.people) ? '' : '.'}`, font: F.italic, size: CAP });
    const capW = CW * 0.92;
    const lines = breakLines(runs, capW);
    const capH = linesHeight(lines.length, CAP, CAP_LEAD);
    const slotTop = contentTop - slot * (slotH + GAP_FIG);
    const boxH = Math.max(slotH * 0.35, slotH - capH - GAP_IMG_CAP);
    const s = Math.min(CW / img.width, boxH / img.height);
    const w = img.width * s, h = img.height * s;
    // single photo per page: centre image+caption vertically in the slot, LaTeX float-page style
    const blockH = h + GAP_IMG_CAP + capH;
    const top = perPage === 1 ? slotTop - Math.max(0, (slotH - blockH) / 2) : slotTop;
    page.drawImage(img, { x: M.x + (CW - w) / 2, y: top - h, width: w, height: h });
    drawLines(page, lines, M.x + (CW - capW) / 2, top - h - GAP_IMG_CAP, capW, CAP, CAP_LEAD, 'justify', ink);
  }

  pdf.setTitle(title);
  if (names) pdf.setAuthor(names);
  if (subtitle) pdf.setSubject(subtitle);
  pdf.setCreator('Family Photo Evidence');
  pdf.setProducer('Family Photo Evidence (pdf-lib)');
  pdf.setCreationDate(new Date());

  onProgress('Saving PDF');
  const bytes = await pdf.save();
  return { bytes, pages: totalPages };
}
