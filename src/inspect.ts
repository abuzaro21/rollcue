// Document inspection: everything here is measured from the uploaded bytes. Nothing is guessed; unknowns stay null.
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, PDFStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createRequire } from 'node:module';
import path from 'node:path';
import { analyseMask, type MaskStats } from './geom.ts';

export const PT_PER_MM = 72 / 25.4;
export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_PIXELS = 50_000_000; // raster decode cap, read from the header before decoding
export const MAX_PAGES = 20;
export const MAX_SIDE_MM = 5000;
export const RENDER_LONG_SIDE_PX = 1600;
export const RENDER_MAX_PPI = 300;

export type Kind = 'pdf' | 'png' | 'jpeg';
export type Box = { x: number; y: number; w: number; h: number }; // mm, PDF user space
export type CutPath = { name: string; exactName: boolean; stroked: boolean; filled: boolean };

export type Inspection = {
  kind: Kind;
  pages: number;
  widthMm: number | null; // physical size of the art (trim box, else crop box; raster: from embedded density)
  heightMm: number | null;
  sizeSource: 'trimbox' | 'cropbox' | 'mediabox' | 'raster-density' | 'unknown';
  boxes: { media: Box; crop: Box | null; trim: Box | null; bleed: Box | null } | null;
  bleedMm: number | null; // smallest margin between trim and bleed/media; null when there is no trim box to measure from
  rotation: number;
  pixels: { w: number; h: number } | null; // raster sources only
  densityPpi: number | null; // raster: embedded density (pHYs / JFIF); PDF: lowest effective image PPI at document size
  imageCount: number;
  pathOps: number;
  spots: string[]; // Separation / DeviceN colourant names found in page 1 resources (including nested forms)
  cut: CutPath | null; // the best candidate cut separation, if any
  mask: MaskStats; // alpha analysis of the page-1 render
  renderPpi: number;
  warnings: string[];
};

export type Rendered = { rgba: Uint8ClampedArray; w: number; h: number; ppi: number; png: Buffer };

export class Rejected extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export function sniff(b: Uint8Array): Kind | null {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'pdf';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  return null;
}

// ---------- raster headers ----------

type RasterMeta = { w: number; h: number; ppi: number | null; alpha: boolean };

export function pngMeta(b: Uint8Array): RasterMeta {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 33) throw new Rejected('malformed', 'The PNG is truncated.');
  const w = dv.getUint32(16), h = dv.getUint32(20), colorType = b[25];
  let ppi: number | null = null, trns = false;
  for (let p = 8; p + 8 <= b.length;) {
    const len = dv.getUint32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (p + 12 + len > b.length) break;
    if (type === 'pHYs' && len === 9 && b[p + 16] === 1) {
      const ppmX = dv.getUint32(p + 8), ppmY = dv.getUint32(p + 12);
      if (ppmX > 0 && ppmX === ppmY) ppi = Math.round(ppmX * 0.0254 * 100) / 100;
    }
    if (type === 'tRNS') trns = true;
    if (type === 'IDAT' || type === 'IEND') break; // metadata chunks come before image data
    p += 12 + len;
  }
  return { w, h, ppi, alpha: colorType === 4 || colorType === 6 || trns };
}

export function jpegMeta(b: Uint8Array): RasterMeta {
  let ppi: number | null = null, w = 0, h = 0;
  for (let p = 2; p + 4 <= b.length;) {
    if (b[p] !== 0xff) { p++; continue; }
    const marker = b[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    const len = (b[p + 2] << 8) | b[p + 3];
    if (marker === 0xe0 && b[p + 4] === 0x4a && b[p + 5] === 0x46 && b[p + 6] === 0x49 && b[p + 7] === 0x46) {
      const units = b[p + 11], xd = (b[p + 12] << 8) | b[p + 13], yd = (b[p + 14] << 8) | b[p + 15];
      if (xd > 0 && xd === yd) ppi = units === 1 ? xd : units === 2 ? Math.round(xd * 2.54 * 100) / 100 : null;
    }
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)) {
      h = (b[p + 5] << 8) | b[p + 6]; w = (b[p + 7] << 8) | b[p + 8];
      break;
    }
    p += 2 + len;
  }
  if (!w || !h) throw new Rejected('malformed', 'The JPEG has no readable frame header.');
  return { w, h, ppi, alpha: false };
}

