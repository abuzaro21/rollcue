# Intent inference

RollCue infers which of four jobs a file is: **die-cut stickers**, **rectangular roll labels**, **poster**, or **banner**. Otherwise it abstains. The inference is a small calibrated model over measured file properties. There is no LLM and no external API.

## Inputs: 36 named features (`src/features.ts`)

All features come from the real uploaded bytes (`src/inspect.ts`) and the optional intake fields. The same code serves training files and live uploads.

| Group | Features |
|---|---|
| Geometry | `size_known`, `log_area`, `log_long`, `aspect`, `size_mismatch` (artwork vs requested size) |
| Shape of the artwork | `transparent`, `transparent_frac`, `rectangularity`, `islands` (separate pieces), `edge_touch` |
| Production marks | `cut_spot` (a spot colour that looks like a cut path), `bleed` |
| Format and resolution | `is_raster`, `vector_only`, `ppi_known`, `log_ppi` (effective PPI at the target size) |
| Order | `qty_known`, `log_qty`, `media_known`, `media_vinyl`, `media_label_stock`, `media_paper`, `media_photo_paper`, `media_pvc_banner` |
| Customer notes | `notes_empty`, `note_sticker`, `note_label`, `note_poster`, `note_banner`, `note_cut`, `note_outdoor`, `note_window` |
| Filename | `file_sticker`, `file_label`, `file_poster`, `file_banner` |

Notes and filename are tokenised and matched against a fixed lexicon (English and Arabic), with negation: "not a sticker" gives `note_sticker = −1`. Filename and notes are **separate** features, so the model learns that filenames are weaker evidence. The text is never interpreted or executed.

## Model (`src/model.ts`)

- Multinomial logistic regression: 4 classes, standardised inputs, L2 regularisation, trained by gradient descent (`scripts/train.ts`).
- **Calibration:** a temperature fitted on the validation split (T = 0.7).
- **Bands:** `confident` at p ≥ 0.9, `likely` at p ≥ 0.35.
- **Abstention:** the model abstains when the top probability is below 0.35 or the margin to the second is below 0.4. These thresholds give the widest coverage with ≥ 97% accepted accuracy on validation. Abstention produces an `intent` decision: a small visual choice of the top intents.
- **Explanation:** each feature's contribution to the margin between the top intent and the runner-up, (w_top − w_second) × standardised value. The card shows the strongest contributions for and against, **only for features present in this job**. These are the model's real reasons, not generated text.

## Evidence gate (`src/policy.ts` `evidenceOf`)

The probabilities are calibrated on synthetic data, so a confident call can still rest on weak ground. A reading is marked **thin evidence** when either:

- the filename carries at least 35% of the positive evidence for the top intent, or
- the job came with at most one of: quantity, size, media, notes.

Thin evidence does not change the reading. It changes the chip to "thin evidence" and adds a note: "Check this one before approving." On the held-out synthetic set it flags 4 of the 8 confident-and-wrong cases. On the hand-written set it flags the only confident-and-wrong case. It also flags some correct calls (69 of 543 confident correct synthetic cases); that is the cost of looking twice.

## Correction memory

When the operator corrects an intent, the job's feature vector and the corrected intent are stored for the session. For each new job, remembered corrections vote through a similarity kernel: similarity = exp(−mean squared difference of the standardised features ÷ τ), τ = 0.08, strength β = 6, ignored below 0.05 similarity. A near-duplicate (similarity ≥ 0.9) overrides the model with a boost of 40 logits, because the operator has already answered that question. The frozen model's weights never change. Details and measurements: [WRONG-GUESS-RECOVERY.md](WRONG-GUESS-RECOVERY.md).

## What decides production, and what does not

The model only decides **which job** this is. Everything after that is deterministic policy (`src/policy.ts`, `POLICY_VERSION`): resolution at size, roll fit, whether a cut path exists and is named `CutContour`, whether to trace a contour (only from real transparency) or cut a rectangle, bleed, return reasons. Learning never touches policy.

## Training data

Real customer files are private and were not used. `dataset/gen.ts` generates 1,600 synthetic jobs as real PDF, PNG and JPEG files with matching intake fields: varied shapes, sizes, resolutions, spot colours, notes (English and Arabic), misleading filenames and contradictory notes. `scripts/build-dataset.ts` runs every file through the same `inspect` and `features` code as a live upload.

The split is by generator family, so the test set is not near-duplicates of training:

- **test (626):** every case with a held-out shape kind (`star`, `rect-stripe`, `poster-grid`, `banner-split`) or the held-out note-phrasing family `C`.
- **train (756) / validation (218):** the rest, split 80/20 by seeded random draw.

A separate set of 32 hand-written edge cases (`dataset/handset.ts`) was authored to probe known weaknesses and is never used for training or threshold selection.

Results: [INFERENCE-EVALUATION.md](INFERENCE-EVALUATION.md).
