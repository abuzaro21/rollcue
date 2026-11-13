// Held-out evaluation. Reads dataset/cases.json (test split) and dataset/handset.json (hand-written, never trained on),
// writes docs/evidence/inference-eval.json and prints a summary. Usage: node scripts/eval.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { FEATURE_NAMES, INTENTS, type Intent } from '../src/features.ts';
import { memoryOf, predict, MEMORY, type ModelFile } from '../src/model.ts';
import { genCase, makeFile, variantOf } from '../dataset/gen.ts';
import { inspect } from '../src/inspect.ts';
import { featurize } from '../src/features.ts';
import { evidenceOf } from '../src/policy.ts';

type Row = { x: number[]; intent: Intent; id: string; intake?: any; shape?: string; notes?: string; tags?: string[]; split?: string };
const model: ModelFile = JSON.parse(readFileSync('src/model.json', 'utf8'));
const cases: Row[] = JSON.parse(readFileSync('dataset/cases.json', 'utf8')).cases;
const hand: Row[] = existsSync('dataset/handset.json') ? JSON.parse(readFileSync('dataset/handset.json', 'utf8')).cases : [];
const fi = (n: string) => FEATURE_NAMES.indexOf(n);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function metrics(rows: Row[], xform = (x: number[]) => x) {
  const n = rows.length;
  let top1 = 0, top2 = 0, brier = 0, abst = 0, accAcc = 0, wrongConfident = 0, wrongAccepted = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, acc: 0 }));
  const conf: Record<string, Record<string, number>> = Object.fromEntries(INTENTS.map((a) => [a, Object.fromEntries(INTENTS.map((b) => [b, 0]))]));
  for (const c of rows) {
    const p = predict(model, xform(c.x));
    const ok = p.top === c.intent;
    top1 += +ok; top2 += +p.ranked.slice(0, 2).includes(c.intent);
    INTENTS.forEach((k) => (brier += (p.probs[k] - (k === c.intent ? 1 : 0)) ** 2 / n));
    const b = bins[Math.min(9, Math.floor(p.pTop * 10))]; b.n++; b.conf += p.pTop; b.acc += +ok;
    if (p.abstain) abst++; else { accAcc += +ok; if (!ok) wrongAccepted++; }
    if (!ok && p.band === 'confident') wrongConfident++;
    conf[c.intent][p.top]++;
  }
  const ece = bins.reduce((s, b) => s + (b.n ? (b.n / n) * Math.abs(b.acc / b.n - b.conf / b.n) : 0), 0);
  const f1 = INTENTS.map((k) => {
    const tp = conf[k][k], fp = INTENTS.reduce((s, o) => s + (o !== k ? conf[o][k] : 0), 0), fn = INTENTS.reduce((s, o) => s + (o !== k ? conf[k][o] : 0), 0);
    return tp ? (2 * tp) / (2 * tp + fp + fn) : 0;
  });
  return {
    n, top1: r3(top1 / n), top2: r3(top2 / n), macroF1: r3(f1.reduce((a, b) => a + b, 0) / f1.length), brier: r3(brier), ece: r3(ece),
    abstainRate: r3(abst / n), acceptedAccuracy: r3(accAcc / Math.max(1, n - abst)), wrongAccepted, wrongConfident, confusion: conf,
    reliability: bins.map((b, i) => ({ bin: `${i / 10}-${(i + 1) / 10}`, n: b.n, meanConf: b.n ? r3(b.conf / b.n) : null, accuracy: b.n ? r3(b.acc / b.n) : null })),
  };
}

/** Keyword baseline: the intent named most in notes + filename; no single winner → "sticker" (the first class). */
function keywordBaseline(rows: Row[]) {
  let ok = 0;
  for (const c of rows) {
    const score = INTENTS.map((k) => Math.max(0, c.x[fi(`note_${k}`)]) + Math.max(0, c.x[fi(`file_${k}`)]));
    const mx = Math.max(...score);
    const guess = mx > 0 && score.filter((s) => s === mx).length === 1 ? INTENTS[score.indexOf(mx)] : 'sticker';
    ok += +(guess === c.intent);
  }
  return r3(ok / rows.length);
}
const blank = (names: string[]) => (x: number[]) => x.map((v, j) => (names.includes(FEATURE_NAMES[j]) ? 0 : v));
const TEXT = FEATURE_NAMES.filter((n) => n.startsWith('note_') || n.startsWith('file_'));
const FILE = FEATURE_NAMES.filter((n) => n.startsWith('file_'));
const NO_NOTES = (x: number[]) => x.map((v, j) => (FEATURE_NAMES[j].startsWith('note_') ? 0 : FEATURE_NAMES[j] === 'notes_empty' ? 1 : v));

const test = cases.filter((c) => c.split === 'test');
const slice = (pred: (c: Row) => boolean) => { const s = test.filter(pred); return s.length ? { n: s.length, top1: metrics(s).top1 } : null; };

