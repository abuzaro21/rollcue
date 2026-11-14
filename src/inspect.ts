// Document inspection: everything here is measured from the uploaded bytes. Nothing is guessed; unknowns stay null.
import { createInflate } from 'node:zlib';
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
export const MAX_PAGE_MM = MAX_SIDE_MM + 200; // page box incl. room for bleed and marks
export const MAX_PDF_IMAGE_PIXELS = 100_000_000; // declared image pixels across the whole PDF, checked before decoding
export const MAX_INFLATE_IMAGE = 512 * 1024 * 1024; // decompressed bytes of all image streams together (Codex R6-4)
export const MAX_INFLATE_OTHER = 64 * 1024 * 1024; // decompressed bytes of every other stream together
const MAX_IMAGE_SIDE = 100_000;
export const RENDER_LONG_SIDE_PX = 1600;
export const RENDER_MAX_PPI = 300;

export type Kind = 'pdf' | 'png' | 'jpeg';
export type Box = { x: number; y: number; w: number; h: number }; // mm, PDF user space
/**
 * A cut separation as the page actually paints it (executed content only). `hidden`: used inside a pattern, shading or
 * text, where a cutter would not find it. `loops`/`openLoops`/`bboxMm` describe the stroked subpaths in page space.
 */
export type CutPath = { name: string; exactName: boolean; stroked: boolean; filled: boolean; hidden: boolean; loops: number; openLoops: number; bboxMm: Box | null };

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
  printableAnnots: number; // page-1 annotations / form fields that print; production output cannot carry them
  mask: MaskStats; // alpha analysis of the page-1 render
  trimEdgeTouch: number | null; // share of the trim-box outline covered by art (PDF with a trim box inside the render)
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

/** EXIF IFD0: orientation and resolution. Unreadable EXIF is ignored, never trusted. */
export function exifMeta(b: Uint8Array, start: number, end: number): { orientation: number | null; ppi: number | null } {
  const out = { orientation: null as number | null, ppi: null as number | null };
  try {
    const dv = new DataView(b.buffer, b.byteOffset + start, end - start);
    const le = dv.getUint16(0) === 0x4949;
    const ifd = dv.getUint32(4, le), n = dv.getUint16(ifd, le);
    let xres: number | null = null, yres: number | null = null, unit = 2;
    const rational = (e: number) => { const o = dv.getUint32(e + 8, le), den = dv.getUint32(o + 4, le); return den ? dv.getUint32(o, le) / den : null; };
    for (let i = 0; i < Math.min(n, 256); i++) {
      const e = ifd + 2 + i * 12, tag = dv.getUint16(e, le);
      if (tag === 0x0112) out.orientation = dv.getUint16(e + 8, le);
      if (tag === 0x011a) xres = rational(e);
      if (tag === 0x011b) yres = rational(e);
      if (tag === 0x0128) unit = dv.getUint16(e + 8, le);
    }
    if (xres && xres === yres && (unit === 2 || unit === 3)) out.ppi = Math.round((unit === 3 ? xres * 2.54 : xres) * 100) / 100;
  } catch { /* truncated or malformed EXIF */ }
  return out;
}

export function jpegMeta(b: Uint8Array): RasterMeta {
  let ppi: number | null = null, exifPpi: number | null = null, w = 0, h = 0;
  for (let p = 2; p + 4 <= b.length;) {
    if (b[p] !== 0xff) { p++; continue; }
    const marker = b[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    const len = (b[p + 2] << 8) | b[p + 3];
    if (marker === 0xe0 && b[p + 4] === 0x4a && b[p + 5] === 0x46 && b[p + 6] === 0x49 && b[p + 7] === 0x46) {
      const units = b[p + 11], xd = (b[p + 12] << 8) | b[p + 13], yd = (b[p + 14] << 8) | b[p + 15];
      if (xd > 0 && xd === yd) ppi = units === 1 ? xd : units === 2 ? Math.round(xd * 2.54 * 100) / 100 : null;
    }
    if (marker === 0xe1 && String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]) === 'Exif') {
      const ex = exifMeta(b, p + 10, Math.min(b.length, p + 2 + len));
      // Canvas would honour the orientation while the PDF embeds raw pixels, so preview and print would disagree (Codex R3-11).
      if (ex.orientation !== null && ex.orientation !== 1) throw new Rejected('unsupported', `The JPEG is stored rotated (EXIF orientation ${ex.orientation}), so the preview and the print would disagree. Please export it upright.`);
      exifPpi = ex.ppi;
    }
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)) {
      h = (b[p + 5] << 8) | b[p + 6]; w = (b[p + 7] << 8) | b[p + 8];
      break;
    }
    p += 2 + len;
  }
  if (!w || !h) throw new Rejected('malformed', 'The JPEG has no readable frame header.');
  return { w, h, ppi: ppi ?? exifPpi, alpha: false };
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

