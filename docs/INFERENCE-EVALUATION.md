# Inference evaluation

Source of truth: [`evidence/inference-eval.json`](evidence/inference-eval.json), produced by `npm run eval` from the committed model `rc-intent-8c9b8fb884`. CI re-runs the evaluation and fails if the numbers differ from the committed file.

**Read these numbers with their limit in mind.** The test files are synthetic. They come from the same generator as the training files, with held-out shape kinds and note phrasing. They show that the method works and how it fails. They do not measure accuracy on real customer files, which has not been measured.

## Held-out synthetic test set (n = 626)

| Metric | Value |
|---|---|
| Top-1 accuracy | 94.1% |
| Top-2 accuracy | 98.2% |
| Macro F1 | 0.931 |
| Brier score | 0.088 |
| Expected calibration error | 0.017 |
| Abstention rate | 5.1% |
| Accuracy when not abstaining | 96.3% |
| Wrong and not abstained | 22 |
| Wrong and confident (p ≥ 0.9) | 8 |
| Keyword-only baseline (top-1) | 68.1% |

Confusion (rows = truth, columns = predicted):

| | sticker | label | poster | banner |
|---|---|---|---|---|
| **sticker** | 77 | 3 | 2 | 0 |
| **label** | 9 | 129 | 1 | 0 |
| **poster** | 3 | 6 | 165 | 0 |
| **banner** | 3 | 2 | 8 | 218 |

The commonest error is a label read as a sticker (9 cases). Both are cut, adhesive and small, so that is the expected weak spot.

### Slices

| Slice | n | Top-1 |
|---|---|---|
| Held-out shape kinds | 510 | 93.1% |
| Held-out note phrasing | 169 | 98.2% |
| Misleading filename | 107 | 85.0% |
| Notes contradict the artwork | 50 | 80.0% |
| No notes | 173 | 89.0% |
| Arabic notes | 67 | 95.5% |
| No physical size | 222 | 90.1% |
| No resolution information | 125 | 90.4% |
| Opaque sticker (no transparency to trace) | 23 | 78.3% |
| Transparent poster | 22 | 86.4% |
| Artwork scaled to a different order size | 154 | 92.2% |

### Ablations (top-1 when a feature group is removed)

| Removed | Top-1 |
|---|---|
| Nothing | 94.1% |
| All text features | 90.3% |
| Filename | 92.2% |
| Notes | 91.7% |

Text helps, but most of the signal is in the artwork itself. A keyword-only classifier reaches 68.1%.

## Hand-written edge cases (n = 32)

Authored separately to attack known weaknesses: misleading filenames, negated notes ("not a sticker"), Arabic notes, round labels, wall decals, 1:10 banners, no information at all. Never used for training or tuning.

| Metric | Value |
|---|---|
| Top-1 | 87.5% |
| Top-2 | 100% |
| Abstention rate | 12.5% |
| Accuracy when not abstaining | 92.9% |
| Wrong and confident | 1 |
| ECE | 0.088 |
| Keyword-only baseline | 53.1% |

The confident wrong case is `stickers-final-window`: an A4 window poster whose filename says stickers and which came with no other instructions. The model says sticker at p = 0.9999. **The evidence gate flags it as thin**, and it is the sample used to demonstrate recovery. The other wrong, non-abstained case is `record-label-party`, an A1 poster for a record label's launch party, read as a label at p = 0.79 ("likely", not "confident"). Abstained cases: a round jar-lid label, a typo-named label file, a vinyl wall print and a bare poster PDF with no instructions.

## Evidence gate

| | Synthetic test | Hand-written |
|---|---|---|
| Share of confident calls flagged | 16.6% | 21.9% |
| Confident and wrong | 8 | 1 |
| … of which flagged | 4 | 1 |
| Confident and right, flagged anyway | 69 of 543 | 3 of 23 |

## Correction memory

For each of the 37 wrong predictions in the test set, the evaluation simulates the operator correcting it, then measures:

| Measure | Value |
|---|---|
| The corrected case is right afterwards | 100% |
| Near-variants of the corrected case right, before the correction | 3.8% (185 variants) |
| Near-variants right, after the correction | 96.8% |
| Other test jobs right, before | 94.2% |
| Other test jobs right, after | 94.2% (23,125 job–correction pairs) |
| Other jobs whose top intent the memory changed | 0.1% |

Near-variants are "the same customer sends a similar job": same intent, shape kind, notes, filename and media; new colours, size ±10%, quantity ×0.5–2 (`dataset/gen.ts` `variantOf`).

## Reproduce

```bash
npm run dataset   # regenerate dataset/cases.json (deterministic)
npm run train     # retrain src/model.json (deterministic, seed 20261114)
npm run eval      # rewrite docs/evidence/inference-eval.json
```