// ---------- PDF structure ----------

const req = createRequire(import.meta.url);
// pdf.js wants forward-slash directory paths with a trailing slash, also on Windows.
const PDFJS_DIR = path.dirname(req.resolve('pdfjs-dist/package.json')).split(path.sep).join('/');
const PDFJS_OPTS = {
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  standardFontDataUrl: PDFJS_DIR + '/standard_fonts/',
  cMapUrl: PDFJS_DIR + '/cmaps/',
  cMapPacked: true,
  verbosity: 0,
};

/** Returns the loading task; call `.destroy()` on it when done. pdf.js detaches the buffer it is given, so pass a copy. */
export function openPdfJs(bytes: Uint8Array) {
  return pdfjs.getDocument({ ...PDFJS_OPTS, data: new Uint8Array(bytes) });
}

const toBox = (a: number[] | undefined | null): Box | null => {
  if (!a || a.length !== 4) return null;
  const [x1, y1, x2, y2] = a;
  return { x: Math.min(x1, x2) / PT_PER_MM, y: Math.min(y1, y2) / PT_PER_MM, w: Math.abs(x2 - x1) / PT_PER_MM, h: Math.abs(y2 - y1) / PT_PER_MM };
};

function boxOf(node: PDFDict, key: string): number[] | null {
  const v = node.lookup(PDFName.of(key));
  if (!(v instanceof PDFArray)) return null;
  const nums = v.asArray().map((x) => Number((node.context.lookup(x) as { asNumber?: () => number })?.asNumber?.()));
  return nums.length === 4 && nums.every(Number.isFinite) ? nums : null;
}

/** Inherited page attribute lookup (MediaBox, CropBox, Rotate may live on a parent Pages node). */
function inherited(node: PDFDict, key: string): number[] | null {
  for (let n: PDFDict | undefined = node, depth = 0; n && depth < 32; depth++) {
    const b = boxOf(n, key);
    if (b) return b;
    const parent: unknown = n.lookup(PDFName.of('Parent'));
    n = parent instanceof PDFDict ? parent : undefined;
  }
  return null;
}

const CUT_PATTERN = /^(cut[\s_-]*contour|cut[\s_-]*line|thru[\s_-]*cut|through[\s_-]*cut|kiss[\s_-]*cut|die[\s_-]*cut|cut)$/i;

/** Colour-space resource keys → colourant names for page 1, walking nested Form XObjects. */
function collectSpots(doc: PDFDocument, resources: PDFDict | undefined, seen = new Set<PDFDict>(), out = new Map<string, Set<string>>(), forms: PDFStream[] = []) {
  if (!resources || seen.has(resources) || seen.size > 64) return { out, forms };
  seen.add(resources);
  const cs = resources.lookup(PDFName.of('ColorSpace'));
  if (cs instanceof PDFDict) {
    for (const [key, val] of cs.entries()) {
      const arr = doc.context.lookup(val);
      if (!(arr instanceof PDFArray) || arr.size() < 2) continue;
      const family = arr.lookup(0)?.toString();
      const names: string[] = [];
      if (family === '/Separation') names.push(decodeName(arr.lookup(1)?.toString()));
      if (family === '/DeviceN') {
        const list = arr.lookup(1);
        if (list instanceof PDFArray) for (const n of list.asArray()) names.push(decodeName(doc.context.lookup(n)?.toString()));
      }
      if (names.length) out.set(key.toString().slice(1), new Set(names.filter(Boolean)));
    }
  }
  const xo = resources.lookup(PDFName.of('XObject'));
  if (xo instanceof PDFDict) {
    for (const [, ref] of xo.entries()) {
      const s = doc.context.lookup(ref);
      if (s instanceof PDFStream && s.dict.lookup(PDFName.of('Subtype'))?.toString() === '/Form') {
        forms.push(s);
        const r = s.dict.lookup(PDFName.of('Resources'));
        if (r instanceof PDFDict) collectSpots(doc, r, seen, out, forms);
      }
    }
  }
  return { out, forms };
}

