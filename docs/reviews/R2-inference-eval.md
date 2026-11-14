# Codex review R2: intent inference and evaluation

- **Reviewer:** Codex CLI 0.166.0, model `gpt-6.1-sol` (from the run log), sandbox `read-only`, reasoning effort `high`. Session `01a1d7a5-eba0-7010-9694-40b0599c3354`.
- **Reviewed commit:** `6832547`.
- **Brief:** [R2-inference-eval.prompt.md](R2-inference-eval.prompt.md). Look for leakage and circularity, check every reported number against the code, and attack calibration, the evidence gate, the explanations, the correction memory and the hand-written set.
- **Raw output:** kept locally under `docs/reviews/raw/` and not published, because the logs contain machine paths.

## Verdict (Codex, quoted)

> This is real learned inference over measured context, with no scripted-sequence mechanism evident. The arithmetic is reproducible and major limitations are acknowledged, but duplicate inputs, unsafe memory transfer, missed policy failures, and reporting errors prevent calling the evaluation fully honest as written.

Codex reproduced the committed model and the full evaluation exactly. It confirmed four things:
- features never see labels, ids or seeds;
- the standardiser is fitted on training data only, and temperature and abstention on validation only;
- temperature fitting minimises validation NLL;
- ECE uses ten equal-width, count-weighted bins.

## Findings and what was done

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| R2-1 | major | The family holdout does not prevent duplicate inputs: 10 of 626 test vectors were identical to training vectors and 58 were near-duplicates. The docs said the test set was "not near-duplicates of training". | The evaluation now reports test jobs by their nearest-training similarity, with top-1 on the 573 jobs that are not near-copies (94.4%). The false sentence is replaced with the actual overlap. After the R2-2 feature fix, 3 test jobs are identical to training jobs and 53 are near-duplicates. The splits were not regrouped; the overlap is disclosed instead. | `overlapWithTraining` in the evaluation JSON, which CI pins. |
| R2-2 | major | One correction could confidently flip a different job type. `banner-2203` and `poster-1418` had identical feature vectors because a raster without density was featurised as square. The near-duplicate override then turned the poster into a banner at p = 1. | (a) Aspect ratio now falls back to pixel dimensions (`src/features.ts`). The dataset was rebuilt and the model retrained; no two jobs with different intents now share a feature vector. (b) When remembered corrections move a reading away from the model's own, the evidence gate flags the job and names the correction. The UI shows that note even when the reading came from memory. | `preflight.test.ts`: "a correction that overrides the model on another job is flagged…" and "correcting a banner does not turn a different-shaped poster into a banner (Codex R2-2 pair)". |
| R2-3 | major | The scope guard returned "Packaging labels for the soap bars" as out-of-scope packaging (9 test jobs), and the evaluation never ran policy, so this was invisible. | "Packaging" followed by labels or stickers is no longer out of scope. `outOfScope` is shared by policy and the evaluation, and the evaluation now reports false scope returns: 0 of 626 and 0 of 32. | `preflight.test.ts` "packaging labels are labels…"; `scopeFalseReturns` in the evaluation JSON. |
| R2-4 | major | Thin evidence could be cleared by meaningless context. Any non-blank note counted, a height-only size did not, and filename share used only the five displayed contributions. | Notes count only if they mention a job term. Width or height counts as size. Filename share is computed over every present positive contribution. Policy version bumped to `rc-policy-3`. | `preflight.test.ts` "courtesy text is not evidence; a height-only size is". |
| R2-5 | minor | "Other jobs whose top intent changed (0.1%)" actually counted any memory match. | The evaluation reports matched, changed, helped and harmed pairs separately: 31 matched and 0 changed of 20,625 after retraining. The docs give the counts and say the unit is correction–job pairs. | Evaluation JSON, pinned by CI. |
| R2-6 | minor | "Share of confident calls flagged" was divided by all jobs. | Both rates are reported under accurate names: 16.0% of all jobs and 11.4% of confident calls (synthetic). | Evaluation JSON. |
| R2-7 | minor | Explanation labels hid the direction of a value. A below-average rectangularity was shown as "Artwork fills rectangles", and negated mentions kept "Notes mention…". | Labels now carry direction: "(less than usual)" for below-average values and "Notes rule out …" for negations. The docs say explanations are relative to the training mean and not a complete causal account. | `preflight.test.ts` "explanations say which way a value points". |
| R2-8 | minor | `npm run dataset` defaulted to 320 per intent, while the committed dataset uses 400. | Default changed to 400. Regenerating reproduces the 1,600 / 756 / 218 / 626 split. | `preflight.test.ts` "the documented dataset command reproduces the committed dataset size". |
| R2-9 | minor | Slice names overclaimed: "no physical size" meant no *requested* size, and "no resolution information" meant no embedded density. The "no text" ablation was read as "most signal is in the artwork". | Slices renamed. Ablations are described as inference-time masking, and the artwork claim was removed. | Documentation and the evaluation JSON keys. |
| R2-10 | minor | The hand-written cases use the same renderer, and cases where abstaining is right were credited for confident answers. | The docs state the shared renderer. Cases marked `uncertain` (2) are scored on whether they abstain or are flagged: both are flagged and neither abstains. | `uncertainHandled` in the evaluation JSON. |

Codex's suggested strongest additional evaluation was a small blind set of anonymised real print-shop jobs, labelled before running the frozen model. It is **not done**: no real customer files are available to this project, and the directive forbids using private ones.

## Effect of the retrain

The R2-2 feature fix changed the inputs, so the dataset was rebuilt, the model retrained (`rc-intent-480403c831`, T = 0.75, abstention thresholds unchanged at 0.35 / 0.4) and every figure regenerated. Synthetic test:
- top-1 went from 94.1% to 94.7%;
- ECE went from 0.017 to 0.009;
- confident-and-wrong cases went from 8 to 6.

Two results got worse, and both are reported:
- hand-written top-1 fell from 87.5% to 84.4%, because `vinyl-wall-print` now abstains wrongly;
- the evidence gate now flags only 2 of 6 synthetic confident-and-wrong cases (it was 4 of 8 under the old, truncated filename-share calculation).

One test changed after retraining. The model now abstains on a poster PDF that carries a stroked CutContour (margin 0.29 < 0.4), which is a contradictory file. "wrong cut paths are returned…" checks the cut rule, so it now sets the poster intent as an operator would, instead of relying on the model.

All seven demo samples still tell the story their manifest claims (`npm run samples`).

## Status

All ten findings are addressed. The six new tests failed on the reviewed code (the R2-2 pair test failed because the two vectors were identical) and pass now. Totals: 33/33 unit tests, 30/30 browser tests, 7/7 artifacts valid. These fixes were made **after** R2 and have not been re-reviewed by Codex; the final-diff review (R7) covers them.
