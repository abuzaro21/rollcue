// Codex review R3 (preflight correctness): one regression per reproducible finding. Each fixture is built in memory
// from the description in docs/reviews/R3-preflight.md, and each test failed on the reviewed commit f6d43c2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, type PDFRef } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { makeFile, setPngDensity } from '../dataset/gen.ts';
import { inspect, pdfStructure, renderPdfPage, Rejected, PT_PER_MM, type Inspection } from '../src/inspect.ts';
import { featurize, type Intake } from '../src/features.ts';
import { predict, type ModelFile } from '../src/model.ts';
import { plan, type Params } from '../src/policy.ts';
import { verifyArtifact } from '../src/pdfout.ts';
import { rectLoop } from '../src/geom.ts';
import { prepare } from '../src/worker.ts';

const PT = PT_PER_MM;
const model = JSON.parse(readFileSync('src/model.json', 'utf8')) as ModelFile;
const intake = (o: Partial<Intake> & { filename: string }): Intake => ({ qty: null, reqW: null, reqH: null, media: null, notes: '', ...o });
const planFor = (ins: Inspection, i: Intake, params: Params = {}) => plan(ins, i, predict(model, featurize(ins, i)), params);
const check = (p: { checks: Array<{ id: string; status: string; detail: string }> }, id: string) => p.checks.find((c) => c.id === id);
const sticker = (o: Partial<Intake> = {}) => intake({ filename: 's.png', qty: 100, media: 'vinyl', notes: 'die cut stickers', ...o });

/** A one-page PDF whose page content is exactly `content`. */
async function rawPdf(content: string, o: { w?: number; h?: number; res?: (d: PDFDocument) => Record<string, unknown>; edit?: (d: PDFDocument) => void } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([o.w ?? 200, o.h ?? 200]);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
  if (o.res) page.node.set(PDFName.of('Resources'), doc.context.obj(o.res(doc) as never));
  o.edit?.(doc);
  return doc.save({ useObjectStreams: false });
}
const cutCs = (d: PDFDocument, name = 'CutContour'): PDFRef => d.context.register(d.context.obj([
  PDFName.of('Separation'), PDFName.of(name), PDFName.of('DeviceCMYK'),
  d.context.register(d.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 })),
]));
const cutRes = (d: PDFDocument) => ({ ColorSpace: { CS1: cutCs(d) } });

function circlePng(size: number) {
  const cv = createCanvas(size, size);
  const g = cv.getContext('2d');
  g.fillStyle = '#c0392b';
  g.beginPath(); g.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2); g.fill();
  return new Uint8Array(cv.toBuffer('image/png'));
}

test('R3-1: a custom UserUnit is refused instead of measured wrongly', async () => {
  const pdf = await rawPdf('0 0 1 rg 0 0 72 72 re f', { w: 72, h: 72, edit: (d) => d.getPage(0).node.set(PDFName.of('UserUnit'), d.context.obj(10)) });
  await assert.rejects(inspect(pdf), (e: Rejected) => e.code === 'unsupported' && /UserUnit/.test(e.message));
});

test('R3-2: effective resolution uses the weaker axis and the real fit', async () => {
  const cv = createCanvas(600, 60);
  cv.getContext('2d').fillRect(0, 0, 600, 60);
  const doc = await PDFDocument.create();
  doc.addPage([144, 144]).drawImage(await doc.embedPng(cv.toBuffer('image/png')), { x: 36, y: 36, width: 72, height: 72 });
  assert.equal((await inspect(await doc.save())).inspection.densityPpi, 60, '600 × 60 px stretched over one inch square is 60 ppi');

  const { inspection } = await inspect(circlePng(600));
  const p = planFor(inspection, sticker({ reqW: 25.4, reqH: 254 }), { intent: 'sticker', fit: 'fill' });
  assert.match(check(p, 'resolution')!.detail, /^60 ppi/, '600 px filled into 25.4 × 254 mm is 60 ppi');
  assert.equal(check(p, 'resolution')!.status, 'fail');
});

test('R3-3: a raster stencil (/ImageMask) is measured, not passed as vector art', async () => {
  const pdf = await rawPdf('q 72 0 0 72 36 36 cm /M1 Do Q', {
    w: 144, h: 144,
    res: (d) => ({ XObject: { M1: d.context.register(d.context.stream(new Uint8Array(32), { Type: 'XObject', Subtype: 'Image', Width: 16, Height: 16, ImageMask: true, BitsPerComponent: 1 })) } }),
  });
  const { inspection } = await inspect(pdf);
  assert.equal(inspection.imageCount, 1);
  assert.equal(inspection.densityPpi, 16);
  const p = planFor(inspection, intake({ filename: 'l.pdf', qty: 1000, media: 'label_stock', notes: 'labels on a roll' }), { intent: 'label' });
  assert.equal(check(p, 'resolution')!.status, 'fail');
});

