// Builds dataset/cases.json: every synthetic case is generated as a real file and run through the same inspection code
// the live service uses. Usage: node scripts/build-dataset.ts [perIntent=320]
import { writeFileSync } from 'node:fs';
import { genCase, makeFile, splitOf } from '../dataset/gen.ts';
import { inspect } from '../src/inspect.ts';
import { featurize, INTENTS } from '../src/features.ts';

const per = Number(process.argv[2] ?? 320);
const rows = [];
const t0 = performance.now();
let n = 0;
for (let i = 0; i < per; i++) {
  for (const intent of INTENTS) {
    const seed = 1000 + i * INTENTS.length + INTENTS.indexOf(intent);
    const c = genCase(intent, seed);
    const bytes = await makeFile(c.file);
    const { inspection } = await inspect(bytes);
    rows.push({ id: c.id, intent, split: splitOf(c, seed), shape: c.shapeFamily, notes: c.noteFamily, tags: c.tags, intake: c.intake,
      file: { format: c.file.format, wMm: c.file.wMm, hMm: c.file.hMm, bytes: bytes.length },
      x: featurize(inspection, c.intake) });
    if (++n % 200 === 0) console.log(n, ((performance.now() - t0) / 1000).toFixed(1) + 's');
  }
}
writeFileSync('dataset/cases.json', JSON.stringify({ generator: 'dataset/gen.ts', perIntent: per, cases: rows }));
const count = (s: string) => rows.filter((r) => r.split === s).length;
console.log(`cases ${rows.length} train ${count('train')} val ${count('val')} test ${count('test')} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// Hand-written set: built with the same pipeline, stored separately, never trained on.
const { HANDSET, handIntake } = await import('../dataset/handset.ts');
const hand = [];
for (const [i, c] of HANDSET.entries()) {
  const intake = handIntake(c);
  const { inspection } = await inspect(await makeFile({ ...c.file, seed: 900000 + i }));
  hand.push({ id: c.id, intent: c.intent, why: c.why, intake, x: featurize(inspection, intake) });
}
writeFileSync('dataset/handset.json', JSON.stringify({ source: 'dataset/handset.ts', cases: hand }));
console.log(`handset ${hand.length}`);