// A declared image side must be a sane positive integer; NaN or a negative side would cancel out of the pixel budget (Codex R6-5).
function imageSide(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGE_SIDE) throw new Rejected('malformed', 'An image in the PDF declares an impossible size.');
  return n;
}

function streamText(s: PDFStream): string {
  try {
    const bytes = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : (s as unknown as { getContents(): Uint8Array }).getContents();
    return Buffer.from(bytes).toString('latin1');
  } catch { return ''; }
}

type Use = { stroked: boolean; filled: boolean; hidden: boolean; loops: number; openLoops: number; bbox: number[] | null };
// One tint per colourant: a DeviceN colour paints only the colourants whose own tint is above zero (Codex R7-3).
type Gs = { ctm: number[]; sCs: string[] | null; sTint: number[]; sPat: string | null; fCs: string[] | null; fTint: number[]; fPat: string | null };
const inked = (cs: string[] | null, tint: number[]) => (cs && cs !== PATTERN ? cs.filter((_, i) => (tint[i] ?? 1) > 0) : []);
const PATTERN = ['#pattern'];
const MAX_TOKENS = 5_000_000;
const mul = (m: number[], n: number[]) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];

/**
 * Follows the content that page 1 actually executes (page streams, invoked forms, painted tiling patterns), with each
 * form's own resources and the graphics state, and records how every Separation/DeviceN colourant is painted. A colour
 * space that is only declared, a process-colour reset, a zero tint or an empty path paints no cut (Codex R3-4).
 * Strings and inline images are skipped; text painted in a colourant marks it hidden.
 */
