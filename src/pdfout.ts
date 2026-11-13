// Production artifacts. The source is embedded unchanged (PDF pages as Form XObjects, so vectors survive). A cut path is
// a stroke in a Separation colour space named exactly "CutContour". Every artifact is re-parsed and re-rendered before
// anyone may approve it.
import { PDFDocument, PDFName, PDFNumber, PDFOperator, PDFDict, StandardFonts, rgb, cmyk } from 'pdf-lib';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PT_PER_MM, pdfStructure, renderPdfPage, type Inspection, type Kind } from './inspect.ts';
import type { Pt } from './geom.ts';

const pt = (mm: number) => PDFNumber.of(Math.round(mm * PT_PER_MM * 1000) / 1000);
const op = (name: string, args: Array<PDFNumber | PDFName> = []) => PDFOperator.of(name as never, args);

export type ArtSpec = {
  kind: Kind;
  bytes: Uint8Array;
  inspection: Inspection;
  targetW: number; // mm, the finished (trim) size
  targetH: number;
  fit: 'scale' | 'fit' | 'fill'; // scale: same proportions; fit: inside, letterboxed; fill: covers, cropped at the trim
};

export type BuildSpec = ArtSpec & {
  marginMm: number;
  cut: Pt[][] | null; // mm in the target art frame (origin = bottom-left of the trim area)
  cropMarks: boolean;
  title: string;
  subject: string;
  stamp: Date; // fixed timestamps keep the artifact deterministic for the same inputs
};

/** Natural art (trim) size of the source in its own units: mm for PDFs, pixels for rasters. */
function artSize(a: ArtSpec) {
  if (a.kind === 'pdf') { const b = a.inspection.boxes!; const t = b.trim ?? b.crop ?? b.media; return { w: t.w, h: t.h }; }
  return { w: a.inspection.pixels!.w, h: a.inspection.pixels!.h };
}

/**
 * Where the rendered frame (PDF crop box, or the whole raster) lands relative to the trim area, in mm at print size.
 * Contours traced on the render use the same transform, so cut and art cannot drift apart.
 */
export function renderFrame(a: ArtSpec): { x: number; y: number; w: number; h: number; scale: number } {
  const art = artSize(a);
  const s = a.fit === 'scale' ? a.targetW / art.w : a.fit === 'fit' ? Math.min(a.targetW / art.w, a.targetH / art.h) : Math.max(a.targetW / art.w, a.targetH / art.h);
  const dx = (a.targetW - art.w * s) / 2, dy = (a.targetH - art.h * s) / 2;
  if (a.kind !== 'pdf') return { x: dx, y: dy, w: art.w * s, h: art.h * s, scale: s };
  const b = a.inspection.boxes!;
  const frame = b.crop ?? b.media, trim = b.trim ?? frame;
  return { x: dx + (frame.x - trim.x) * s, y: dy + (frame.y - trim.y) * s, w: frame.w * s, h: frame.h * s, scale: s };
}