function decodeName(n: string | undefined): string {
  if (!n) return '';
  return n.replace(/^\//, '').replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function streamText(s: PDFStream): string {
  try {
    const bytes = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : (s as unknown as { getContents(): Uint8Array }).getContents();
    return Buffer.from(bytes).toString('latin1');
  } catch { return ''; }
}

/**
 * Minimal content-stream scan: tracks the stroke/fill colour space through q/Q and reports which colour-space resource
 * keys were used to stroke or fill a path. Strings, inline images and dictionaries are skipped, not interpreted.
 */
export function scanColourUse(content: string): { stroked: Set<string>; filled: Set<string> } {
  const stroked = new Set<string>(), filled = new Set<string>();
  const stack: Array<[string, string]> = [];
  let strokeCs = '', fillCs = '', last = '';
  const re = /\((?:\\.|[^\\)])*\)|<<|>>|<[0-9a-fA-F\s]*>|\/[^\s/<>()[\]{}%]*|%[^\r\n]*|\bBI\b[\s\S]*?\bEI\b|[^\s/<>()[\]{}%]+/g;
  for (const m of content.matchAll(re)) {
    const t = m[0];
    if (t.startsWith('/')) { last = t.slice(1); continue; }
    switch (t) {
      case 'q': stack.push([strokeCs, fillCs]); break;
      case 'Q': [strokeCs, fillCs] = stack.pop() ?? ['', '']; break;
      case 'CS': strokeCs = last; break;
      case 'cs': fillCs = last; break;
      case 'S': case 's': if (strokeCs) stroked.add(strokeCs); break;
      case 'f': case 'F': case 'f*': if (fillCs) filled.add(fillCs); break;
      case 'B': case 'B*': case 'b': case 'b*':
        if (strokeCs) stroked.add(strokeCs);
        if (fillCs) filled.add(fillCs);
        break;
    }
  }
  return { stroked, filled };
}

export type PdfStructure = Pick<Inspection, 'pages' | 'boxes' | 'bleedMm' | 'rotation' | 'spots' | 'cut'>;

export async function pdfStructure(bytes: Uint8Array): Promise<PdfStructure> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/encrypt/i.test(msg)) throw new Rejected('encrypted', 'The PDF is encrypted; RollCue only inspects unencrypted files.');
    throw new Rejected('malformed', 'The PDF could not be parsed.');
  }
  if (doc.isEncrypted) throw new Rejected('encrypted', 'The PDF is encrypted; RollCue only inspects unencrypted files.');
  const pages = doc.getPageCount();
  if (pages < 1) throw new Rejected('malformed', 'The PDF has no pages.');
  if (pages > MAX_PAGES) throw new Rejected('too-many-pages', `The PDF has ${pages} pages; the limit is ${MAX_PAGES}.`);
  const page = doc.getPage(0);
  const node = page.node;
  const media = toBox(inherited(node, 'MediaBox'));
  if (!media) throw new Rejected('malformed', 'Page 1 has no MediaBox.');
  const crop = toBox(inherited(node, 'CropBox'));
  const trim = toBox(boxOf(node, 'TrimBox'));
  const bleed = toBox(boxOf(node, 'BleedBox'));
  let bleedMm: number | null = null;
  if (trim) {
    const outer = bleed ?? crop ?? media;
    bleedMm = Math.max(0, Math.min(trim.x - outer.x, trim.y - outer.y, outer.x + outer.w - (trim.x + trim.w), outer.y + outer.h - (trim.y + trim.h)));
    bleedMm = Math.round(bleedMm * 100) / 100;
  }
  const { out: spotMap, forms } = collectSpots(doc, node.Resources());
  const spots = [...new Set([...spotMap.values()].flatMap((s) => [...s]))];

  // Which resource keys are stroked / filled anywhere in page 1 or its forms.
  const stroked = new Set<string>(), filled = new Set<string>();
  const contents = node.Contents();
  const streams: PDFStream[] = [];
  if (contents instanceof PDFStream) streams.push(contents);
  else if (contents instanceof PDFArray) for (const r of contents.asArray()) { const s = doc.context.lookup(r); if (s instanceof PDFStream) streams.push(s); }
  for (const s of [...streams, ...forms]) {
    const use = scanColourUse(streamText(s));
    use.stroked.forEach((k) => stroked.add(k));
    use.filled.forEach((k) => filled.add(k));
  }

  let cut: CutPath | null = null;
  for (const [key, names] of spotMap) {
    for (const name of names) {
      if (!CUT_PATTERN.test(name.trim())) continue;
      const candidate: CutPath = { name, exactName: name === 'CutContour', stroked: stroked.has(key), filled: filled.has(key) };
      // Prefer the exact name, then a stroked use.
      if (!cut || (candidate.exactName && !cut.exactName) || (candidate.exactName === cut.exactName && candidate.stroked && !cut.stroked)) cut = candidate;
    }
  }
  return { pages, boxes: { media, crop, trim, bleed }, bleedMm, rotation: page.getRotation().angle % 360, spots, cut };
}

