// PDF typesetting with pdf-lib and DejaVu Sans, laid out like a LaTeX figure page.
// Runs entirely in the browser. Uses the globals PDFLib and fontkit.
// Output is deliberately minimal: each photo, a LaTeX-style caption, and a page number.

const PAPER = { a4: [595.28, 841.89], letter: [612, 792] };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export const QUALITY = {
  high: { edge: 2000, q: 0.88, label: 'high' },
  standard: { edge: 1600, q: 0.82, label: 'standard' },
  small: { edge: 1300, q: 0.75, label: 'small' },
  tiny: { edge: 1000, q: 0.7, label: 'very small' },
};
const AUTO_ORDER = ['high', 'standard', 'small', 'tiny'];

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
export const monthLabel = iso => {
  const [y, m] = (iso || '').split('-').map(Number);
  return y && m ? `${MONTHS[m - 1]} ${y}` : 'No date';
};

let fontBytes = null;
async function loadFontBytes() {
  if (fontBytes) return fontBytes;
  const names = ['regular', 'bold', 'italic'];
  const files = { regular: 'DejaVuSans.ttf', bold: 'DejaVuSans-Bold.ttf', italic: 'DejaVuSans-Oblique.ttf' };
  const bufs = await Promise.all(names.map(n =>
    fetch(`fonts/${files[n]}`).then(r => {
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

async function encodeJpeg(blob, edge, quality) {
  const src = await decodeBlob(blob);
  const scale = Math.min(1, edge / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
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
  return new Uint8Array(await out.arrayBuffer());
}

// ---------- text handling ----------

function makeSanitizer(fonts) {
  const sets = Object.values(fonts).map(f => new Set(f.getCharacterSet()));
  const ok = cp => sets.every(s => s.has(cp));
  const subst = { 0x2026: '...', 0x2013: '-', 0x2014: '-', 0x00A0: ' ' };
  return (text) => {
    let out = '';
    const typographic = String(text || '').replace(/\s+/g, ' ').replace(/(\p{L})'(\p{L})/gu, '$1’$2');
    for (const ch of typographic) {
      const cp = ch.codePointAt(0);
      if (ok(cp)) out += ch;
      else if (subst[cp]) out += subst[cp];
      else if (/\p{Extended_Pictographic}|\p{M}|[️‍]/u.test(ch)) continue; // emoji, joiners
      else {
        const base = ch.normalize('NFD')[0];
        out += ok(base.codePointAt(0)) ? base : '?';
      }
    }
    return out.trim();
  };
}

const spaceWidth = t => t.font.widthOfTextAtSize(' ', t.size);
const lineNatural = line => line.reduce((s, t, i) => s + t.w + (i ? spaceWidth(line[i - 1]) : 0), 0);
const linesHeight = (n, size, leading) => (n ? size * 0.75 + (n - 1) * leading + size * 0.3 : 0);

// Break styled runs [{text, font, size}] into lines no wider than `width`.
function breakLines(runs, width) {
  const tokens = [];
  const push = (text, r) => tokens.push({ text, font: r.font, size: r.size, w: r.font.widthOfTextAtSize(text, r.size) });
  for (const r of runs) {
    for (const word of r.text.split(' ').filter(Boolean)) {
      if (r.font.widthOfTextAtSize(word, r.size) <= width) { push(word, r); continue; }
      let chunk = ''; // a single word wider than the line: hard-break by characters
      for (const ch of word) {
        if (chunk && r.font.widthOfTextAtSize(chunk + ch, r.size) > width) { push(chunk, r); chunk = ch; } else chunk += ch;
      }
      if (chunk) push(chunk, r);
    }
  }
  const lines = [];
  let cur = [], curW = 0;
  for (const t of tokens) {
    const space = cur.length ? spaceWidth(cur[cur.length - 1]) : 0;
    if (cur.length && curW + space + t.w > width) { lines.push(cur); cur = [t]; curW = t.w; } else { cur.push(t); curW += space + t.w; }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

// LaTeX caption style: a one-line caption is centred, a longer one is justified with a ragged last line.
function drawCaption(page, lines, x, yTop, width, size, leading, color) {
  lines.forEach((line, i) => {
    const baseline = yTop - size * 0.75 - i * leading;
    const natural = lineNatural(line);
    let cx = x, gapExtra = 0;
    if (lines.length === 1) cx = x + (width - natural) / 2;
    else if (i < lines.length - 1 && line.length > 1) gapExtra = (width - natural) / (line.length - 1);
    line.forEach((t, j) => {
      if (j) cx += spaceWidth(line[j - 1]) + gapExtra;
      page.drawText(t.text, { x: cx, y: baseline, size: t.size, font: t.font, color });
      cx += t.w;
    });
  });
}

// ---------- document ----------

/**
 * photos: [{blob, date, caption}] in print order
 * settings: {layout ('1'|'2'), paper ('a4'|'letter'), limitMB}
 * onProgress(message)
 * Returns {bytes, pages, quality, overLimit}.
 */
export async function buildPdf(photos, settings, onProgress = () => {}) {
  const limit = Math.max(0.1, Number(settings.limitMB) || 10) * 1024 * 1024;
  let result = null;
  for (const key of AUTO_ORDER) {
    const preset = QUALITY[key];
    const isLast = key === AUTO_ORDER[AUTO_ORDER.length - 1];
    const images = [];
    let imageBytes = 0;
    for (let i = 0; i < photos.length; i++) {
      onProgress(`Compressing photo ${i + 1} of ${photos.length} (${preset.label} quality)`);
      const bytes = await encodeJpeg(photos[i].blob, preset.edge, preset.q);
      images.push(bytes);
      imageBytes += bytes.length;
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
  const ink = rgb(0, 0, 0);
  onProgress('Typesetting');
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(self.fontkit);
  const fb = await loadFontBytes();
  const F = {
    regular: await pdf.embedFont(fb.regular, { subset: true }),
    bold: await pdf.embedFont(fb.bold, { subset: true }),
    italic: await pdf.embedFont(fb.italic, { subset: true }),
  };
  const clean = makeSanitizer(F);

  const [PW, PH] = PAPER[settings.paper] || PAPER.a4;
  const MX = 64, MTOP = 56, MBOTTOM = 64;
  const CW = PW - 2 * MX;
  const top = PH - MTOP, bottom = MBOTTOM;
  const perPage = String(settings.layout) === '2' ? 2 : 1;
  const n = photos.length;
  const CAP = 10, LEAD = 13.5, GAP_IMG_CAP = 10, GAP_FIG = 26;
  const slotH = perPage === 1 ? top - bottom : (top - bottom - GAP_FIG) / 2;
  const capW = CW * 0.9;

  let page = null, pageNum = 0;
  for (let i = 0; i < n; i++) {
    onProgress(`Placing photo ${i + 1} of ${n}`);
    const slot = i % perPage;
    if (slot === 0) {
      page = pdf.addPage([PW, PH]); pageNum++;
      const num = String(pageNum);
      page.drawText(num, { x: (PW - F.regular.widthOfTextAtSize(num, 10)) / 2, y: 34, size: 10, font: F.regular, color: ink });
    }
    const img = await pdf.embedJpg(images[i]);
    const caption = clean(photos[i].caption);
    const runs = [{ text: `Figure ${i + 1}.`, font: F.bold, size: CAP }];
    const date = formatDate(photos[i].date);
    if (date) runs.push({ text: `${date}.`, font: F.italic, size: CAP });
    if (caption) runs.push({ text: /[.!?"”)]$/.test(caption) ? caption : caption + '.', font: F.regular, size: CAP });
    const lines = breakLines(runs, capW);
    const capH = linesHeight(lines.length, CAP, LEAD);
    const slotTop = top - slot * (slotH + GAP_FIG);
    const boxH = Math.max(slotH * 0.35, slotH - capH - GAP_IMG_CAP);
    const s = Math.min(CW / img.width, boxH / img.height);
    const w = img.width * s, h = img.height * s;
    // centre figure + caption in its slot, as LaTeX does on a float page
    const blockH = h + GAP_IMG_CAP + capH;
    const y0 = slotTop - Math.max(0, (slotH - blockH) / 2);
    page.drawImage(img, { x: MX + (CW - w) / 2, y: y0 - h, width: w, height: h });
    drawCaption(page, lines, MX + (CW - capW) / 2, y0 - h - GAP_IMG_CAP, capW, CAP, LEAD, ink);
  }

  pdf.setTitle('Family photographs');
  pdf.setCreator('Family Photo Evidence');
  pdf.setProducer('Family Photo Evidence (pdf-lib)');
  pdf.setCreationDate(new Date());
  onProgress('Saving PDF');
  const bytes = await pdf.save();
  return { bytes, pages: pageNum };
}
