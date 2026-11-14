You are an independent, adversarial reviewer for a competition entry. You are read-only. Work only inside the current repository (RollCue). Do not read any other directory. You may run read-only commands such as `node` one-liners that read files and print results. Do not write files.

CHALLENGE: DOO Builders League, "Beyond the Chatbot". The entry must infer intent from real context, not a hardcoded script. A scripted sequence pretending to be inference is a disqualifier. Judges weigh technical depth (25%) and failure thinking (15%).

THIS REVIEW: R2, the intent-inference model and its evaluation.

Read what you need: src/features.ts, src/model.ts, src/model.json, src/policy.ts (the `evidenceOf` thin-evidence gate and the scope guard), dataset/gen.ts, dataset/handset.ts, dataset/handset.json, scripts/build-dataset.ts, scripts/train.ts, scripts/eval.ts, docs/INTENT-INFERENCE.md, docs/INFERENCE-EVALUATION.md, docs/evidence/inference-eval.json, docs/WRONG-GUESS-RECOVERY.md, test/preflight.test.ts.

YOUR TASKS:
1. **Leakage and circularity.** The data is synthetic, from the same generator family the features were designed around. Is the held-out split (held-out shapes, held-out notes family) real separation, or can the test set be predicted from artefacts of the generator (seeds, ids, filenames, exact sizes, note templates)? Are the features computed from the file and intake only, never from labels or sample ids? Is the standardiser, temperature or abstention threshold fitted on test data anywhere? Cite file:line.
2. **Are the reported numbers what the code computes?** Check top-1, ECE, abstention rate, accepted accuracy, wrong-confident count, keyword baseline and the correction-memory figures in docs/INFERENCE-EVALUATION.md against scripts/eval.ts and docs/evidence/inference-eval.json. Flag any metric that is defined unusually, any denominator that flatters, and any claim the evidence does not support.
3. **Calibration and abstention.** Is temperature fitting sound? Is ECE computed correctly (binning, weighting)? Is "wrong but confident" reported honestly, including cases that are flagged thin? Does the thin-evidence gate (filename share, context-signal count) behave sensibly, or could it be gamed or be always-on?
4. **Explanations.** Are the per-feature explanations ((w_top − w_second) × z, present features only) faithful to the model, or can they name a feature that did not drive the decision?
5. **Correction memory.** Kernel similarity = exp(−mean squared standardised distance ÷ τ), bounded boost β·sim, near-duplicate override at sim ≥ 0.9. Can a single correction flip unrelated jobs? Is the "0.1% of other jobs touched" figure measured correctly? Is the override threshold dangerous (for example, two genuinely different jobs that happen to be near-duplicates in feature space)? Is memory correctly scoped to a session?
6. **Handset cases.** The 32 hand-written cases are the closest thing to real-world data. Are they honestly independent of the generator? Are the misses reported fully?
7. What is the single most convincing additional evaluation that could be added cheaply, and the single most misleading sentence in the docs?

FORMAT: plain markdown, at most about 1500 words. Number each finding R2-1, R2-2, … with a severity (blocker / major / minor / nit), evidence (file:line or computed figure), and the smallest fix. For any reproducible defect, describe a concrete failing test. End with a one-paragraph verdict: is this real inference with an honest evaluation?
