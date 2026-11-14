# Inference evaluation

Source of truth: [`evidence/inference-eval.json`](evidence/inference-eval.json), produced by `npm run eval` from the committed model `rc-intent-480403c831`. CI re-runs the evaluation and fails if the numbers differ from the committed file.

**Read these numbers with their limit in mind.** The test files are synthetic. They come from the same generator and renderer as the training files, with held-out shape kinds and note phrasing. They show that the method works and how it fails. They do not measure accuracy on real customer files, which has not been measured.

This page was revised after Codex review R2 ([reviews/R2-inference-eval.md](reviews/R2-inference-eval.md)). That review found that rasters without density metadata were featurised as square, along with several reporting errors. The model was retrained on the corrected features, and every figure below is from the retrained model.

## Held-out synthetic test set (n = 626)

| Metric | Value |
|---|---|
| Top-1 accuracy | 94.7% |
| Top-2 accuracy | 98.7% |
| Macro F1 | 0.937 |
| Brier score | 0.077 |
| Expected calibration error (10 equal-width bins) | 0.009 |
| Abstention rate | 5.0% |
| Accuracy when not abstaining | 97.0% |
| Wrong and not abstained | 18 |
| Wrong and confident (p ≥ 0.9) | 6 |
| Keyword-only baseline (top-1) | 68.1% |

Confusion (rows = truth, columns = predicted):

| | sticker | label | poster | banner |
|---|---|---|---|---|
| **sticker** | 77 | 3 | 2 | 0 |
| **label** | 9 | 129 | 1 | 0 |
| **poster** | 3 | 6 | 165 | 0 |
| **banner** | 1 | 4 | 4 | 222 |

The commonest error is a label read as a sticker (9 cases). Both are cut, adhesive and small, so that is the expected weak spot.

### How close is the test set to training?

The split holds out shape kinds and a note-phrasing family, but other parts of the generator are shared across splits: poster sizes, filename templates and most notes vectors. So some test jobs look almost exactly like training jobs to the model. The table uses the memory kernel's similarity on standardised features.

| | n | Top-1 |
|---|---|---|
| Identical feature vector in training | 3 | |
| Near-duplicate of a training job (similarity ≥ 0.9) | 53 | 98.1% |
| **Everything else** | **573** | **94.4%** (abstains 5.1%, 6 wrong and confident) |

The fair headline is therefore about 94% on jobs that are not near-copies of training. This tests new combinations of generator parts more than genuinely new kinds of evidence.

### Slices

| Slice | n | Top-1 |
|---|---|---|
| Held-out shape kinds | 510 | 94.1% |
| Held-out note phrasing | 169 | 97.6% |
| Misleading filename | 107 | 86.0% |
| Notes contradict the artwork | 50 | 82.0% |
| No notes | 173 | 89.6% |
| Arabic notes | 67 | 95.5% |
| No requested size (the file may still have one) | 222 | 91.4% |
| No embedded density (effective resolution may still be known) | 125 | 92.8% |
| Opaque sticker (no transparency to trace) | 23 | 78.3% |
| Transparent poster | 22 | 86.4% |
| Artwork scaled to a different order size | 154 | 93.5% |

### Masking feature groups at inference time

These numbers come from zeroing a feature group on the trained model, not from retraining without it.

| Masked | Top-1 |
|---|---|
| Nothing | 94.7% |
| Filename and notes | 91.5% |
| Filename | 93.6% |
| Notes | 92.5% |

With filename and notes masked, the model still has quantity, requested size and media as well as the file itself. So this shows the model is not a keyword matcher, but it does not show how much signal comes from the artwork alone. A keyword-only classifier reaches 68.1%.

### Policy outcomes

The model is not the only thing that can get a job wrong. Policy can also return a supported job as out of scope. Every test job is a supported intent, so any scope return is a false rejection. The count is **0 of 626** synthetic and **0 of 32** hand-written. This figure was added after R2 found nine "packaging labels" jobs being returned as packaging.

