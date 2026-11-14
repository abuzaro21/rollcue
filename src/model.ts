// Multinomial logistic regression with temperature calibration, abstention, per-feature explanations and a bounded
// correction memory. Small enough to read in one sitting; no external ML runtime.
import { createHash } from 'node:crypto';
import { FEATURE_NAMES, FEATURES, INTENTS, type Intent } from './features.ts';

export type ModelFile = {
  version: string;
  features: string[];
  classes: Intent[];
  mean: number[];
  std: number[];
  W: number[][]; // K × D, on standardised features
  b: number[];
  temperature: number;
  abstain: { minProb: number; minMargin: number };
  bands: { confident: number; likely: number };
  trainedOn: { cases: number; families: string[]; seed: number };
};

/** One operator correction remembered for the rest of the session. */
export type Correction = { jobId: string; filename: string; intent: Intent; x: number[] };
export type Memory = { items: Correction[]; version: string };
export const emptyMemory = (): Memory => ({ items: [], version: 'none' });
export function memoryOf(items: Correction[]): Memory {
  return { items, version: items.length ? 'mem-' + createHash('sha256').update(JSON.stringify(items.map((c) => [c.jobId, c.intent, c.x]))).digest('hex').slice(0, 12) : 'none' };
}

/**
 * Correction memory: a job that resembles a corrected job gets a logit boost toward the operator's intent, scaled by
 * similarity = exp(−mean squared standardised distance ÷ τ). Unrelated jobs are untouched by construction; the frozen
 * model weights never change. τ and β are fixed constants, reported in docs/INTENT-INFERENCE.md.
 */
// nearDuplicate: a job this close to a corrected one takes the operator's answer outright (the bounded boost cannot
// overturn a very confident model, and repeating a correction the operator already made is the worst kind of wrong).
export const MEMORY = { tau: 0.08, beta: 6, minSimilarity: 0.05, nearDuplicate: 0.9, override: 40 };

export type MemoryMatch = { jobId: string; filename: string; intent: Intent; similarity: number; nearDuplicate: boolean };

function memoryBoost(m: ModelFile, z: number[], mem?: Memory): { boost: number[]; matches: MemoryMatch[] } {
  const boost = new Array(m.classes.length).fill(0);
  const matches: MemoryMatch[] = [];
  for (const c of mem?.items ?? []) {
    const zc = standardise(m, c.x);
    const msd = zc.reduce((s, v, j) => s + (v - z[j]) ** 2, 0) / z.length;
    const sim = Math.exp(-msd / MEMORY.tau);
    if (sim < MEMORY.minSimilarity) continue;
    const k = m.classes.indexOf(c.intent);
    boost[k] = Math.max(boost[k], sim >= MEMORY.nearDuplicate ? MEMORY.override : MEMORY.beta * sim);
    matches.push({ jobId: c.jobId, filename: c.filename, intent: c.intent, similarity: round(sim), nearDuplicate: sim >= MEMORY.nearDuplicate });
  }
  return { boost, matches: matches.sort((a, b) => b.similarity - a.similarity).slice(0, 3) };
}

export function standardise(m: Pick<ModelFile, 'mean' | 'std'>, x: number[]): number[] {
  return x.map((v, j) => (v - m.mean[j]) / m.std[j]);
}

export function logits(m: ModelFile, z: number[]): number[] {
  return m.classes.map((_, k) => {
    let s = m.b[k];
    for (let j = 0; j < z.length; j++) s += m.W[k][j] * z[j];
    return s;
  });
}

