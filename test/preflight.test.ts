// Brief §17 critical regressions at the engine level: real generated files through inspect → infer → plan → build →
// verify. API-level regressions (sessions, approval, restart) live in api.test.ts and durability.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';
import { makeFile, type FileSpec } from '../dataset/gen.ts';
import { HANDSET, handIntake } from '../dataset/handset.ts';
import { inspect, Rejected, sniff, MAX_SIDE_MM } from '../src/inspect.ts';
import { featurize, type Intake } from '../src/features.ts';
import { predict, memoryOf, type ModelFile } from '../src/model.ts';
import { plan, type Params } from '../src/policy.ts';
import { buildProduction, verifyArtifact } from '../src/pdfout.ts';
import { traceContour, binaryAlpha } from '../src/geom.ts';
import { ghostscriptPlates } from './gs.ts';

const model = JSON.parse(readFileSync('src/model.json', 'utf8')) as ModelFile;
const intake = (o: Partial<Intake> & { filename: string }): Intake => ({ qty: null, reqW: null, reqH: null, media: null, notes: '', ...o });

async function run(file: Omit<FileSpec, 'seed'> & { seed?: number }, i: Intake, params: Params = {}) {
  const bytes = await makeFile({ seed: 7, ...file });
  const { inspection, render } = await inspect(bytes);
  const x = featurize(inspection, i);
  const pred = predict(model, x);
  return { bytes, inspection, render, x, pred, plan: plan(inspection, i, pred, params) };
}
const hand = (id: string) => { const c = HANDSET.find((h) => h.id === id)!; return run(c.file, handIntake(c)); };
const check = (p: { checks: Array<{ id: string; status: string }> }, id: string) => p.checks.find((c) => c.id === id)?.status;

test('wrong intent with high confidence is flagged as thin evidence, not silently trusted', async () => {
  const r = await hand('stickers-final-window');
  assert.equal(r.pred.top, 'sticker');          // the model is wrong here (truth: poster)
  assert.ok(r.pred.pTop > 0.9);
  assert.ok(r.plan.evidence.thin, 'evidence gate must flag it');
});

test('inference abstains when critical evidence is missing', async () => {
  const r = await hand('bare-pdf-poster');
  assert.ok(r.pred.abstain);
  assert.equal(r.plan.decision.kind, 'intent');
  assert.equal(r.plan.intent, null);
  assert.ok(r.plan.decision.options.length >= 2);
});

test('contradictory metadata: the whole job outweighs one wrong word', async () => {
  const r = await run({ format: 'pdf', shape: 'rect', wMm: 80, hMm: 50, opaqueBg: false }, intake({ filename: 'labels.pdf', qty: 2000, media: 'label_stock', notes: 'poster for the jam jars, 2000 on a roll' }));
  assert.equal(r.pred.top, 'label');
});

test('misleading filename does not decide the job', async () => {
  const r = await run({ format: 'pdf', shape: 'rect', wMm: 80, hMm: 50, opaqueBg: false }, intake({ filename: 'poster-for-jars.pdf', qty: 2000, media: 'label_stock', notes: 'labels for the jam jars' }));
  assert.equal(r.pred.top, 'label');
  assert.ok(r.pred.forTop.every((e) => !e.feature.startsWith('file_')));
});