## Hand-written edge cases (n = 32)

Authored separately to attack known weaknesses: misleading filenames, negated notes ("not a sticker"), Arabic notes, round labels, wall decals, 1:10 banners, no information at all. Never used for training or tuning. They are not independent real-world artwork: their files are drawn by the same renderer and shape vocabulary as the synthetic set.

| Metric | Value |
|---|---|
| Top-1 | 84.4% |
| Top-2 | 100% |
| Abstention rate | 12.5% |
| Accuracy when not abstaining | 92.9% |
| Wrong and not abstained | 2 |
| Wrong and confident | 1 |
| ECE | 0.081 |
| Keyword-only baseline | 53.1% |

Misses:

- `stickers-final-window`: an A4 window poster whose filename says stickers and which came with no other instructions. The model says sticker at p = 0.9998, **and the evidence gate flags it as thin**. It is the sample used to demonstrate recovery.
- `record-label-party`: an A1 poster for a record label's launch party, read as a label at p = 0.76 ("likely", not "confident"). It is not flagged.
- Abstained and wrong: `jar-lid-round-label`, `typo-poster-for-jars`, `vinyl-wall-print`. (`bare-pdf-poster` also abstained, though its top guess was right.)

Two cases are marked `uncertain`: for them the right behaviour is to abstain or flag, not to answer confidently. Both, `stickers-final-window` and `no-info-circle`, are flagged as thin evidence; neither abstains. Their top-1 result is not credited as a success of the gate.

## Evidence gate

A reading is flagged when the filename carries at least 35% of all positive evidence for the top intent, or when the job has at most one meaningful instruction: quantity, a width or height, media, or notes that mention something about the job ("thanks" does not count).

| | Synthetic test | Hand-written |
|---|---|---|
| Flagged, of all jobs | 16.0% | 21.9% |
| Flagged, of confident calls | 11.4% (62 of 544) | 16.7% (4 of 24) |
| Confident and wrong | 6 | 1 |
| … of which flagged | 2 | 1 |
| Confident and right, flagged anyway | 60 of 538 | 3 of 23 |

The gate is advisory: it never changes the reading, it asks the operator to look. It catches only a third of the synthetic confident-and-wrong cases. Before R2, the filename share was computed from only the five contributions shown on screen, and 4 of 8 such cases were flagged. The corrected calculation catches fewer.

## Correction memory

For each of the 33 wrong predictions in the test set, the evaluation simulates the operator correcting it, then measures:

| Measure | Value |
|---|---|
| The corrected case is right afterwards | 100% |
| Near-variants of the corrected case right, before the correction | 4.2% (165 variants) |
| Near-variants right, after the correction | 96.4% |
| Other test jobs right, before / after | 94.9% / 94.9% (20,625 correction–job pairs) |
| Pairs where memory matched the other job at all | 31 |
| Pairs where memory changed the other job's top intent | 0 |
| Under policy: near-variants applied right without a question | 80.0% |
| Under policy: near-variants asked (memory would overturn the model; remembered answer offered first) | 16.4% |

Each pair is one correction against one other job. Corrections are not accumulated across a session here, so this does not measure a session with many corrections.

Near-variants are "the same customer sends a similar job": same intent, shape kind, notes, filename and media; new colours, size ±10%, quantity ×0.5–2 (`dataset/gen.ts` `variantOf`).

The last two rows count what the operator sees: policy lets a correction re-type a job by itself only for near-duplicates (similarity ≥ 0.9). Otherwise it asks (Codex R5-4). When remembered corrections make the reading differ from the model's own, the evidence gate flags the job: "Read as X only because you corrected Y; the model alone reads Z." Similarity in feature space is not proof that two jobs share an intent.

## Reproduce

```bash
npm run dataset   # regenerate dataset/cases.json (deterministic, 400 per intent)
npm run train     # retrain src/model.json (deterministic, seed 20261114)
npm run eval      # rewrite docs/evidence/inference-eval.json
```