export function softmax(l: number[], T = 1): number[] {
  const mx = Math.max(...l);
  const e = l.map((v) => Math.exp((v - mx) / T));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

export type Evidence = { feature: string; label: string; value: number; weight: number };

export type Prediction = {
  modelVersion: string;
  memoryVersion: string;
  /** Corrected jobs this one resembles; their pull is already included in probs. */
  memory: MemoryMatch[];
  probs: Record<Intent, number>;
  /** The frozen model alone, before any correction memory, so the UI never presents memory as independent confirmation. */
  modelProbs: Record<Intent, number>;
  ranked: Intent[];
  top: Intent;
  pTop: number;
  margin: number;
  band: 'confident' | 'likely' | 'unsure';
  abstain: boolean;
  /** Why the top intent beat the runner-up: (w_top − w_second)·z, strongest first. Computed, not written. */
  forTop: Evidence[];
  againstTop: Evidence[];
  /** For each other intent, the features that pull toward it most (used by "Not this?"). */
  forEach: Record<Intent, Evidence[]>;
};

export function predict(m: ModelFile, x: number[], mem?: Memory): Prediction {
  const z = standardise(m, x);
  const { boost, matches } = memoryBoost(m, z, mem);
  const base = logits(m, z);
  const p = softmax(base.map((l, k) => l + boost[k] * m.temperature), m.temperature);
  const p0 = softmax(base, m.temperature);
  const order = p.map((v, k) => [v, k] as const).sort((u, v) => v[0] - u[0]).map(([, k]) => k);
  const [t, s] = order;
  const w = (k: number, j: number) => m.W[k][j];
  const diff = z.map((zj, j) => ({ feature: m.features[j], label: FEATURES[j].label, value: x[j], weight: round((w(t, j) - w(s, j)) * zj) }));
  // Only facts present in this job are shown as evidence; an absent feature still moves a linear model, but naming it
  // ("Media: Vinyl" when no media was given) would mislead the operator.
  const strongest = (arr: Evidence[], sign: 1 | -1) => arr.filter((e) => e.value !== 0 && e.weight * sign > 0.05).sort((u, v) => sign * (v.weight - u.weight)).slice(0, 5);
  const avg = (j: number) => m.classes.reduce((acc, _, k) => acc + w(k, j), 0) / m.classes.length;
  const forEach = Object.fromEntries(m.classes.map((c, k) => [c, strongest(z.map((zj, j) => ({
    feature: m.features[j], label: FEATURES[j].label, value: x[j], weight: round((w(k, j) - avg(j)) * zj),
  })), 1).slice(0, 3)])) as Record<Intent, Evidence[]>;
  const pTop = p[t], margin = p[t] - p[s];
  return {
    modelVersion: m.version,
    memoryVersion: mem?.version ?? 'none',
    memory: matches,
    probs: Object.fromEntries(m.classes.map((c, k) => [c, round(p[k], 4)])) as Record<Intent, number>,
    modelProbs: Object.fromEntries(m.classes.map((c, k) => [c, round(p0[k], 4)])) as Record<Intent, number>,
    ranked: order.map((k) => m.classes[k]),
    top: m.classes[t],
    pTop: round(pTop, 4),
    margin: round(margin, 4),
    band: pTop >= m.bands.confident ? 'confident' : pTop >= m.bands.likely ? 'likely' : 'unsure',
    abstain: pTop < m.abstain.minProb || margin < m.abstain.minMargin,
    forTop: strongest(diff, 1),
    againstTop: strongest(diff, -1),
    forEach,
  };
}

// ---------- training ----------

export type Example = { x: number[]; y: number };

export function fitStandardiser(xs: number[][]): { mean: number[]; std: number[] } {
  const d = xs[0].length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (const x of xs) x.forEach((v, j) => (mean[j] += v / xs.length));
  for (const x of xs) x.forEach((v, j) => (std[j] += (v - mean[j]) ** 2 / xs.length));
  return { mean, std: std.map((s) => Math.sqrt(s) || 1) };
}

/** Full-batch Adam on cross-entropy + L2. Deterministic: zero init, fixed order. */
export function train(data: Example[], k: number, opts: { l2?: number; epochs?: number; lr?: number } = {}) {
  const { l2 = 1e-3, epochs = 600, lr = 0.05 } = opts;
  const d = data[0].x.length;
  const W = Array.from({ length: k }, () => new Array(d).fill(0)), b = new Array(k).fill(0);
  const mW = W.map((r) => r.map(() => 0)), vW = W.map((r) => r.map(() => 0)), mb = b.map(() => 0), vb = b.map(() => 0);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  for (let ep = 1; ep <= epochs; ep++) {
    const gW = W.map((r) => r.map(() => 0)), gb = b.map(() => 0);
    for (const { x, y } of data) {
      const p = softmax(W.map((row, c) => b[c] + row.reduce((s, w, j) => s + w * x[j], 0)));
      for (let c = 0; c < k; c++) {
        const g = (p[c] - (c === y ? 1 : 0)) / data.length;
        gb[c] += g;
        for (let j = 0; j < d; j++) gW[c][j] += g * x[j];
      }
    }
    for (let c = 0; c < k; c++) {
      for (let j = 0; j < d; j++) {
        const g = gW[c][j] + l2 * W[c][j];
        mW[c][j] = b1 * mW[c][j] + (1 - b1) * g; vW[c][j] = b2 * vW[c][j] + (1 - b2) * g * g;
        W[c][j] -= (lr * (mW[c][j] / (1 - b1 ** ep))) / (Math.sqrt(vW[c][j] / (1 - b2 ** ep)) + eps);
      }
      mb[c] = b1 * mb[c] + (1 - b1) * gb[c]; vb[c] = b2 * vb[c] + (1 - b2) * gb[c] * gb[c];
      b[c] -= (lr * (mb[c] / (1 - b1 ** ep))) / (Math.sqrt(vb[c] / (1 - b2 ** ep)) + eps);
    }
  }
  return { W, b };
}

/** Temperature that minimises validation negative log-likelihood (grid search; one parameter). */
export function fitTemperature(rawLogits: number[][], ys: number[]): number {
  let best = 1, bestNll = Infinity;
  for (let T = 0.3; T <= 6.001; T += 0.05) {
    let nll = 0;
    rawLogits.forEach((l, i) => (nll -= Math.log(Math.max(1e-12, softmax(l, T)[ys[i]]))));
    if (nll < bestNll) { bestNll = nll; best = Math.round(T * 100) / 100; }
  }
  return best;
}

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
