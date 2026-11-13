// Trains src/model.json from dataset/cases.json. Uses only the train split for weights and only the validation split
// for temperature and abstention thresholds. The test split and the hand-written set are never touched here.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FEATURE_NAMES, INTENTS } from '../src/features.ts';
import { fitStandardiser, fitTemperature, logits, softmax, standardise, train, type ModelFile } from '../src/model.ts';

const SEED = 20261114;
const { cases } = JSON.parse(readFileSync('dataset/cases.json', 'utf8'));
const tr = cases.filter((c: any) => c.split === 'train'), va = cases.filter((c: any) => c.split === 'val');
const st = fitStandardiser(tr.map((c: any) => c.x));
const data = tr.map((c: any) => ({ x: standardise(st, c.x), y: INTENTS.indexOf(c.intent) }));
const { W, b } = train(data, INTENTS.length, { l2: 3e-3, epochs: 700, lr: 0.05 });
const model: ModelFile = {
  version: '', features: FEATURE_NAMES, classes: [...INTENTS], mean: st.mean, std: st.std, W, b, temperature: 1,
  abstain: { minProb: 0.5, minMargin: 0 }, bands: { confident: 0.9, likely: 0.5 },
  trainedOn: { cases: tr.length, families: [...new Set(tr.map((c: any) => c.shape + '/' + c.notes))].sort() as string[], seed: SEED },
};
const valLogits = va.map((c: any) => logits(model, standardise(model, c.x)));
const ys = va.map((c: any) => INTENTS.indexOf(c.intent));
model.temperature = fitTemperature(valLogits, ys);

// Abstention: the widest coverage whose accepted accuracy on validation is ≥ 97%.
const pv = valLogits.map((l: number[]) => softmax(l, model.temperature));
let best = { minProb: 0.95, minMargin: 0.5, coverage: 0, acc: 0 };
for (let p = 0.35; p <= 0.951; p += 0.025) for (let mg = 0; mg <= 0.501; mg += 0.025) {
  let acc = 0, n = 0;
  pv.forEach((pr: number[], i: number) => {
    const o = pr.map((v, k) => [v, k]).sort((a, b) => b[0] - a[0]);
    if (o[0][0] >= p && o[0][0] - o[1][0] >= mg) { n++; if (o[0][1] === ys[i]) acc++; }
  });
  const cov = n / pv.length, a = n ? acc / n : 0;
  if (a >= 0.97 && cov > best.coverage + 1e-9) best = { minProb: +p.toFixed(3), minMargin: +mg.toFixed(3), coverage: cov, acc: a };
}
model.abstain = { minProb: best.minProb, minMargin: best.minMargin };
model.bands = { confident: Math.max(0.9, best.minProb), likely: best.minProb };
model.version = 'rc-intent-' + createHash('sha256').update(JSON.stringify([W, b, model.temperature, model.abstain])).digest('hex').slice(0, 10);
writeFileSync('src/model.json', JSON.stringify(model, null, 1));
console.log(JSON.stringify({ version: model.version, train: tr.length, val: va.length, temperature: model.temperature, abstain: model.abstain, valCoverage: +best.coverage.toFixed(3), valAcceptedAcc: +best.acc.toFixed(3) }));