test('unsupported and malformed files are refused before analysis', async () => {
  assert.equal(sniff(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniff(new TextEncoder().encode('MZ\x90\x00 executable')), null);
  await assert.rejects(inspect(new TextEncoder().encode('%PDF-1.7\nnot really a pdf\n%%EOF')), Rejected);
  await assert.rejects(inspect(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), Rejected);
});

test('unexpected page dimensions: oversize pages refused, rotated pages returned', async () => {
  const big = await makeFile({ seed: 1, format: 'pdf', shape: 'banner-bands', wMm: 6000, hMm: 1000, opaqueBg: true }).catch(() => null);
  if (big) await assert.rejects(inspect(big), (e: Rejected) => e.code === 'too-large' || /larger|5 m|exceeds/i.test(e.message));
  assert.ok(MAX_SIDE_MM <= 5000);
  const src = await makeFile({ seed: 2, format: 'pdf', shape: 'poster-full', wMm: 297, hMm: 420, opaqueBg: true });
  const doc = await PDFDocument.load(src);
  doc.getPage(0).node.set(PDFName.of('Rotate'), doc.context.obj(90));
  const rotated = await doc.save();
  const { inspection } = await inspect(rotated);
  const i = intake({ filename: 'poster.pdf', qty: 2, notes: 'poster' });
  const p = plan(inspection, i, predict(model, featurize(inspection, i)), {});
  assert.equal(check(p, 'rotation'), 'fail');
  assert.equal(p.decision.kind, 'return');
});

test('missing bleed is a warning, and RollCue never invents bleed', async () => {
  const r = await run({ format: 'pdf', shape: 'poster-full', wMm: 420, hMm: 594, opaqueBg: true }, intake({ filename: 'poster.pdf', qty: 3, media: 'paper', notes: 'A2 posters' }));
  assert.equal(r.plan.intent, 'poster');
  assert.equal(check(r.plan, 'bleed'), 'warn');
  assert.equal(r.plan.decision.kind, 'release');
  if (r.plan.decision.kind === 'release') assert.ok(!r.plan.decision.changes.some((c) => /bleed/i.test(c) && /add|extend|mirror/i.test(c)));
});

test('wrong cut paths are returned: misnamed, filled, or on a job that is not cut', async () => {
  const sticker = intake({ filename: 'round.pdf', qty: 400, media: 'vinyl', notes: 'round stickers, kiss cut' });
  const misnamed = await run({ format: 'pdf', shape: 'circle', wMm: 70, hMm: 70, opaqueBg: false, cutSpot: { name: 'Cut Contour' } }, sticker);
  assert.equal(check(misnamed.plan, 'cut'), 'fail');
  assert.equal(misnamed.plan.decision.kind, 'return');
  const filled = await run({ format: 'pdf', shape: 'circle', wMm: 70, hMm: 70, opaqueBg: false, cutSpot: { name: 'CutContour', filled: true } }, sticker);
  assert.equal(check(filled.plan, 'cut'), 'fail');
  const poster = await run({ format: 'pdf', shape: 'poster-full', wMm: 420, hMm: 594, opaqueBg: true, cutSpot: { name: 'CutContour' } }, intake({ filename: 'poster.pdf', qty: 2, notes: 'poster for the window' }), { intent: 'poster' }); // the cut rule, not the model: the retrained model abstains on this contradictory file
  assert.equal(poster.plan.intent, 'poster');
  assert.equal(check(poster.plan, 'cut'), 'fail');
  const good = await run({ format: 'pdf', shape: 'circle', wMm: 70, hMm: 70, opaqueBg: false, cutSpot: { name: 'CutContour' } }, sticker);
  assert.equal(good.plan.decision.kind, 'release');
  if (good.plan.decision.kind === 'release') assert.equal(good.plan.decision.build.cut, 'keep');
});

test('output validity: contour PDF keeps vectors, has a stroked CutContour separation, trim box and verifies', async () => {
  const r = await run({ format: 'pdf', shape: 'badge', wMm: 60, hMm: 60, opaqueBg: false }, intake({ filename: 's.pdf', qty: 500, media: 'vinyl', notes: 'die cut stickers' }));
  assert.equal(r.plan.decision.kind, 'release');
  if (r.plan.decision.kind !== 'release') return;
  const b = r.plan.decision.build;
  assert.equal(b.cut, 'contour');
  const mask = binaryAlpha(new Uint8ClampedArray(r.render.rgba), r.render.w, r.render.h);
  const c = traceContour(mask, r.render.w, r.render.h, 60 / r.render.w, b.offsetMm);
  assert.ok(c.loops.length >= 1);
  const pdf = await buildProduction({ kind: 'pdf', bytes: r.bytes, inspection: r.inspection, targetW: b.targetW, targetH: b.targetH, fit: b.fit, marginMm: b.marginMm, bleedMm: b.bleedMm, cut: c.loops, cropMarks: b.cropMarks, title: 't', subject: 's', stamp: new Date(0) });
  const v = await verifyArtifact(pdf, { pageW: b.targetW + 2 * b.marginMm, pageH: b.targetH + 2 * b.marginMm, trim: { x: b.marginMm, y: b.marginMm, w: b.targetW, h: b.targetH }, cutLoops: c.loops.length });
  assert.ok(v.checks.every((k) => k.pass), JSON.stringify(v.checks.filter((k) => !k.pass)));
  const again = await buildProduction({ kind: 'pdf', bytes: r.bytes, inspection: r.inspection, targetW: b.targetW, targetH: b.targetH, fit: b.fit, marginMm: b.marginMm, bleedMm: b.bleedMm, cut: c.loops, cropMarks: b.cropMarks, title: 't', subject: 's', stamp: new Date(0) });
  assert.deepEqual(again, pdf, 'deterministic output');
  const plates = await ghostscriptPlates(pdf);
  if (plates === null) { console.log('# ghostscript not installed: tiffsep plate check skipped'); return; }
  assert.ok(plates.includes('CutContour'), `plates: ${plates.join(', ')}`);
});

test('session memory: a correction fixes near-duplicates and leaves unrelated jobs alone', async () => {
  const wrong = await hand('stickers-final-window');
  const mem = memoryOf([{ jobId: 'j1', filename: 'stickers-final.pdf', intent: 'poster', x: wrong.x }]);
  assert.equal(predict(model, wrong.x, mem).top, 'poster');
  const unrelated = await run({ format: 'pdf', shape: 'rect-rounded', wMm: 90, hMm: 60, opaqueBg: true, cutSpot: { name: 'CutContour' } }, intake({ filename: 'honey.pdf', qty: 3000, media: 'label_stock', notes: 'jar labels' }));
  const before = predict(model, unrelated.x), after = predict(model, unrelated.x, mem);
  assert.equal(after.top, before.top);
  assert.equal(after.memory.length, 0);
  // Memory never masquerades as the model: the model-alone probabilities stay with the prediction (Codex R1-8).
  const remembered = predict(model, wrong.x, mem);
  assert.equal(remembered.probs.poster > 0.9, true);
  assert.equal(remembered.modelProbs.sticker > 0.9, true);
});

test('unsupported work (packaging, dielines) is stopped by policy, not read as the nearest intent (Codex R1-6)', async () => {
  const r = await run({ format: 'pdf', shape: 'blob', wMm: 210, hMm: 297, opaqueBg: false }, intake({ filename: 'box.pdf', qty: 500, notes: 'packaging carton with dieline' }));
  assert.equal(r.plan.decision.kind, 'return');
  assert.equal(r.plan.decision.headline, 'Outside what RollCue prepares');
  assert.equal(r.plan.intent, null);
  assert.equal(check(r.plan, 'scope'), 'fail');
  const over = plan(r.inspection, intake({ filename: 'box.pdf', qty: 500, notes: 'packaging carton with dieline' }), r.pred, { intent: 'sticker' });
  assert.equal(over.intent, 'sticker', 'the operator can still override');
  assert.notEqual(over.decision.kind, 'intent');
});

test('packaging labels are labels, not out-of-scope packaging (Codex R2-3)', async () => {
  const i = intake({ filename: 'soap.pdf', qty: 2000, media: 'label_stock', notes: 'Packaging labels for the soap bars.' });
  const r = await run({ format: 'pdf', shape: 'rect', wMm: 90, hMm: 50, opaqueBg: true }, i);
  assert.notEqual(check(r.plan, 'scope'), 'fail');
  assert.notEqual(r.plan.decision.headline, 'Outside what RollCue prepares');
});

test('courtesy text is not evidence; a height-only size is (Codex R2-4)', async () => {
  const c = HANDSET.find((h) => h.id === 'no-info-circle')!;
  const r = await run(c.file, intake({ filename: 'IMG_2231.png', qty: 1, notes: 'thanks' }));
  assert.equal(r.plan.evidence.contextSignals, 1);
  assert.equal(r.plan.evidence.thin, true);
  const h = await run(c.file, intake({ filename: 'IMG_2231.png', qty: 1, reqH: 70 }));
  assert.equal(h.plan.evidence.contextSignals, 2);
  // Filename share is computed over every present contribution, not only the five shown.
  assert.ok(r.pred.filenameShare >= 0 && r.pred.filenameShare <= 1);
});

test('a correction that overrides the model on another job is flagged for checking (Codex R2-2)', async () => {
  const banner = await run({ format: 'pdf', shape: 'banner-bands', wMm: 2000, hMm: 500, opaqueBg: true }, intake({ filename: 'shop.pdf', qty: 1, media: 'pvc_banner', notes: 'banner for the shop' }));
  assert.equal(banner.pred.top, 'banner');
  // An operator corrected an identical-looking job to poster earlier in the session.
  const mem = memoryOf([{ jobId: 'other', filename: 'other.pdf', intent: 'poster', x: banner.x }]);
  const carried = predict(model, banner.x, mem);
  assert.equal(carried.top, 'poster');
  const p = plan(banner.inspection, intake({ filename: 'shop.pdf', qty: 1, media: 'pvc_banner', notes: 'banner for the shop' }), carried, {});
  assert.equal(p.evidence.thin, true);
  assert.ok(p.evidence.reasons.some((r) => r.includes('only because you corrected other.pdf') && r.includes('the model alone reads banner')));
});

test('correcting a banner does not turn a different-shaped poster into a banner (Codex R2-2 pair)', () => {
  const cases = JSON.parse(readFileSync('dataset/cases.json', 'utf8')).cases as Array<{ id: string; intent: 'banner' | 'poster'; x: number[] }>;
  const banner = cases.find((c) => c.id === 'banner-2203')!, poster = cases.find((c) => c.id === 'poster-1418')!;
  assert.notDeepEqual(banner.x, poster.x, 'a raster without density keeps its pixel aspect ratio');
  const mem = memoryOf([{ jobId: banner.id, filename: 'b.png', intent: 'banner', x: banner.x }]);
  assert.equal(predict(model, poster.x, mem).top, predict(model, poster.x).top);
});

test('explanations say which way a value points (Codex R2-7)', async () => {
  const neg = await hand('negated-sticker');
  const all = [...neg.pred.forTop, ...neg.pred.againstTop, ...Object.values(neg.pred.forEach).flat()];
  assert.ok(all.every((e) => !(e.value < 0 && /^(note|file)_/.test(e.feature)) || /rule out/.test(e.label)), 'a negated mention is never worded as a mention');
  const z = (e: { feature: string; value: number }) => (e.value - model.mean[model.features.indexOf(e.feature)]) / model.std[model.features.indexOf(e.feature)];
  assert.ok(all.every((e) => z(e) >= 0 || /less than usual|rule out/.test(e.label)), 'a below-average value is labelled as such');
});

test('the documented dataset command reproduces the committed dataset size (Codex R2-8)', () => {
  const def = Number(/process\.argv\[2\] \?\? (\d+)/.exec(readFileSync('scripts/build-dataset.ts', 'utf8'))![1]);
  assert.equal(JSON.parse(readFileSync('dataset/cases.json', 'utf8')).perIntent, def);
});

test('an unresolved check is never reported as "every check passes" (Codex R1-11)', async () => {
  const r = await run({ format: 'pdf', shape: 'rect', wMm: 100, hMm: 60, opaqueBg: true, cutSpot: { name: 'CutContour' } }, intake({ filename: 'lbl.pdf', qty: 2000, media: 'label_stock', notes: 'jar labels' }));
  const ins = { ...r.inspection, imageCount: 1, densityPpi: null, pixels: null };
  const p = plan(ins, intake({ filename: 'lbl.pdf', qty: 2000, media: 'label_stock', notes: 'jar labels' }), r.pred, {});
  assert.equal(check(p, 'resolution'), 'unknown');
  assert.equal(p.decision.kind, 'release');
  assert.doesNotMatch(p.decision.found, /Every check passes/);
  assert.ok(p.decision.kind === 'release' && p.decision.warnings.some((w) => w.startsWith('Not confirmed: resolution')));
});

test('no hardware, network or process control anywhere in the shipped service', () => {
  const files = readdirSync('src').filter((f) => f.endsWith('.ts'));
  for (const f of files) {
    const s = readFileSync(`src/${f}`, 'utf8');
    assert.doesNotMatch(s, /from 'node:(child_process|net|dgram|tls|http2)'|from '(child_process|net|dgram|serialport|usb|ipp|printer)'/, f);
    assert.doesNotMatch(s, /\blpr?\s*\(|execFile\(|execSync\(|\bfetch\(/, f);
  }
});