test('R3-4: a cut is what the page actually strokes, not a declared colour space', async () => {
  const cutOf = async (content: string, res: (d: PDFDocument) => Record<string, unknown> = cutRes) => (await pdfStructure(await rawPdf(content, { res }))).cut;
  assert.equal((await cutOf('/CS1 CS 1 SCN 0 0 0 RG 10 10 50 50 re S'))?.stroked, false, 'process colour reset before the stroke');
  assert.equal((await cutOf('/CS1 CS 1 SCN S'))?.stroked, false, 'stroke of an empty path');
  assert.equal((await cutOf('/CS1 CS 0 SCN 10 10 50 50 re S'))?.stroked, false, 'zero tint');

  const form = (d: PDFDocument) => ({ XObject: { F1: d.context.register(d.context.stream('/CS1 CS 1 SCN 10 10 50 50 re S', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200], Resources: d.context.obj(cutRes(d) as never) })) } });
  assert.equal((await cutOf('0 0 1 rg 0 0 10 10 re f', form))?.stroked ?? false, false, 'a form that is never invoked');
  const used = await cutOf('q 1 0 0 1 20 0 cm /F1 Do Q', form);
  assert.equal(used?.stroked, true, 'an invoked form, with its own resources');
  assert.equal(used?.loops, 1);
  assert.equal(used?.openLoops, 0);
  assert.ok(Math.abs(used!.bboxMm!.x - 30 / PT) < 0.05, 'bounds in page space, through cm');

  const pattern = (d: PDFDocument) => ({
    Pattern: { P1: d.context.register(d.context.stream('/CS1 CS 1 SCN 1 1 8 8 re S', { Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: d.context.obj(cutRes(d) as never) })) },
  });
  const pdf = await rawPdf('/Pattern cs /P1 scn 0 0 100 100 re f', { res: pattern });
  assert.equal((await pdfStructure(pdf)).cut?.hidden, true, 'a CutContour inside a painted tiling pattern');
  const { inspection } = await inspect(pdf);
  const p = planFor(inspection, intake({ filename: 's.pdf', qty: 100, media: 'vinyl', notes: 'die cut stickers' }), { intent: 'sticker' });
  assert.equal(check(p, 'cut')!.status, 'fail');
  assert.match(check(p, 'cut')!.detail, /pattern/);
});

test('R3-5: fill-and-crop traces only the printed art, and the cut stays on the page', async () => {
  const png = circlePng(600);
  const { inspection, render } = await inspect(png);
  const p = planFor(inspection, sticker({ reqW: 25.4, reqH: 254 }), { intent: 'sticker', fit: 'fill', acceptLowRes: true });
  assert.equal(p.decision.kind, 'release');
  if (p.decision.kind !== 'release') return;
  const b = p.decision.build;
  assert.equal(b.cut, 'contour');
  const res = await prepare({ type: 'prepare-release', kind: 'png', bytes: png, inspection, preview: new Uint8Array(render.png), build: b, title: 't', subject: 's', stamp: new Date(0).toISOString() });
  const pageW = b.targetW + 2 * b.marginMm, pageH = b.targetH + 2 * b.marginMm;
  for (const l of res.overlay!.loops) for (const [x, y] of l) assert.ok(x >= 0 && x <= pageW && y >= 0 && y <= pageH, `cut point ${x}, ${y} is off the ${pageW} × ${pageH} mm page`);
  assert.ok(res.checks.every((c) => c.pass), JSON.stringify(res.checks.filter((c) => !c.pass)));
});

test('R3-6: a rounded rectangular cut never leaves the trim', () => {
  for (const [w, h] of [[5, 5], [40, 6]]) {
    for (const [x, y] of rectLoop(0, 0, w, h, 10)) assert.ok(x >= -1e-9 && x <= w + 1e-9 && y >= -1e-9 && y <= h + 1e-9, `${x}, ${y} outside ${w} × ${h}`);
  }
});