export async function buildProduction(spec: BuildSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const W = spec.targetW + 2 * spec.marginMm, H = spec.targetH + 2 * spec.marginMm;
  const page = doc.addPage([W * PT_PER_MM, H * PT_PER_MM]);
  const m = spec.marginMm;

  const f = renderFrame(spec);
  const clip = spec.fit === 'fill';
  if (clip) page.pushOperators(op('q'), op('re', [pt(m), pt(m), pt(spec.targetW), pt(spec.targetH)]), op('W'), op('n'));
  if (spec.kind === 'pdf') {
    const src = await PDFDocument.load(spec.bytes, { updateMetadata: false });
    const frame = spec.inspection.boxes!.crop ?? spec.inspection.boxes!.media;
    const emb = await doc.embedPage(src.getPage(0), {
      left: frame.x * PT_PER_MM, bottom: frame.y * PT_PER_MM, right: (frame.x + frame.w) * PT_PER_MM, top: (frame.y + frame.h) * PT_PER_MM,
    });
    page.drawPage(emb, { x: (m + f.x) * PT_PER_MM, y: (m + f.y) * PT_PER_MM, xScale: f.scale, yScale: f.scale });
  } else {
    const img = spec.kind === 'png' ? await doc.embedPng(spec.bytes) : await doc.embedJpg(spec.bytes);
    page.drawImage(img, { x: (m + f.x) * PT_PER_MM, y: (m + f.y) * PT_PER_MM, width: f.w * PT_PER_MM, height: f.h * PT_PER_MM });
  }
  if (clip) page.pushOperators(op('Q'));

  if (spec.cut?.length) {
    const ctx = doc.context;
    const tint = ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 });
    const cs = ctx.obj([PDFName.of('Separation'), PDFName.of('CutContour'), PDFName.of('DeviceCMYK'), ctx.register(tint)]);
    const gs = ctx.obj({ Type: 'ExtGState', OP: true, op: true, OPM: 1 });
    const res = page.node.Resources()!;
    res.set(PDFName.of('ColorSpace'), ctx.obj({ RCCut: ctx.register(cs) }));
    let eg = res.lookup(PDFName.of('ExtGState'));
    if (!(eg instanceof PDFDict)) { eg = ctx.obj({}); res.set(PDFName.of('ExtGState'), eg as PDFDict); }
    (eg as PDFDict).set(PDFName.of('RCCutGS'), ctx.register(gs));
    const ops = [op('q'), op('gs', [PDFName.of('RCCutGS')]), op('CS', [PDFName.of('RCCut')]), op('SCN', [PDFNumber.of(1)]), op('w', [PDFNumber.of(0.25)]), op('J', [PDFNumber.of(1)]), op('j', [PDFNumber.of(1)])];
    for (const loop of spec.cut) {
      loop.forEach(([x, y], i) => ops.push(op(i ? 'l' : 'm', [pt(m + x), pt(m + y)])));
      ops.push(op('h'));
    }
    ops.push(op('S'), op('Q'));
    page.pushOperators(...ops);
  }

  if (spec.cropMarks && m >= 6) {
    const len = Math.min(m - 2, 8), gap = 2, k = cmyk(0, 0, 0, 1);
    const line = (x1: number, y1: number, x2: number, y2: number) =>
      page.drawLine({ start: { x: x1 * PT_PER_MM, y: y1 * PT_PER_MM }, end: { x: x2 * PT_PER_MM, y: y2 * PT_PER_MM }, thickness: 0.25, color: k });
    for (const x of [m, m + spec.targetW]) { line(x, m - gap - len, x, m - gap); line(x, H - m + gap, x, H - m + gap + len); }
    for (const y of [m, m + spec.targetH]) { line(m - gap - len, y, m - gap, y); line(W - m + gap, y, W - m + gap + len, y); }
  }

  page.setTrimBox(m * PT_PER_MM, m * PT_PER_MM, spec.targetW * PT_PER_MM, spec.targetH * PT_PER_MM);
  doc.setTitle(spec.title); doc.setSubject(spec.subject); doc.setProducer('RollCue'); doc.setCreator('RollCue');
  doc.setCreationDate(spec.stamp); doc.setModificationDate(spec.stamp);
  return doc.save({ useObjectStreams: false });
}

/** WinAnsi-safe text for the standard fonts. */
const ansi = (s: string) => s.replace(/[^\x20-\x7e]/g, '?');

export async function buildReturnNotice(n: { filename: string; title: string; lines: string[]; ask: string; stamp: Date }): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([210 * PT_PER_MM, 297 * PT_PER_MM]);
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 297 - 25;
  const text = (s: string, size: number, f = font) => {
    for (const chunk of wrap(ansi(s), size > 12 ? 60 : 95)) { page.drawText(chunk, { x: 20 * PT_PER_MM, y: y * PT_PER_MM, size, font: f, color: rgb(0.1, 0.1, 0.12) }); y -= size * 0.5; }
    y -= 2;
  };
  text('File returned for correction', 18, bold);
  text(`File: ${n.filename}`, 10);
  y -= 4;
  text(n.title, 13, bold);
  for (const l of n.lines) text(`- ${l}`, 10);
  y -= 4;
  text('What we need from you', 13, bold);
  text(n.ask, 10);
  y -= 6;
  text('Prepared by RollCue and reviewed by the operator before sending. Nothing was printed.', 8);
  doc.setTitle(`Return notice: ${ansi(n.filename)}`); doc.setProducer('RollCue'); doc.setCreator('RollCue');
  doc.setCreationDate(n.stamp); doc.setModificationDate(n.stamp);
  return doc.save({ useObjectStreams: false });
}