export function scanColourUse(doc: PDFDocument, streams: PDFStream[], resources: PDFDict | undefined, pixelBudget = MAX_PDF_IMAGE_PIXELS): Map<string, Use> {
  const uses = new Map<string, Use>();
  const use = (n: string) => { let u = uses.get(n); if (!u) uses.set(n, u = { stroked: false, filled: false, hidden: false, loops: 0, openLoops: 0, bbox: null }); return u; };
  const sub = (res: PDFDict | undefined, cat: string, key: string) => { const d = res?.lookup(PDFName.of(cat)); return d instanceof PDFDict ? d.lookup(PDFName.of(key)) : undefined; };
  const colourants = (v: unknown): string[] | null => {
    const arr = v instanceof PDFRef ? doc.context.lookup(v) : v;
    if (!(arr instanceof PDFArray) || arr.size() < 2) return arr?.toString() === '/Pattern' ? PATTERN : null;
    const family = arr.lookup(0)?.toString();
    if (family === '/Pattern') return PATTERN;
    if (family === '/Separation') return [decodeName(arr.lookup(1)?.toString())];
    if (family === '/DeviceN') { const l = arr.lookup(1); return l instanceof PDFArray ? l.asArray().map((n) => decodeName(doc.context.lookup(n)?.toString())) : null; }
    return null;
  };
  // Exactly one finite number per colourant; anything else paints no colourant, so a malformed colour can never
  // claim a cut path (Codex R7b-3).
  const tints = (ops: string[], cs: string[] | null, prev: number[]) => {
    if (!cs) return prev;
    const v = ops.map(Number);
    return v.length === cs.length && v.every(Number.isFinite) ? v : cs.map(() => 0);
  };
  const resolveCs = (res: PDFDict | undefined, name: string) => name === 'Pattern' ? PATTERN : /^Device|^Cal|^Lab$/.test(name) ? null : colourants(sub(res, 'ColorSpace', name));
  let tokens = 0, inlinePixels = 0;
  const onStack = new Set<PDFStream>();

  const exec = (content: string, res: PDFDict | undefined, gs0: Gs, hidden: boolean, depth: number) => {
    const re = /\((?:\\.|[^\\)])*\)|<<|>>|<[0-9a-fA-F\s]*>|\/[^\s/<>()[\]{}%]*|%[^\r\n]*|\bBI\b[\s\S]*?\bEI\b|[^\s/<>()[\]{}%]+/g;
    const stack: Gs[] = [];
    let gs: Gs = { ...gs0 };
    let ops: string[] = [];
    let path: Array<{ pts: number[][]; segs: number; closed: boolean }> = [];
    const cur = () => path.at(-1);
    const num = (i: number) => Number(ops[ops.length - i]);
    const pt = (x: number, y: number) => [gs.ctm[0] * x + gs.ctm[2] * y + gs.ctm[4], gs.ctm[1] * x + gs.ctm[3] * y + gs.ctm[5]];
    const lastName = () => { for (let i = ops.length - 1; i >= 0; i--) if (ops[i].startsWith('/')) return decodeName(ops[i]); return ''; };
    const runPattern = (name: string | null) => {
      const p = name ? sub(res, 'Pattern', name) : undefined;
      if (p instanceof PDFStream) runForm(p, res, true); // tiling pattern: its cells are painted
      else if (p instanceof PDFDict) { const sh = p.lookup(PDFName.of('Shading')); if (sh instanceof PDFDict) for (const n of colourants(sh.get(PDFName.of('ColorSpace'))) ?? []) use(n).hidden = true; }
    };
    const runForm = (s: PDFStream, parentRes: PDFDict | undefined, inPattern: boolean) => {
      if (onStack.has(s) || depth > 12) return;
      const m = s.dict.lookup(PDFName.of('Matrix'));
      const mat = m instanceof PDFArray && m.size() === 6 ? m.asArray().map((x) => Number(doc.context.lookup(x)?.toString())) : [1, 0, 0, 1, 0, 0];
      const r = s.dict.lookup(PDFName.of('Resources'));
      onStack.add(s);
      exec(streamText(s), r instanceof PDFDict ? r : parentRes, { ...gs, ctm: mul(mat.every(Number.isFinite) ? mat : [1, 0, 0, 1, 0, 0], gs.ctm) }, hidden || inPattern, depth + 1);
      onStack.delete(s);
    };
    const paint = (stroke: boolean, fill: boolean) => {
      if (fill && gs.fCs === PATTERN) runPattern(gs.fPat);
      if (stroke && gs.sCs === PATTERN) runPattern(gs.sPat);
      const drawn = path.filter((p) => p.segs > 0);
      if (drawn.length && fill) for (const n of inked(gs.fCs, gs.fTint)) { const u = use(n); u.filled = true; if (hidden) u.hidden = true; }
      if (drawn.length && stroke) for (const n of inked(gs.sCs, gs.sTint)) {
        const u = use(n);
        if (hidden) { u.hidden = true; continue; }
        u.stroked = true;
        for (const p of drawn) {
          u.loops++;
          const [a, z] = [p.pts[0], p.pts.at(-1)!];
          if (!p.closed && Math.hypot(a[0] - z[0], a[1] - z[1]) > 0.01) u.openLoops++;
          for (const [x, y] of p.pts) u.bbox = u.bbox ? [Math.min(u.bbox[0], x), Math.min(u.bbox[1], y), Math.max(u.bbox[2], x), Math.max(u.bbox[3], y)] : [x, y, x, y];
        }
      }
      path = [];
    };
    for (const mt of content.matchAll(re)) {
      if (++tokens > MAX_TOKENS) throw new Rejected('too-complex', 'The PDF page is too complex to inspect.');
      const t = mt[0];
      if (t.startsWith('/') || /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) { ops.push(t); continue; }
      if (t.startsWith('BI')) {
        // Inline images are decoded by the renderer too, so their declared size counts against the same budget (Codex R6-5).
        const head = t.slice(0, t.search(/\sID[\s]/) >>> 0);
        inlinePixels += imageSide(/\/(?:W|Width)\s+(\S+)/.exec(head)?.[1]) * imageSide(/\/(?:H|Height)\s+(\S+)/.exec(head)?.[1]);
        if (inlinePixels > pixelBudget) throw new Rejected('too-large', `The PDF's images total more than ${MAX_PDF_IMAGE_PIXELS / 1e6} megapixels.`); // shared with image objects (Codex R7-7)
        continue;
      }
      if (t[0] === '(' || t[0] === '<' || t[0] === '%' || t === '>>') continue;
      switch (t) {
        case 'q': stack.push(gs); gs = { ...gs }; break;
        case 'Q': gs = stack.pop() ?? gs; break;
        case 'cm': if (ops.length >= 6) gs.ctm = mul([num(6), num(5), num(4), num(3), num(2), num(1)], gs.ctm); break;
        case 'CS': gs.sCs = resolveCs(res, lastName()); gs.sTint = []; gs.sPat = null; break;
        case 'cs': gs.fCs = resolveCs(res, lastName()); gs.fTint = []; gs.fPat = null; break;
        case 'SC': case 'SCN': if (gs.sCs === PATTERN) gs.sPat = lastName(); else gs.sTint = tints(ops, gs.sCs, gs.sTint); break;
        case 'sc': case 'scn': if (gs.fCs === PATTERN) gs.fPat = lastName(); else gs.fTint = tints(ops, gs.fCs, gs.fTint); break;
        case 'G': case 'RG': case 'K': gs.sCs = null; break;
        case 'g': case 'rg': case 'k': gs.fCs = null; break;
        case 'm': path.push({ pts: [pt(num(2), num(1))], segs: 0, closed: false }); break;
        case 'l': cur()?.pts.push(pt(num(2), num(1))); if (cur()) cur()!.segs++; break;
        case 'c': case 'v': case 'y': {
          const n = t === 'c' ? 3 : 2;
          for (let i = n; i >= 1; i--) cur()?.pts.push(pt(num(2 * i), num(2 * i - 1)));
          if (cur()) cur()!.segs++;
          break;
        }
        case 're': {
          const [x, y, w, h] = [num(4), num(3), num(2), num(1)];
          path.push({ pts: [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)], segs: 4, closed: true });
          break;
        }
        case 'h': if (cur()) cur()!.closed = true; break;
        case 'S': paint(true, false); break;
        case 's': if (cur()) cur()!.closed = true; paint(true, false); break;
        case 'f': case 'F': case 'f*': paint(false, true); break;
        case 'B': case 'B*': paint(true, true); break;
        case 'b': case 'b*': if (cur()) cur()!.closed = true; paint(true, true); break;
        case 'n': path = []; break;
        case 'Tj': case 'TJ': case "'": case '"':
          for (const n of [...inked(gs.fCs, gs.fTint), ...(gs.sCs && gs.sCs !== PATTERN ? gs.sCs : [])]) use(n).hidden = true;
          break;
        case 'sh': { const sh = sub(res, 'Shading', lastName()); if (sh instanceof PDFDict || sh instanceof PDFStream) { const d = sh instanceof PDFStream ? sh.dict : sh; for (const n of colourants(d.get(PDFName.of('ColorSpace'))) ?? []) use(n).hidden = true; } break; }
        case 'Do': {
          const x = sub(res, 'XObject', lastName());
          if (x instanceof PDFStream && x.dict.lookup(PDFName.of('Subtype'))?.toString() === '/Form') runForm(x, res, false);
          break;
        }
      }
      ops = [];
    }
  };
  // A page's content array is one logical stream: q in one part may be closed by Q in the next.
  exec(streams.map(streamText).join('\n'), resources, { ctm: [1, 0, 0, 1, 0, 0], sCs: null, sTint: [], sPat: null, fCs: null, fTint: [], fPat: null }, false, 0);
  return uses;
}