test('R3-7: bleed is measured at the finished size, kept through a fill, and declared honestly', async () => {
  const src = await makeFile({ seed: 11, format: 'pdf', shape: 'poster-full', wMm: 420, hMm: 594, opaqueBg: true, bleedMm: 3 });
  const { inspection, render } = await inspect(src);
  const poster = (o: Partial<Intake>) => intake({ filename: 'poster.pdf', qty: 2, media: 'paper', notes: 'posters', ...o });
  const half = planFor(inspection, poster({ reqW: 210, reqH: 297 }), { intent: 'poster' });
  assert.equal(check(half, 'bleed')!.status, 'warn', '3 mm of bleed at half size is 1.5 mm');

  const p = planFor(inspection, poster({ reqW: 594, reqH: 594 }), { intent: 'poster', fit: 'fill' });
  assert.equal(p.decision.kind, 'release');
  if (p.decision.kind !== 'release') return;
  const b = p.decision.build;
  const res = await prepare({ type: 'prepare-release', kind: 'pdf', bytes: src, inspection, preview: new Uint8Array(render.png), build: b, title: 't', subject: 's', stamp: new Date(0).toISOString() });
  assert.ok(res.checks.every((c) => c.pass), JSON.stringify(res.checks.filter((c) => !c.pass)));
  assert.equal((await pdfStructure(res.artifact)).bleedMm, 3, 'the output declares the bleed it has, not its blank margin');
  const r = await renderPdfPage(res.artifact, { ppi: 50 });
  const k = r.ppi / 25.4, x = Math.round((b.marginMm - 1.5) * k);
  let opaque = 0;
  for (let y = Math.round(r.h * 0.3); y < r.h * 0.7; y++) opaque += r.rgba[(y * r.w + x) * 4 + 3] > 127 ? 1 : 0;
  assert.ok(opaque > r.h * 0.35, 'art survives 1.5 mm outside the trim');
});

test('R3-8: printable annotations are returned, not silently dropped', async () => {
  const doc = await PDFDocument.load(await makeFile({ seed: 3, format: 'pdf', shape: 'poster-full', wMm: 297, hMm: 420, opaqueBg: true }));
  const ap = doc.context.register(doc.context.stream('1 0 0 rg 0 0 50 50 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 50, 50] }));
  const annot = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [100, 100, 150, 150], F: 4, AP: { N: ap } }));
  doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([annot]));
  const { inspection } = await inspect(await doc.save());
  const p = planFor(inspection, intake({ filename: 'poster.pdf', qty: 2, notes: 'poster' }), { intent: 'poster' });
  assert.equal(check(p, 'annotations')?.status, 'fail');
  assert.equal(p.decision.kind, 'return');
});

test('R3-9: roll fit uses the printed footprint, including crop marks', async () => {
  const { inspection } = await inspect(await makeFile({ seed: 4, format: 'pdf', shape: 'poster-full', wMm: 1570, hMm: 1570, opaqueBg: true }));
  const p = planFor(inspection, intake({ filename: 'poster.pdf', qty: 1, media: 'paper', notes: 'poster' }), { intent: 'poster' });
  assert.equal(check(p, 'roll')!.status, 'fail', 'a 1570 mm poster with marks does not fit 1570 mm of usable width');
});

test('R3-10: verification checks what the page paints, not what the builder meant', async () => {
  const W = 70, H = 70, trim = { x: 5, y: 5, w: 60, h: 60 };
  const page = (content: string) => rawPdf(content, { w: W * PT, h: H * PT, res: cutRes, edit: (d) => d.getPage(0).setTrimBox(5 * PT, 5 * PT, 60 * PT, 60 * PT) });
  const failed = async (content: string, cutLoops: number, id: string, art = false) => {
    const v = await verifyArtifact(await page(content), { pageW: W, pageH: H, trim, cutLoops, ...(art ? { art: { region: trim, coverage: 0.5 } } : {}) });
    return v.checks.find((c) => c.id === id)?.pass === false;
  };
  assert.ok(await failed('0 0 1 rg', 0, 'artwork', true), 'a blank page');
  assert.ok(await failed('/CS1 CS 1 SCN S', 9, 'cut-loops'), 'nine loops promised, none stroked');
  assert.ok(await failed('/CS1 CS 1 SCN 20 20 m 100 20 l 100 100 l S', 1, 'cut-closed'), 'an open cut');
  assert.ok(await failed('/CS1 CS 1 SCN -50 -50 400 400 re S', 1, 'cut-bounds'), 'a cut off the page');
  const good = await verifyArtifact(await page('/CS1 CS 1 SCN 20 20 100 100 re S'), { pageW: W, pageH: H, trim, cutLoops: 1 });
  assert.ok(good.checks.every((c) => c.pass), JSON.stringify(good.checks.filter((c) => !c.pass)));
});