// ---------- rendering ----------

function renderPpiFor(wMm: number, hMm: number): number {
  const longIn = Math.max(wMm, hMm) / 25.4;
  return Math.max(10, Math.min(RENDER_MAX_PPI, RENDER_LONG_SIDE_PX / longIn));
}

/** pdf.js operator-list scan: image count, path-construction count, lowest effective image PPI at document size. */
async function opStats(page: pdfjs.PDFPageProxy): Promise<{ images: number; paths: number; minPpi: number | null }> {
  const ops = await page.getOperatorList();
  const O = pdfjs.OPS;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const mul = (m: number[], n: number[]) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
  let images = 0, paths = 0, minPpi: number | null = null;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i] as unknown[];
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === O.transform) ctm = mul(args as number[], ctm);
    else if (fn === O.paintFormXObjectBegin) { stack.push(ctm); const m = args[0] as number[] | null; if (m) ctm = mul(m, ctm); }
    else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === O.constructPath) paths++;
    else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageXObjectRepeat) {
      images++;
      let pxW: number | undefined;
      if (fn === O.paintImageXObject) pxW = args[1] as number;
      else if (fn === O.paintInlineImageXObject) pxW = (args[0] as { width?: number })?.width;
      const placedPt = Math.hypot(ctm[0], ctm[1]);
      if (pxW && placedPt > 0) {
        const ppi = pxW / (placedPt / 72);
        if (Number.isFinite(ppi)) minPpi = minPpi === null ? ppi : Math.min(minPpi, ppi);
      }
    }
  }
  return { images, paths, minPpi: minPpi === null ? null : Math.round(minPpi) };
}

export async function renderPdfPage(bytes: Uint8Array, opts: { ppi?: number } = {}): Promise<Rendered & { images: number; paths: number; minPpi: number | null }> {
  const task = openPdfJs(bytes);
  let doc: pdfjs.PDFDocumentProxy;
  try { doc = await task.promise; } catch { await task.destroy(); throw new Rejected('malformed', 'The PDF could not be rendered.'); }
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const ppi = opts.ppi ?? renderPpiFor(base.width / PT_PER_MM, base.height / PT_PER_MM);
    const vp = page.getViewport({ scale: ppi / 72 });
    const w = Math.max(1, Math.ceil(vp.width)), h = Math.max(1, Math.ceil(vp.height));
    if (w * h > 8_000_000) throw new Rejected('too-large', 'The page is too large to render.');
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx as never, canvas: canvas as never, viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const stats = await opStats(page);
    return { rgba, w, h, ppi, png: canvas.toBuffer('image/png'), ...stats };
  } finally {
    await task.destroy();
  }
}