/** Inflated size of a zlib body, counted chunk by chunk and abandoned past `limit`, so nothing large is held. */
function inflatedSize(body: Uint8Array, limit: number): Promise<number> {
  return new Promise((resolve) => {
    let n = 0;
    const z = createInflate({ finishFlush: 2 /* Z_SYNC_FLUSH: count what a lenient reader would recover */ });
    z.on('data', (c: Buffer) => { n += c.length; if (n > limit) { z.destroy(); resolve(n); } });
    z.on('end', () => resolve(n));
    z.on('error', () => resolve(n));
    z.end(body);
  });
}

const BOMB_FILTERS = /\/(LZWDecode|LZW|RunLengthDecode|RL)\b/;
function checkFilters(names: string[]) {
  // Filters RollCue cannot bound before decoding are refused; an ASCII wrapper would hide Flate from the pre-pass (Codex R6-4).
  if (names.some((n) => BOMB_FILTERS.test(n))) throw new Rejected('unsupported', 'The PDF uses an old compression method (LZW or RunLength). Please re-export it.');
  const flate = names.findIndex((n) => /^\/(FlateDecode|Fl)$/.test(n));
  if (flate > 0 && names.slice(0, flate).some((n) => /^\/(ASCII85Decode|A85|ASCIIHexDecode|AHx)$/.test(n))) throw new Rejected('unsupported', 'The PDF wraps compressed data in a text encoding. Please re-export it.');
}

