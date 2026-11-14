// Synthetic print jobs. Every case is a real file (PDF via pdf-lib, PNG/JPEG via canvas) plus partial intake data and
// a ground-truth intent. The generator picks the intent first, then samples evidence that is typical but noisy:
// missing fields, misleading filenames, notes from the wrong family, unusual geometry. Labels are true by construction,
// which is exactly why the hand-written set (handset.ts) exists as a separate check.
import { PDFDocument, PDFName, PDFNumber, PDFOperator, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas, Path2D } from '@napi-rs/canvas';
import zlib from 'node:zlib';
import type { Intake, Intent, Media } from '../src/features.ts';

export const PT = 72 / 25.4;

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    range: (lo: number, hi: number) => lo + next() * (hi - lo),
    logRange: (lo: number, hi: number) => Math.exp(Math.log(lo) + next() * (Math.log(hi) - Math.log(lo))),
    chance: (p: number) => next() < p,
  };
}
export type Rng = ReturnType<typeof rng>;

// ---------- shapes (SVG path data in a W×H box, y down) ----------

export type ShapeKind =
  | 'circle' | 'blob' | 'star' | 'badge' | 'multi' // sticker-like, irregular
  | 'rect' | 'rect-rounded' | 'rect-stripe' // label-like
  | 'poster-full' | 'poster-margin' | 'poster-grid' // poster-like
  | 'banner-bands' | 'banner-split'; // banner-like