function wrap(s: string, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > max && line) { out.push(line); line = word; } else line = (line + ' ' + word).trim();
  }
  if (line) out.push(line);
  return out;
}

export type Check = { id: string; label: string; pass: boolean; detail: string };

export type Expect = { pageW: number; pageH: number; trim: { x: number; y: number; w: number; h: number }; cutLoops: number; notice?: boolean };

/** Independent re-read of the artifact bytes. The UI and the release gate use these results; nothing is assumed. */
export async function verifyArtifact(bytes: Uint8Array, e: Expect): Promise<{ checks: Check[]; preview: Buffer | null }> {
  const checks: Check[] = [];
  const add = (id: string, label: string, pass: boolean, detail: string) => checks.push({ id, label, pass, detail });
  let structure;
  try { structure = await pdfStructure(bytes); } catch (err) {
    add('parse', 'PDF re-parses', false, String((err as Error).message));
    return { checks, preview: null };
  }
  add('parse', 'PDF re-parses', true, `${structure.pages} page`);
  const b = structure.boxes!;
  const near = (a: number, x: number) => Math.abs(a - x) <= 0.02;
  add('page', 'Page size', near(b.media.w, e.pageW) && near(b.media.h, e.pageH), `${b.media.w.toFixed(2)} × ${b.media.h.toFixed(2)} mm (expected ${e.pageW.toFixed(2)} × ${e.pageH.toFixed(2)})`);
  if (!e.notice) {
    const t = b.trim;
    add('trim', 'Trim box', !!t && near(t.x, e.trim.x) && near(t.y, e.trim.y) && near(t.w, e.trim.w) && near(t.h, e.trim.h),
      t ? `${t.w.toFixed(2)} × ${t.h.toFixed(2)} mm at ${t.x.toFixed(2)}, ${t.y.toFixed(2)}` : 'missing');
  }
  if (e.cutLoops > 0) {
    const c = structure.cut;
    add('cut-name', 'Spot colour named exactly "CutContour"', !!c && c.exactName, c ? `found "${c.name}"` : 'no cut separation');
    add('cut-stroke', 'CutContour is stroked, not filled', !!c && c.stroked && !c.filled, c ? `stroked=${c.stroked} filled=${c.filled}` : 'n/a');
  } else {
    add('no-cut', 'No cut separation (none requested)', !structure.cut, structure.cut ? `unexpected "${structure.cut.name}"` : 'none');
  }
  let preview: Buffer | null = null;
  try {
    const r = await renderPdfPage(bytes, { ppi: Math.min(150, 1400 / (Math.max(e.pageW, e.pageH) / 25.4)) });
    preview = r.png;
    add('render', 'Renders in pdf.js', true, `${r.w} × ${r.h} px`);
  } catch (err) { add('render', 'Renders in pdf.js', false, String((err as Error).message)); }
  return { checks, preview };
}

/**
 * Optional third opinion: Ghostscript's tiffsep device writes one plate per colourant. A real spot colour produces a
 * "(CutContour)" plate. Used by the test suite and CI when `gs` is installed; never on uploaded originals.
 */
export async function ghostscriptPlates(bytes: Uint8Array, gsBin = process.env.RC_GS ?? 'gs'): Promise<string[] | null> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rc-gs-'));
  try {
    await writeFile(path.join(dir, 'in.pdf'), bytes);
    const ok = await new Promise<boolean>((resolve) => {
      execFile(gsBin, ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=tiffsep', '-r36', `-sOutputFile=${path.join(dir, 'p.tif')}`, path.join(dir, 'in.pdf')],
        { timeout: 30_000 }, (err) => resolve(!err));
    });
    if (!ok) return null;
    const names = await readdir(dir);
    const plates: string[] = [];
    for (const n of names) { const mt = /^p\((.+)\)\.tif$/.exec(n); if (mt && (await stat(path.join(dir, n))).size > 0) plates.push(mt[1]); }
    return plates.sort();
  } finally { await rm(dir, { recursive: true, force: true }); }
}
