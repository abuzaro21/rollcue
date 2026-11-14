// Builds the demo jobs in samples/ from the synthetic generator (no customer artwork), then runs each through the real
// inspect → infer → plan path and fails if any sample no longer tells the story the manifest claims.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { makeFile, type FileSpec } from '../dataset/gen.ts';
import { inspect } from '../src/inspect.ts';
import { featurize, type Intake, type Intent } from '../src/features.ts';
import { predict, type ModelFile } from '../src/model.ts';
import { plan } from '../src/policy.ts';

type Spec = {
  id: string; title: string; story: string; seed?: boolean; ext: 'pdf' | 'png' | 'jpg'; file: FileSpec; intake: Omit<Intake, 'filename'> & { filename: string };
  expect: { decision: 'intent' | 'size' | 'return' | 'release'; truth: Intent; modelTop?: Intent; modelWrong?: boolean; thin?: boolean; cut?: string };
};

const S: Spec[] = [
  {
    id: 'market-stickers', seed: true, title: 'Market stall stickers', ext: 'pdf',
    story: 'Transparent artwork with no cut path. RollCue infers die-cut stickers and has already traced a contour and prepared the production PDF.',
    file: { format: 'pdf', shape: 'badge', wMm: 60, hMm: 60, opaqueBg: false, seed: 101 },
    intake: { filename: 'olive-market-sticker.pdf', qty: 500, reqW: null, reqH: null, media: 'vinyl', notes: 'die cut stickers for the market stall' },
    expect: { decision: 'release', truth: 'sticker', modelTop: 'sticker', cut: 'contour' },
  },
  {
    id: 'stickers-final', seed: true, title: 'stickers-final.pdf', ext: 'pdf',
    story: 'Named like a sticker job, but it is one A4 window poster. RollCue leans sticker on thin evidence; correcting it shows recovery.',
    file: { format: 'pdf', shape: 'blob', wMm: 210, hMm: 297, opaqueBg: false, seed: 102 },
    intake: { filename: 'stickers-final.pdf', qty: 1, reqW: null, reqH: null, media: null, notes: '' },
    expect: { decision: 'release', truth: 'poster', modelWrong: true, thin: true },
  },
  {
    id: 'honey-labels', seed: true, title: 'Honey jar labels', ext: 'pdf',
    story: 'A clean label file that already carries a stroked CutContour. Nothing to fix; RollCue keeps the supplied cut.',
    file: { format: 'pdf', shape: 'rect-rounded', wMm: 90, hMm: 60, opaqueBg: true, cutSpot: { name: 'CutContour' }, title: 'WILD HONEY', seed: 103 },
    intake: { filename: 'honey-jar-labels.pdf', qty: 3000, reqW: null, reqH: null, media: 'label_stock', notes: 'jar labels, 3000 on a roll' },
    expect: { decision: 'release', truth: 'label', modelTop: 'label', cut: 'keep' },
  },
  {
    id: 'soft-poster', seed: true, title: 'Shop window poster (low resolution)', ext: 'jpg',
    story: 'A 700-pixel JPEG asked for at A2. RollCue prepares a polite return notice instead of a blurry print.',
    file: { format: 'jpeg', shape: 'poster-full', wMm: 420, hMm: 594, opaqueBg: true, px: 700, densityMeta: false, seed: 104 },
    intake: { filename: 'window-poster.jpg', qty: 2, reqW: 420, reqH: 594, media: 'photo_paper', notes: 'poster for the shop window, A2' },
    expect: { decision: 'return', truth: 'poster', modelTop: 'poster' },
  },
  {
    id: 'shop-banner', title: 'Shop banner supplied at 1:10', ext: 'pdf',
    story: 'Drawn at 300 × 100 mm, ordered at 3 × 1 m with Arabic notes. RollCue scales it and checks the effective resolution.',
    file: { format: 'pdf', shape: 'banner-bands', wMm: 300, hMm: 100, opaqueBg: true, seed: 105 },
    intake: { filename: 'shop-sign.pdf', qty: 1, reqW: 3000, reqH: 1000, media: 'pvc_banner', notes: 'يافطة للمحل' },
    expect: { decision: 'release', truth: 'banner', modelTop: 'banner' },
  },
  {
    id: 'jam-labels-misnamed', title: 'poster-for-jars.pdf', ext: 'pdf',
    story: 'The filename says poster; the size, quantity, stock and notes say labels. RollCue weighs the whole job, not the name.',
    file: { format: 'pdf', shape: 'rect', wMm: 80, hMm: 50, opaqueBg: false, seed: 106 },
    intake: { filename: 'poster-for-jars.pdf', qty: 2000, reqW: null, reqH: null, media: 'label_stock', notes: 'labels for the jam jars' },
    expect: { decision: 'release', truth: 'label', modelTop: 'label' },
  },
  {
    id: 'misnamed-cut', title: 'Cut path with the wrong name', ext: 'pdf',
    story: 'The die line is named "Cut Contour" with a space. The cutter would ignore it, so RollCue returns it rather than guess.',
    file: { format: 'pdf', shape: 'circle', wMm: 70, hMm: 70, opaqueBg: false, cutSpot: { name: 'Cut Contour' }, seed: 107 },
    intake: { filename: 'round-sticker.pdf', qty: 400, reqW: null, reqH: null, media: 'vinyl', notes: 'round stickers, kiss cut' },
    expect: { decision: 'return', truth: 'sticker', modelTop: 'sticker' },
  },
];

const model = JSON.parse(readFileSync('src/model.json', 'utf8')) as ModelFile;
mkdirSync('samples', { recursive: true });
let bad = 0;
const manifest = [];
for (const s of S) {
  const bytes = await makeFile(s.file);
  const file = `${s.id}.${s.ext}`;
  writeFileSync(`samples/${file}`, bytes);
  const { inspection } = await inspect(bytes);
  const intake: Intake = { ...s.intake };
  const pred = predict(model, featurize(inspection, intake), { items: [], version: 'mem-empty' });
  const p = plan(inspection, intake, pred, {});
  const build = p.decision.kind === 'release' ? p.decision.build : null;
  const problems = [
    p.decision.kind !== s.expect.decision && `decision ${p.decision.kind} ≠ ${s.expect.decision}`,
    s.expect.modelTop && pred.top !== s.expect.modelTop && `model ${pred.top} ≠ ${s.expect.modelTop}`,
    s.expect.modelWrong && pred.top === s.expect.truth && 'model is right; wrong-guess sample needs a wrong guess',
    s.expect.thin && !p.evidence.thin && 'evidence not flagged thin',
    s.expect.cut && build?.cut !== s.expect.cut && `cut ${build?.cut} ≠ ${s.expect.cut}`,
  ].filter(Boolean);
  bad += problems.length;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${s.id.padEnd(20)} ${pred.top}@${pred.pTop.toFixed(2)} ${pred.band}${p.evidence.thin ? ' thin' : ''} → ${p.decision.kind}: ${p.decision.headline}${build ? ` [cut ${build.cut}]` : ''} ${problems.join('; ')}`);
  const { expect, ext, file: _f, ...rest } = s;
  manifest.push({ ...rest, file, truth: expect.truth });
}
writeFileSync('samples/manifest.json', JSON.stringify({ note: 'Synthetic files from dataset/gen.ts via scripts/make-samples.ts. No customer artwork.', samples: manifest }, null, 2) + '\n');
if (bad) { console.error(`${bad} sample expectation(s) failed`); process.exit(1); }