// Correction carry-over: for each wrong test prediction, the operator corrects it; the correction goes into session
// memory. Then score (a) the corrected job itself, (b) 5 regenerated near-variants of it (same customer, similar job),
// and (c) every other test case, before and after. (c) measures collateral damage.
const wrong = test.filter((c) => predict(model, c.x).top !== c.intent);
let fixed = 0, varBefore = 0, varAfter = 0, varN = 0, otherBefore = 0, otherAfter = 0, otherN = 0, otherTouched = 0;
for (const w of wrong) {
  const mem = memoryOf([{ jobId: w.id, filename: 'x', intent: w.intent, x: w.x }]);
  fixed += +(predict(model, w.x, mem).top === w.intent);
  const [intent, seed] = [w.id.split('-')[0] as Intent, Number(w.id.split('-')[1])];
  const base = genCase(intent, seed);
  for (let k = 1; k <= 5; k++) {
    const v = variantOf(base, k);
    const { inspection } = await inspect(await makeFile(v.file));
    const x = featurize(inspection, v.intake);
    varBefore += +(predict(model, x).top === intent); varAfter += +(predict(model, x, mem).top === intent); varN++;
  }
  for (const c of test) {
    if (c === w) continue;
    const p = predict(model, c.x, mem);
    otherBefore += +(predict(model, c.x).top === c.intent); otherAfter += +(p.top === c.intent); otherN++;
    if (p.memory.length) otherTouched++;
  }
}

/** Evidence gate: how often a confident call is flagged as resting on thin evidence, split by right and wrong. */
function gate(rows: Row[]) {
  let confident = 0, wrongConf = 0, wrongConfFlagged = 0, rightConf = 0, rightConfFlagged = 0, flagged = 0;
  for (const c of rows) {
    const p = predict(model, c.x), ev = evidenceOf(p, c.intake);
    flagged += +ev.thin;
    if (p.band !== 'confident') continue;
    confident++;
    if (p.top === c.intent) { rightConf++; rightConfFlagged += +ev.thin; } else { wrongConf++; wrongConfFlagged += +ev.thin; }
  }
  return { flaggedRate: r3(flagged / rows.length), confident, wrongConfident: wrongConf, wrongConfidentFlagged: wrongConfFlagged, rightConfident: rightConf, rightConfidentFlagged: rightConfFlagged };
}

const out = {
  model: model.version, temperature: model.temperature, abstain: model.abstain, bands: model.bands, generatedAt: new Date().toISOString().slice(0, 10),
  syntheticTest: metrics(test),
  evidenceGate: { syntheticTest: gate(test), handset: hand.length ? gate(hand) : null },
  keywordBaseline: keywordBaseline(test),
  ablations: { noTextFeatures: metrics(test, blank(TEXT)).top1, noFilename: metrics(test, blank(FILE)).top1, noNotes: metrics(test, NO_NOTES).top1 },
  slices: {
    misleadingFilename: slice((c) => !!c.tags?.includes('misleading-filename')),
    conflictingNotes: slice((c) => !!c.tags?.includes('conflicting-notes')),
    noSize: slice((c) => !!c.tags?.includes('no-size')),
    noDensity: slice((c) => !!c.tags?.includes('no-density')),
    opaqueSticker: slice((c) => !!c.tags?.includes('opaque-sticker')),
    transparentPoster: slice((c) => !!c.tags?.includes('transparent-poster')),
    scaledArtwork: slice((c) => !!c.tags?.some((t) => t.startsWith('scaled'))),
    heldOutShapes: slice((c) => ['star', 'rect-stripe', 'poster-grid', 'banner-split'].includes(c.shape!)),
    heldOutPhrasing: slice((c) => c.notes === 'C'),
    arabicNotes: slice((c) => c.notes === 'AR'),
    noNotes: slice((c) => c.notes === 'none' || c.notes === 'neutral'),
  },
  correction: {
    memory: MEMORY,
    wrongPredictions: wrong.length,
    correctedCaseNowRight: r3(fixed / Math.max(1, wrong.length)),
    nearVariants: varN, nearVariantTop1Before: r3(varBefore / Math.max(1, varN)), nearVariantTop1After: r3(varAfter / Math.max(1, varN)),
    otherPairs: otherN, othersTop1Before: r3(otherBefore / Math.max(1, otherN)), othersTop1After: r3(otherAfter / Math.max(1, otherN)),
    othersTouchedByMemory: r3(otherTouched / Math.max(1, otherN)),
  },
  handset: hand.length ? {
    ...metrics(hand), keywordBaseline: keywordBaseline(hand),
    cases: hand.map((c) => { const p = predict(model, c.x); return { id: c.id, truth: c.intent, top: p.top, pTop: p.pTop, band: p.band, abstain: p.abstain, ok: p.top === c.intent }; }),
  } : null,
};
writeFileSync('docs/evidence/inference-eval.json', JSON.stringify(out, null, 1));
const s = out.syntheticTest;
console.log(`synthetic test n=${s.n} top1=${s.top1} top2=${s.top2} F1=${s.macroF1} ECE=${s.ece} brier=${s.brier} abstain=${s.abstainRate} acceptedAcc=${s.acceptedAccuracy} wrongConfident=${s.wrongConfident}`);
console.log('keyword baseline', out.keywordBaseline, 'ablations', JSON.stringify(out.ablations));
console.log('slices', JSON.stringify(out.slices));
console.log('correction', JSON.stringify(out.correction));
console.log('evidence gate', JSON.stringify(out.evidenceGate));
if (out.handset) {
  const h = out.handset;
  console.log(`handset n=${h.n} top1=${h.top1} top2=${h.top2} ECE=${h.ece} abstain=${h.abstainRate} acceptedAcc=${h.acceptedAccuracy} wrongConfident=${h.wrongConfident} kwBaseline=${h.keywordBaseline}`);
  for (const c of h.cases.filter((c) => !c.ok)) console.log('  miss', JSON.stringify(c));
}