/**
 * Before any parser decodes anything: every compressed stream body in the raw file is inflated without keeping the output,
 * and the totals are capped. pdf-lib decodes object streams while loading, so this has to come first (Codex R6-4).
 */
export async function pdfInflateBudget(bytes: Uint8Array): Promise<{ image: number; other: number }> {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('latin1');
  const re = /stream\r?\n/g;
  const total = { image: 0, other: 0 };
  for (let m; (m = re.exec(text)); ) {
    if (text.slice(Math.max(0, m.index - 3), m.index) === 'end') continue;
    const start = m.index + m[0].length;
    const dict = text.slice(Math.max(0, m.index - 2048), m.index);
    const o = dict.lastIndexOf(' obj'), own = o >= 0 ? dict.slice(o) : dict; // this stream's dictionary, roughly
    const filter = /\/Filter\s*(\[[^\]]*\]|\/[^\s/<>[\]]+)/.exec(own)?.[1] ?? '';
    checkFilters(filter.match(/\/[^\s/<>[\]]+/g) ?? []);
    // Any valid zlib header, not only the common 0x78 one: a small window still inflates (Codex R7-1).
    if ((bytes[start] & 0x0f) !== 8 || ((bytes[start] << 8) | bytes[start + 1]) % 31 !== 0) continue; // not a zlib body
    const image = /\/Subtype\s*\/Image\b/.test(own);
    const cap = image ? MAX_INFLATE_IMAGE : MAX_INFLATE_OTHER;
    const key = image ? 'image' : 'other';
    // Inflate to the end of the file: zlib's own end marker bounds the body, so neither a literal `endstream` inside the
    // data nor a /Length can hide expansion from this count (Codex R7b-1).
    total[key] += await inflatedSize(bytes.subarray(start), cap - total[key]);
    if (total[key] > cap) throw new Rejected('too-large', 'The PDF decompresses to far more data than a print file needs.');
  }
  return total;
}

export type PdfStructure = Pick<Inspection, 'pages' | 'boxes' | 'bleedMm' | 'rotation' | 'spots' | 'cut' | 'printableAnnots'>;