/** Inserts an EXIF APP1 segment (big-endian TIFF, IFD0 only) after the JPEG's SOI marker. */
function withExif(jpeg: Uint8Array, o: { orientation?: number; dpi?: number }) {
  const n = (o.orientation ? 1 : 0) + (o.dpi ? 3 : 0), data = 8 + 2 + n * 12 + 4;
  const t = Buffer.alloc(data + (o.dpi ? 16 : 0));
  t.write('MM', 0, 'latin1'); t.writeUInt16BE(42, 2); t.writeUInt32BE(8, 4); t.writeUInt16BE(n, 8);
  let e = 10;
  const entry = (tag: number, type: number, value: number, short: boolean) => { t.writeUInt16BE(tag, e); t.writeUInt16BE(type, e + 2); t.writeUInt32BE(1, e + 4); if (short) t.writeUInt16BE(value, e + 8); else t.writeUInt32BE(value, e + 8); e += 12; };
  if (o.orientation) entry(0x0112, 3, o.orientation, true);
  if (o.dpi) {
    entry(0x011a, 5, data, false); entry(0x011b, 5, data + 8, false); entry(0x0128, 3, 2, true);
    t.writeUInt32BE(o.dpi, data); t.writeUInt32BE(1, data + 4); t.writeUInt32BE(o.dpi, data + 8); t.writeUInt32BE(1, data + 12);
  }
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
  const len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2);
  return new Uint8Array(Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, body, jpeg.subarray(2)]));
}

test('R3-11: EXIF orientation is refused and EXIF density is read', async () => {
  const cv = createCanvas(300, 600);
  const g = cv.getContext('2d');
  g.fillStyle = '#123'; g.fillRect(0, 0, 300, 300); g.fillStyle = '#ddd'; g.fillRect(0, 300, 300, 300);
  const jpg = new Uint8Array(cv.toBuffer('image/jpeg'));
  await assert.rejects(inspect(withExif(jpg, { orientation: 6 })), (e: Rejected) => e.code === 'unsupported' && /orientation/i.test(e.message));
  const { inspection } = await inspect(withExif(jpg, { dpi: 300 }));
  assert.equal(inspection.widthMm, 25.4);
  assert.equal(inspection.heightMm, 50.8);
});

test('R3-12: a multi-page PDF is returned until a page is chosen', async () => {
  const doc = await PDFDocument.load(await makeFile({ seed: 5, format: 'pdf', shape: 'rect', wMm: 80, hMm: 50, opaqueBg: false }));
  const [copy] = await doc.copyPages(doc, [0]);
  doc.addPage(copy);
  const { inspection } = await inspect(await doc.save());
  const p = planFor(inspection, intake({ filename: 'labels.pdf', qty: 2000, media: 'label_stock', notes: 'two label designs' }), { intent: 'label' });
  assert.equal(check(p, 'pages')?.status, 'fail');
  assert.equal(p.decision.kind, 'return');
});

test('R3-13: an over-budget PDF image is refused before it is decoded', async () => {
  const pdf = await rawPdf('0 0 1 rg 0 0 10 10 re f', {
    edit: (d) => { d.context.register(d.context.flateStream(new Uint8Array(100), { Type: 'XObject', Subtype: 'Image', Width: 20000, Height: 20000, ColorSpace: 'DeviceGray', BitsPerComponent: 8 })); },
  });
  await assert.rejects(inspect(pdf), (e: Rejected) => e.code === 'too-large');
});

test('R3-14: the 5 m cap covers every page box, and the printed size of a density-tagged raster', async () => {
  const pdf = await rawPdf('0 0 1 rg 0 0 10 10 re f', { w: 6000 * PT, h: 100 * PT, edit: (d) => d.getPage(0).setTrimBox(0, 0, 10 * PT, 10 * PT) });
  await assert.rejects(inspect(pdf), (e: Rejected) => e.code === 'too-large');
  // A raster's density is metadata, not an order: it is not refused at upload, but it is never prepared above 5 m.
  const cv = createCanvas(1000, 10);
  cv.getContext('2d').fillRect(0, 0, 1000, 10);
  const { inspection } = await inspect(setPngDensity(new Uint8Array(cv.toBuffer('image/png')), 2)); // 1000 px at 2 ppi = 12.7 m
  const banner = (o: Partial<Intake> = {}) => intake({ filename: 'b.png', qty: 1, media: 'pvc_banner', notes: 'banner', ...o });
  const asIs = planFor(inspection, banner(), { intent: 'banner' });
  assert.equal(check(asIs, 'size')!.status, 'fail');
  assert.equal(asIs.decision.kind, 'return');
  assert.equal(check(planFor(inspection, banner({ reqW: 3000, reqH: 30 }), { intent: 'banner' }), 'size')!.status, 'pass');
});