const circle = (cx: number, cy: number, r: number) => `M${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} Z`;
const rect = (x: number, y: number, w: number, h: number) => `M${x} ${y} H${x + w} V${y + h} H${x} Z`;
const rrect = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + h - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h} H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r} V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`;
function blob(r: Rng, cx: number, cy: number, rad: number, lobes = 7) {
  const n = 48, ph = r.range(0, 6.28), amp = r.range(0.08, 0.22), k = Math.floor(r.range(3, lobes));
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI, rr = rad * (1 + amp * Math.sin(k * a + ph) + 0.05 * Math.sin(2 * a));
    return `${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`;
  });
  return `M${pts.join(' L')} Z`;
}
function star(cx: number, cy: number, R: number, points = 5) {
  const pts = Array.from({ length: points * 2 }, (_, i) => {
    const a = (i / (points * 2)) * 2 * Math.PI - Math.PI / 2, rr = i % 2 ? R * 0.48 : R;
    return `${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`;
  });
  return `M${pts.join(' L')} Z`;
}

type Layer = { d: string; fill: [number, number, number] };
const PALETTES: Array<Array<[number, number, number]>> = [
  [[0.93, 0.33, 0.24], [0.98, 0.8, 0.3], [0.15, 0.2, 0.3]],
  [[0.2, 0.55, 0.45], [0.95, 0.93, 0.85], [0.1, 0.25, 0.2]],
  [[0.36, 0.3, 0.75], [0.95, 0.55, 0.65], [0.98, 0.96, 0.92]],
  [[0.05, 0.45, 0.7], [0.99, 0.75, 0.1], [0.97, 0.97, 0.97]],
  [[0.6, 0.12, 0.2], [0.92, 0.85, 0.75], [0.2, 0.15, 0.12]],
];

/** Layers for an artwork of W×H (any unit). `opaqueBg` fills the whole page first. */
export function shapeLayers(kind: ShapeKind, W: number, H: number, r: Rng, opaqueBg: boolean): Layer[] {
  const pal = r.pick(PALETTES), [c1, c2, c3] = pal;
  const L: Layer[] = [];
  const m = Math.min(W, H);
  if (opaqueBg) L.push({ d: rect(0, 0, W, H), fill: kind.startsWith('poster') || kind.startsWith('banner') ? c3 : [1, 1, 1] });
  switch (kind) {
    case 'circle': L.push({ d: circle(W / 2, H / 2, m * 0.42), fill: c1 }, { d: circle(W / 2, H / 2, m * 0.3), fill: c2 }); break;
    case 'blob': L.push({ d: blob(r, W / 2, H / 2, m * 0.38), fill: c1 }, { d: circle(W / 2, H / 2, m * 0.18), fill: c2 }); break;
    case 'star': L.push({ d: star(W / 2, H / 2, m * 0.46, Math.floor(r.range(5, 9))), fill: c1 }, { d: circle(W / 2, H / 2, m * 0.15), fill: c2 }); break;
    case 'badge': L.push({ d: rrect(W * 0.1, H * 0.1, W * 0.8, H * 0.8, m * 0.25), fill: c1 }, { d: circle(W / 2, H * 0.1, m * 0.12), fill: c1 }, { d: rect(W * 0.25, H * 0.42, W * 0.5, H * 0.16), fill: c2 }); break;
    case 'multi': {
      const nx = Math.floor(r.range(2, 4)), ny = Math.floor(r.range(2, 4));
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const cx = ((i + 0.5) / nx) * W, cy = ((j + 0.5) / ny) * H, rad = Math.min(W / nx, H / ny) * 0.36;
        L.push({ d: r.chance(0.5) ? circle(cx, cy, rad) : blob(r, cx, cy, rad), fill: r.pick(pal) });
      }
      break;
    }
    case 'rect': L.push({ d: rect(0, 0, W, H), fill: c3 }, { d: rect(W * 0.08, H * 0.15, W * 0.84, H * 0.3), fill: c1 }, { d: rect(W * 0.08, H * 0.6, W * 0.5, H * 0.08), fill: c2 }); break;
    case 'rect-rounded': L.push({ d: rrect(0, 0, W, H, m * 0.08), fill: c1 }, { d: rect(W * 0.1, H * 0.35, W * 0.8, H * 0.3), fill: c3 }); break;
    case 'rect-stripe': L.push({ d: rect(0, 0, W, H), fill: c2 }); for (let i = 0; i < 4; i++) L.push({ d: rect(0, (i / 4) * H, W, H / 10), fill: c1 }); break;
    case 'poster-full': L.push({ d: rect(0, 0, W, H), fill: c1 }, { d: circle(W * 0.6, H * 0.35, m * 0.3), fill: c2 }, { d: rect(W * 0.08, H * 0.72, W * 0.84, H * 0.08), fill: c3 }); break;
    case 'poster-margin': L.push({ d: rect(W * 0.06, H * 0.05, W * 0.88, H * 0.65), fill: c1 }, { d: rect(W * 0.06, H * 0.76, W * 0.6, H * 0.05), fill: c2 }); break;
    case 'poster-grid': for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) L.push({ d: rect((i / 3) * W, (j / 4) * H, W / 3, H / 4), fill: pal[(i + j) % 3] }); break;
    case 'banner-bands': L.push({ d: rect(0, 0, W, H), fill: c1 }, { d: rect(0, H * 0.35, W, H * 0.3), fill: c2 }, { d: rect(W * 0.05, H * 0.42, W * 0.4, H * 0.16), fill: c3 }); break;
    case 'banner-split': L.push({ d: rect(0, 0, W * 0.35, H), fill: c1 }, { d: rect(W * 0.35, 0, W * 0.65, H), fill: c2 }, { d: circle(W * 0.17, H / 2, H * 0.3), fill: c3 }); break;
  }
  return L;
}

// ---------- files ----------

export type FileSpec = {
  format: 'pdf' | 'png' | 'jpeg';
  shape: ShapeKind;
  wMm: number; // document size (may differ from the requested size)
  hMm: number;
  opaqueBg: boolean;
  bleedMm?: number; // PDF only: art extends this far beyond a TrimBox
  cutSpot?: { name: string; filled?: boolean } | null; // PDF only: a cut separation stroked around the art box
  px?: number; // raster: long-side pixels
  densityMeta?: boolean; // raster: write pHYs / JFIF density
  title?: string; // PDF only: a line of text
  seed: number;
};

export async function makeFile(f: FileSpec): Promise<Uint8Array> {
  const r = rng(f.seed);
  if (f.format === 'pdf') {
    const doc = await PDFDocument.create({ updateMetadata: false }); // no timestamps: same seed, same bytes
    const b = f.bleedMm ?? 0;
    const page = doc.addPage([(f.wMm + 2 * b) * PT, (f.hMm + 2 * b) * PT]);
    // Layers are drawn over the bleed area too when art runs to the edge.
    const full = f.shape.startsWith('poster') || f.shape.startsWith('banner') || f.shape.startsWith('rect');
    const W = (f.wMm + (full ? 2 * b : 0)) * PT, H = (f.hMm + (full ? 2 * b : 0)) * PT;
    const ox = full ? 0 : b * PT, oy = full ? 0 : b * PT;
    for (const l of shapeLayers(f.shape, W, H, r, f.opaqueBg)) {
      page.drawSvgPath(l.d, { x: ox, y: oy + H, color: rgb(...l.fill) });
    }
    if (f.title) {
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      const size = Math.max(6, Math.min(f.wMm, f.hMm) * PT * 0.07);
      page.drawText(f.title, { x: (b + f.wMm * 0.08) * PT, y: (b + f.hMm * 0.12) * PT, size, font, color: rgb(0.08, 0.08, 0.1) });
    }
    if (b > 0) page.setTrimBox(b * PT, b * PT, f.wMm * PT, f.hMm * PT);
    if (f.cutSpot) addSpotRect(doc, page, f.cutSpot.name, b * PT, b * PT, f.wMm * PT, f.hMm * PT, !!f.cutSpot.filled);
    return doc.save();
  }
  const long = f.px ?? 1200;
  const scale = long / Math.max(f.wMm, f.hMm);
  const w = Math.max(8, Math.round(f.wMm * scale)), h = Math.max(8, Math.round(f.hMm * scale));
  const cv = createCanvas(w, h);
  const ctx = cv.getContext('2d');
  const opaque = f.opaqueBg || f.format === 'jpeg';
  if (opaque) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
  for (const l of shapeLayers(f.shape, w, h, r, f.opaqueBg)) {
    ctx.fillStyle = `rgb(${l.fill.map((v) => Math.round(v * 255)).join(',')})`;
    ctx.fill(new Path2D(l.d));
  }
  const ppi = Math.round((long / (Math.max(f.wMm, f.hMm) / 25.4)) * 100) / 100;
  if (f.format === 'jpeg') {
    const jpg = new Uint8Array(cv.toBuffer('image/jpeg', 88));
    return f.densityMeta ? setJfifDensity(jpg, Math.round(ppi)) : jpg;
  }
  const png = new Uint8Array(cv.toBuffer('image/png'));
  return f.densityMeta ? setPngDensity(png, ppi) : png;
}

function addSpotRect(doc: PDFDocument, page: ReturnType<PDFDocument['addPage']>, name: string, x: number, y: number, w: number, h: number, filled: boolean) {
  const ctx = doc.context;
  const fn = ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 });
  const cs = ctx.obj([PDFName.of('Separation'), PDFName.of(name), PDFName.of('DeviceCMYK'), ctx.register(fn)]);
  page.node.Resources()!.set(PDFName.of('ColorSpace'), ctx.obj({ CS9: ctx.register(cs) }));
  const n = (v: number) => PDFNumber.of(Math.round(v * 1000) / 1000);
  const o = (k: string, a: Array<PDFNumber | PDFName> = []) => PDFOperator.of(k as never, a);
  page.pushOperators(o('q'), o(filled ? 'cs' : 'CS', [PDFName.of('CS9')]), o(filled ? 'scn' : 'SCN', [n(1)]), o('w', [n(0.25)]),
    o('re', [n(x), n(y), n(w), n(h)]), o(filled ? 'f' : 'S'), o('Q'));
}

export function setPngDensity(png: Uint8Array, ppi: number): Uint8Array {
  const ppm = Math.round(ppi / 0.0254);
  const data = Buffer.alloc(9);
  data.writeUInt32BE(ppm, 0); data.writeUInt32BE(ppm, 4); data[8] = 1;
  const type = Buffer.from('pHYs');
  const chunk = Buffer.alloc(21);
  chunk.writeUInt32BE(9, 0); type.copy(chunk, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])) >>> 0, 17);
  const ihdrEnd = 8 + 25; // signature + IHDR chunk
  return new Uint8Array(Buffer.concat([Buffer.from(png.subarray(0, ihdrEnd)), chunk, Buffer.from(png.subarray(ihdrEnd))]));
}

export function setJfifDensity(jpg: Uint8Array, dpi: number): Uint8Array {
  const b = Buffer.from(jpg);
  if (b[2] === 0xff && b[3] === 0xe0 && b.toString('latin1', 6, 10) === 'JFIF') {
    b[13] = 1; b.writeUInt16BE(dpi, 14); b.writeUInt16BE(dpi, 16);
    return new Uint8Array(b);
  }
  const app0 = Buffer.from([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0, 0]);
  return new Uint8Array(Buffer.concat([b.subarray(0, 2), app0, b.subarray(2)]));
}

// ---------- jobs ----------

export type NoteFamily = 'A' | 'B' | 'C' | 'AR' | 'neutral' | 'none';
export type Case = { id: string; intent: Intent; file: FileSpec; intake: Intake; shapeFamily: ShapeKind; noteFamily: NoteFamily; tags: string[] };

const NOTES: Record<Exclude<NoteFamily, 'neutral' | 'none'>, Record<Intent, string[]>> = {
  A: {
    sticker: ['Die-cut vinyl stickers please, {q} pcs.', 'Please contour cut these stickers.', 'Stickers cut to shape, glossy.', 'Need die cut stickers of the logo.'],
    label: ['Product labels on a roll, {q} pcs.', 'Roll labels for our jars.', 'Labels for 250 ml bottles, rectangular.', 'Please print the bottle labels, white gloss stock.'],
    poster: ['Poster for the exhibition, matte paper.', 'Print as a poster, no lamination.', 'Two posters for the gallery wall.', 'Framed poster print, A2.'],
    banner: ['Outdoor banner with eyelets every 50 cm.', 'PVC banner for the fence, hemmed edges.', 'Banner for the shop front, weatherproof.', 'Mesh banner, eyelets in the corners.'],
  },
  B: {
    sticker: ['need these as stickers for laptops', 'can u cut around the logo? stickers', 'decals for the car window, cut to shape', 'small stickers for the giveaway bags'],
    label: ['jar labels again, same as last time', 'labels for the honey jars pls', 'barcode labels for the boxes', 'bottle label run, 3 sizes coming'],
    poster: ['big poster for the event', 'can you do this as a poster? matte', 'poster for the cafe wall', 'a1 poster x2 for the launch'],
    banner: ['banner for the football fence', 'need a banner with grommets', 'pvc banner for outside the store', 'banner for our stand, hem all sides'],
  },
  C: { // held out: different phrasing, never seen in training
    sticker: ['Shaped decals for our cafe cups.', 'kiss-cut around the artwork with a small border', 'Waterproof decals, cut along the outline.', 'Promo stickers, individually shaped.'],
    label: ['Packaging labels for the soap bars.', 'Rectangular labels, wound on a 76 mm core.', 'Ingredient labels for the jam jars.', 'Labels for candle tins, plain rectangles.'],
    poster: ['Exhibition print to hang in the hallway.', 'Art print for a frame, satin finish.', 'Wall poster for the conference.', 'Gallery poster, unframed.'],
    banner: ['Street banner, outdoor, with eyelets.', 'Hemmed PVC for the scaffolding.', 'Roll-up style banner print for the stand.', 'Outdoor mesh for the construction fence.'],
  },
  AR: {
    sticker: ['ملصقات مقصوصة على الشكل', 'ستيكر للشعار مع قص كونتور', 'ملصقات صغيرة للأكياس', 'ستيكرات فينيل مقصوصة'],
    label: ['ليبل للعلب على رول', 'ليبلات للزجاجات', 'ملصق منتج مستطيل للعبوة', 'ليبل باركود للكراتين'],
    poster: ['بوستر للمعرض', 'لوحة للحائط ورق مطفي', 'بوستر كبير للفعالية', 'بوستر A2 للمحل'],
    banner: ['بانر خارجي مع حلقات', 'يافطة للمحل مقاومة للماء', 'لافتة PVC للسور', 'بانر للستاند'],
  },
};
const NEUTRAL = ['Please print asap.', 'Same as last order.', 'Invoice to accounts please.', 'Deadline Friday.', 'Colours must match our brand.', 'Call me when ready.', 'urgent!!', 'شكرا'];
const FILENAMES: Record<Intent | 'neutral', string[]> = {
  sticker: ['logo-sticker', 'decal_final', 'stickers_v2', 'sticker sheet', 'die-cut-logo'],
  label: ['jar-label', 'label_250ml', 'labels-final', 'bottle label v3', 'product_label'],
  poster: ['poster_A2', 'expo-poster', 'poster final', 'gallery_print', 'event-poster'],
  banner: ['banner-3x1', 'fence_banner', 'banner_final', 'shopfront-banner', 'pvc-banner'],
  neutral: ['final_FINAL', 'artwork', 'IMG_2041', 'print-ready', 'design v3', 'untitled-1', 'customer file', 'logo'],
};

// Shapes overlap across intents on purpose: square stickers exist, round jar-lid labels exist.
const SHAPES: Record<Intent, ShapeKind[]> = {
  sticker: ['circle', 'blob', 'star', 'badge', 'multi', 'circle', 'blob', 'rect-rounded'],
  label: ['rect', 'rect-rounded', 'rect-stripe', 'rect', 'rect-rounded', 'rect-stripe', 'circle'],
  poster: ['poster-full', 'poster-margin', 'poster-grid'],
  banner: ['banner-bands', 'banner-split'],
};
/** Held-out shape kinds: one per intent, never seen in training. */
export const HELD_SHAPES: ShapeKind[] = ['star', 'rect-stripe', 'poster-grid', 'banner-split'];
const TITLES = ['BEAN & BLOOM', 'NORTH TRAIL', 'OLIVE HOUSE', 'SPRING FAIR', 'MARKET DAY', 'ZEST'];

export function genCase(intent: Intent, seed: number): Case {
  const r = rng(seed * 7919 + 13);
  const tags: string[] = [];
  const shape = r.pick(SHAPES[intent]);
  let file_shape: ShapeKind = shape;
  let w: number, h: number, qty: number, media: Media | null;
  // Sizes and quantities overlap between intents the way real orders do: wall decals are big stickers, drum labels
  // are big labels, A4 posters are small, table banners are short.
  switch (intent) {
    case 'sticker': {
      if (r.chance(0.15)) { const long = r.logRange(300, 1000); w = long; h = long * r.range(0.4, 1); qty = Math.round(r.logRange(1, 20)); tags.push('wall-decal'); }
      else { const long = r.logRange(25, 160); w = long; h = long * r.range(0.6, 1); qty = Math.round(r.logRange(20, 5000)); }
      media = r.chance(0.55) ? 'vinyl' : r.chance(0.2) ? r.pick(['paper', 'label_stock'] as const) : null;
      break;
    }
    case 'label': {
      if (r.chance(0.1)) { w = r.range(150, 300); h = r.range(100, 220); qty = Math.round(r.logRange(30, 500)); tags.push('big-label'); }
      else { w = r.range(25, 150); h = r.range(20, Math.min(110, w * 1.2)); qty = Math.round(r.logRange(100, 10000)); }
      if (shape === 'circle') h = w;
      media = r.chance(0.5) ? 'label_stock' : r.chance(0.3) ? r.pick(['paper', 'vinyl'] as const) : null;
      break;
    }
    case 'poster': {
      const a = r.pick([[210, 297], [297, 420], [297, 420], [420, 594], [594, 841], [841, 1189], [500, 700], [300, 400]]);
      w = a[0]; h = a[1]; qty = Math.round(r.chance(0.15) ? r.logRange(20, 300) : r.logRange(1, 40));
      media = r.chance(0.7) ? r.pick(['paper', 'photo_paper', 'paper'] as const) : r.chance(0.2) ? 'vinyl' : null;
      break;
    }
    case 'banner': {
      if (r.chance(0.2)) { w = r.range(600, 1200); h = r.range(200, 450); tags.push('small-banner'); }
      else { const long = r.range(1000, 5000); w = long; h = long / r.range(1.5, 6); }
      qty = Math.round(r.logRange(1, 10)); media = r.chance(0.6) ? 'pvc_banner' : r.chance(0.2) ? 'vinyl' : null;
      break;
    }
  }
  if (r.chance(0.5)) [w, h] = [h, w];
  w = Math.round(w); h = Math.round(h);

  // Document scale: most files are drawn at size; banners are often supplied at 1:10, some art at another scale.
  let docScale = 1;
  if (intent === 'banner' && r.chance(0.3)) { docScale = 0.1; tags.push('scaled-1:10'); } else if (r.chance(0.12)) { docScale = Math.max(w, h) < 1000 ? r.pick([0.5, 0.25, 2]) : r.pick([0.5, 0.25]); tags.push('scaled'); }
  const format = r.chance(intent === 'poster' || intent === 'banner' ? 0.45 : 0.6) ? 'pdf' : intent === 'sticker' || r.chance(0.6) ? 'png' : 'jpeg';
  const opaqueBg = intent === 'sticker' ? r.chance(0.15) : intent === 'label' ? !r.chance(0.12) : intent === 'poster' ? !r.chance(0.1) : true;
  // Cut-out posters exist (window and wall posters with a free-form outline); give them irregular art.
  if (intent === 'poster' && !opaqueBg && r.chance(0.5)) { file_shape = r.pick(['blob', 'circle', 'multi'] as const); tags.push('cutout-poster'); }
  if (intent === 'sticker' && opaqueBg) tags.push('opaque-sticker');
  if (intent === 'poster' && !opaqueBg) tags.push('transparent-poster');
  const file: FileSpec = { format, shape: file_shape, wMm: w * docScale, hMm: h * docScale, opaqueBg, seed, title: format === 'pdf' && r.chance(0.5) ? r.pick(TITLES) : undefined };
  if (format === 'pdf') {
    if (r.chance(intent === 'poster' ? 0.5 : intent === 'sticker' ? 0.1 : 0.3)) file.bleedMm = 3;
    if (intent === 'sticker' && r.chance(0.22)) { file.cutSpot = { name: r.chance(0.8) ? 'CutContour' : r.pick(['Cut Contour', 'cutcontour', 'CutLine']) }; tags.push('has-cut'); }
    if (intent === 'label' && r.chance(0.15)) { file.cutSpot = { name: 'CutContour' }; tags.push('has-cut'); }
  } else {
    const targetPpi = intent === 'sticker' || intent === 'label' ? r.logRange(90, 600) : r.logRange(25, 300);
    file.px = Math.round(Math.min(2400, Math.max(64, (Math.max(w, h) / 25.4) * targetPpi)));
    file.densityMeta = r.chance(0.6);
    if (!file.densityMeta) tags.push('no-density');
  }

  // Intake: each field independently missing.
  const sizeGiven = docScale !== 1 ? r.chance(0.85) : r.chance(0.55);
  const reqW = sizeGiven ? w : null, reqH = sizeGiven ? h : null;
  if (!sizeGiven) tags.push('no-size');
  const qtyGiven = r.chance(0.7);
  // Notes family.
  let noteFamily: NoteFamily = r.pick(['A', 'A', 'B', 'B', 'C', 'AR', 'neutral', 'none', 'none'] as const);
  let notes = '';
  if (noteFamily === 'neutral') notes = r.pick(NEUTRAL);
  else if (noteFamily !== 'none') {
    let src: Intent = intent;
    if (r.chance(0.12)) { src = r.pick(['sticker', 'label', 'poster', 'banner'] as const); if (src !== intent) tags.push('conflicting-notes'); }
    notes = r.pick(NOTES[noteFamily][src]).replace('{q}', String(qty));
  }
  // Filename: own family, neutral, or misleading.
  let fbase: string;
  const fr = r.next();
  if (fr < 0.45) fbase = r.pick(FILENAMES[intent]);
  else if (fr < 0.85) fbase = r.pick(FILENAMES.neutral);
  else { const other = r.pick((['sticker', 'label', 'poster', 'banner'] as const).filter((i) => i !== intent)); fbase = r.pick(FILENAMES[other]); tags.push('misleading-filename'); }
  const ext = format === 'jpeg' ? 'jpg' : format;
  return {
    id: `${intent}-${seed}`, intent, file, shapeFamily: shape, noteFamily, tags,
    intake: { filename: `${fbase}.${ext}`, qty: qtyGiven ? qty : null, reqW, reqH, media: r.chance(0.85) ? media : null, notes },
  };
}

/** Deterministic split by family: held-out shapes or held-out phrasing → test; then ~20% of the rest → validation. */
export function splitOf(c: Case, seed: number): 'train' | 'val' | 'test' {
  if (HELD_SHAPES.includes(c.shapeFamily) || c.noteFamily === 'C') return 'test';
  return rng(seed * 31 + 7).next() < 0.2 ? 'val' : 'train';
}

/** "The same customer sends a similar job": same intent, shape kind, notes, filename and media; new colours, size ±10%, quantity ×0.5–2. */
export function variantOf(c: Case, k: number): Case {
  const r = rng(c.file.seed * 104729 + k);
  const s = r.range(0.9, 1.1);
  const file: FileSpec = { ...c.file, seed: c.file.seed * 1000 + k, wMm: Math.round(c.file.wMm * s * 10) / 10, hMm: Math.round(c.file.hMm * s * 10) / 10 };
  const intake = { ...c.intake,
    reqW: c.intake.reqW && Math.round(c.intake.reqW * s), reqH: c.intake.reqH && Math.round(c.intake.reqH * s),
    qty: c.intake.qty && Math.max(1, Math.round(c.intake.qty * r.range(0.5, 2))) };
  return { ...c, id: `${c.id}~${k}`, file, intake, tags: [...c.tags, 'variant'] };
}