export async function renderRaster(bytes: Uint8Array, meta: RasterMeta, physW: number | null): Promise<Rendered> {
  const scale = Math.min(1, RENDER_LONG_SIDE_PX / Math.max(meta.w, meta.h));
  const w = Math.max(1, Math.round(meta.w * scale)), h = Math.max(1, Math.round(meta.h * scale));
  let img;
  try { img = await loadImage(Buffer.from(bytes)); } catch { throw new Rejected('malformed', 'The image could not be decoded.'); }
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const ppi = physW ? w / (physW / 25.4) : 0;
  return { rgba: ctx.getImageData(0, 0, w, h).data, w, h, ppi, png: canvas.toBuffer('image/png') };
}

// ---------- entry point ----------

/** Any parser failure on untrusted bytes becomes a clean refusal, never an internal error. */
export async function inspect(bytes: Uint8Array): Promise<{ inspection: Inspection; render: Rendered }> {
  try { return await inspectUnchecked(bytes); } catch (e) {
    if (e instanceof Rejected) throw e;
    throw new Rejected('malformed', 'The file is damaged or not a valid PDF, PNG or JPEG.');
  }
}

async function inspectUnchecked(bytes: Uint8Array): Promise<{ inspection: Inspection; render: Rendered }> {
  if (bytes.length === 0) throw new Rejected('empty', 'The file is empty.');
  if (bytes.length > MAX_BYTES) throw new Rejected('too-large', `The file is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
  const kind = sniff(bytes);
  if (!kind) throw new Rejected('unsupported', 'Only PDF, PNG and JPEG files are supported.');
  const warnings: string[] = [];

  if (kind === 'pdf') {
    const s = await pdfStructure(bytes);
    const r = await renderPdfPage(bytes);
    const art = s.boxes!.trim ?? s.boxes!.crop ?? s.boxes!.media;
    const sizeSource = s.boxes!.trim ? 'trimbox' : s.boxes!.crop ? 'cropbox' : 'mediabox';
    let widthMm = art.w, heightMm = art.h;
    if (s.rotation === 90 || s.rotation === 270) [widthMm, heightMm] = [heightMm, widthMm];
    if (Math.max(widthMm, heightMm) > MAX_SIDE_MM) throw new Rejected('too-large', 'The page is larger than 5 m.');
    if (s.pages > 1) warnings.push(`The PDF has ${s.pages} pages; only page 1 is inspected.`);
    if (r.images > 0 && r.minPpi === null) warnings.push('An image is placed with a transform RollCue cannot resolve; its resolution is unknown.');
    return {
      inspection: {
        kind, ...s, widthMm: round2(widthMm), heightMm: round2(heightMm), sizeSource,
        pixels: null, densityPpi: r.minPpi, imageCount: r.images, pathOps: r.paths,
        mask: analyseMask(r.rgba, r.w, r.h), renderPpi: round2(r.ppi), warnings,
      },
      render: r,
    };
  }

  const meta = kind === 'png' ? pngMeta(bytes) : jpegMeta(bytes);
  if (meta.w * meta.h > MAX_PIXELS) throw new Rejected('too-large', `The image has ${(meta.w * meta.h / 1e6).toFixed(0)} megapixels; the limit is ${MAX_PIXELS / 1e6}.`);
  const widthMm = meta.ppi ? (meta.w / meta.ppi) * 25.4 : null;
  const heightMm = meta.ppi ? (meta.h / meta.ppi) * 25.4 : null;
  if (!meta.ppi) warnings.push('The image carries no density metadata; its physical size is unknown until a size is given.');
  const r = await renderRaster(bytes, meta, widthMm);
  return {
    inspection: {
      kind, pages: 1, widthMm: widthMm && round2(widthMm), heightMm: heightMm && round2(heightMm),
      sizeSource: meta.ppi ? 'raster-density' : 'unknown', boxes: null, bleedMm: null, rotation: 0,
      pixels: { w: meta.w, h: meta.h }, densityPpi: meta.ppi, imageCount: 1, pathOps: 0, spots: [], cut: null,
      mask: analyseMask(r.rgba, r.w, r.h), renderPpi: round2(r.ppi), warnings,
    },
    render: r,
  };
}

export const round2 = (v: number) => Math.round(v * 100) / 100;