export async function pdfStructure(bytes: Uint8Array): Promise<PdfStructure> {
  await pdfInflateBudget(bytes);
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
  const unit = node.lookup(PDFName.of('UserUnit'));
  if (unit !== undefined && Number(unit.toString()) !== 1) throw new Rejected('unsupported', `Page 1 uses a custom unit size (UserUnit ${unit.toString()}), so its physical size would be measured wrongly. Please export it with the default unit.`); // Codex R3-1
  // Decoded image size is declared up front; refuse before pdf.js allocates it (Codex R3-13).
  let imagePixels = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    // A filter given by reference is invisible to the raw pre-pass; resolved here, before anything decodes the stream.
    const f = obj.dict.lookup(PDFName.of('Filter'));
    checkFilters(f instanceof PDFArray ? f.asArray().map((x) => doc.context.lookup(x)?.toString() ?? '') : f ? [f.toString()] : []);
    if (obj.dict.lookup(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    imagePixels += imageSide(obj.dict.lookup(PDFName.of('Width'))?.toString()) * imageSide(obj.dict.lookup(PDFName.of('Height'))?.toString());
  }
  if (imagePixels > MAX_PDF_IMAGE_PIXELS) throw new Rejected('too-large', `The PDF's images total ${Math.round(imagePixels / 1e6)} megapixels; the limit is ${MAX_PDF_IMAGE_PIXELS / 1e6}.`);
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
  const { out: spotMap } = collectSpots(doc, node.Resources());
  const contents = node.Contents();
  const streams: PDFStream[] = [];
  if (contents instanceof PDFStream) streams.push(contents);
  else if (contents instanceof PDFArray) for (const r of contents.asArray()) { const s = doc.context.lookup(r); if (s instanceof PDFStream) streams.push(s); }
  const uses = scanColourUse(doc, streams, node.Resources(), MAX_PDF_IMAGE_PIXELS - imagePixels);
  const spots = [...new Set([...[...spotMap.values()].flatMap((s) => [...s]), ...[...uses.keys()].filter((n) => !/^(Cyan|Magenta|Yellow|Black|None|All)$/.test(n))])];

  // Annotations print only if their Print flag is set; Links and Popups never draw (Codex R3-8).
  const annots = node.lookup(PDFName.of('Annots'));
  let printableAnnots = 0;
  if (annots instanceof PDFArray) for (const a of annots.asArray()) {
    const d = doc.context.lookup(a);
    if (!(d instanceof PDFDict) || /^\/(Link|Popup)$/.test(d.lookup(PDFName.of('Subtype'))?.toString() ?? '')) continue;
    if ((Number(d.lookup(PDFName.of('F'))?.toString()) & 4) && d.lookup(PDFName.of('AP'))) printableAnnots++;
  }

  let cut: CutPath | null = null;
  for (const name of spots) {
    if (!CUT_PATTERN.test(name.trim())) continue;
    const u = uses.get(name);
    const b = u?.bbox;
    const candidate: CutPath = {
      name, exactName: name === 'CutContour', stroked: !!u?.stroked, filled: !!u?.filled, hidden: !!u?.hidden, loops: u?.loops ?? 0, openLoops: u?.openLoops ?? 0,
      bboxMm: b ? { x: round2(b[0] / PT_PER_MM), y: round2(b[1] / PT_PER_MM), w: round2((b[2] - b[0]) / PT_PER_MM), h: round2((b[3] - b[1]) / PT_PER_MM) } : null,
    };
    // Prefer the exact name, then a stroked use.
    if (!cut || (candidate.exactName && !cut.exactName) || (candidate.exactName === cut.exactName && candidate.stroked && !cut.stroked)) cut = candidate;
  }
  return { pages, boxes: { media, crop, trim, bleed }, bleedMm, rotation: page.getRotation().angle % 360, spots, cut, printableAnnots };
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
  let images = 0, unresolved = 0, paths = 0, minPpi: number | null = null;
  // The image's unit square maps through the CTM; each pixel axis has its own scale, and the weaker one counts (Codex R3-2).
  const place = (pxW: unknown, pxH: unknown) => {
    images++;
    const w = Math.hypot(ctm[0], ctm[1]), h = Math.hypot(ctm[2], ctm[3]);
    const ppi = Math.min(Number(pxW) / (w / 72), Number(pxH) / (h / 72));
    if (Number.isFinite(ppi) && ppi > 0) minPpi = minPpi === null ? ppi : Math.min(minPpi, ppi); else unresolved++;
  };
  const img = (a: unknown) => a as { width?: number; height?: number } | undefined;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i] as unknown[];
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === O.transform) ctm = mul(args as number[], ctm);
    else if (fn === O.paintFormXObjectBegin) { stack.push(ctm); const m = args[0] as number[] | null; if (m) ctm = mul(m, ctm); }
    else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === O.constructPath) paths++;
    else if (fn === O.paintImageXObject) place(args[1], args[2]);
    else if (fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject) place(img(args[0])?.width, img(args[0])?.height); // stencils are raster too (Codex R3-3)
    else if (fn === O.paintImageXObjectRepeat || fn === O.paintImageMaskXObjectRepeat || fn === O.paintImageMaskXObjectGroup || fn === O.paintInlineImageXObjectGroup) { images++; unresolved++; }
  }
  // One unmeasurable image makes the page's resolution unknown, not the best of the rest.
  return { images, paths, minPpi: minPpi === null || unresolved ? null : Math.round(minPpi) };
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
    const b = s.boxes!;
    const art = b.trim ?? b.crop ?? b.media;
    const sizeSource = b.trim ? 'trimbox' : b.crop ? 'cropbox' : 'mediabox';
    let widthMm = art.w, heightMm = art.h;
    if (s.rotation === 90 || s.rotation === 270) [widthMm, heightMm] = [heightMm, widthMm];
    // Before rendering, and for every box, not only the one that sets the size (Codex R3-14).
    if (Math.max(widthMm, heightMm) > MAX_SIDE_MM) throw new Rejected('too-large', 'The page is larger than 5 m.');
    if (Math.max(...[b.media, b.crop, b.bleed].flatMap((x) => (x ? [x.w, x.h] : [])))> MAX_PAGE_MM) throw new Rejected('too-large', 'A page box is larger than 5 m.');
    const r = await renderPdfPage(bytes);
    if (s.pages > 1) warnings.push(`The PDF has ${s.pages} pages; only page 1 is inspected.`);
    if (r.images > 0 && r.minPpi === null) warnings.push('An image is placed with a transform RollCue cannot resolve; its resolution is unknown.');
    const frame = b.crop ?? b.media;
    return {
      inspection: {
        kind, ...s, widthMm: round2(widthMm), heightMm: round2(heightMm), sizeSource,
        pixels: null, densityPpi: r.minPpi, imageCount: r.images, pathOps: r.paths,
        mask: analyseMask(r.rgba, r.w, r.h), renderPpi: round2(r.ppi), warnings,
        trimEdgeTouch: b.trim && !s.rotation ? outlineCover(r, frame, b.trim) : null,
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
      pixels: { w: meta.w, h: meta.h }, densityPpi: meta.ppi, imageCount: 1, pathOps: 0, spots: [], cut: null, printableAnnots: 0,
      mask: analyseMask(r.rgba, r.w, r.h), renderPpi: round2(r.ppi), warnings, trimEdgeTouch: null,
    },
    render: r,
  };
}

/** Share of the `inner` box outline (mm, PDF space) that is opaque in a render of `frame`. */
export function outlineCover(r: Pick<Rendered, 'rgba' | 'w' | 'h' | 'ppi'>, frame: Box, inner: Box): number {
  const k = r.ppi / 25.4;
  const x0 = Math.round((inner.x - frame.x) * k), x1 = Math.round((inner.x + inner.w - frame.x) * k) - 1;
  const y0 = Math.round((frame.y + frame.h - inner.y - inner.h) * k), y1 = Math.round((frame.y + frame.h - inner.y) * k) - 1;
  let n = 0, o = 0;
  const at = (x: number, y: number) => { if (x < 0 || y < 0 || x >= r.w || y >= r.h) return; n++; if (r.rgba[(y * r.w + x) * 4 + 3] > 127) o++; };
  for (let x = x0; x <= x1; x++) { at(x, y0); at(x, y1); }
  for (let y = y0 + 1; y < y1; y++) { at(x0, y); at(x1, y); }
  return n ? round2(o / n) : 0;
}

export const round2 = (v: number) => Math.round(v * 100) / 100;
