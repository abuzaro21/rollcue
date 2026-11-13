## 1. Independent comparison

**Print preflight wins narrowly—provided the product promises a reviewable production proposal, not automatic print readiness.** Its strongest advantage is the owner’s ability to supply credible files, operator judgments, and production constraints.

Scores are architectural judgments, not research results. Five is strongest; feasibility means approximately three weeks by one AI-assisted builder.

| Criterion | Print preflight | Artwork revision / proof approval | Support resolution workbench |
|---|---:|---:|---:|
| 30-second wow | 5 | 4 | 3 |
| Truly non-chat interface | 5 | 4 | 3 |
| Real intent-inference opportunity | 4 | 4 | 4 |
| Useful proactive action | 4 | 4 | 4 |
| Graceful wrong-guess recovery | 5 | 5 | 4 |
| Compelling side-by-side | 5 | 4 | 4 |
| Realistic data availability | 4 | 4 | 3 |
| Three-week / free-host feasibility | 3 | 4 | 4 |
| Lasting usefulness | 5 | 5 | 4 |
| **Total / 45** | **40** | **38** | **33** |

**Proof approval** is the safer build: show the changed region, identify an unresolved instruction, prepare a proof, request approval. However, it can become an annotation tool with AI summaries, and realistic revision histories are harder to assemble than individual artwork files.

**Support resolution** offers strong contextual inference from tickets and account events. Its weaknesses are integration access, consequential account actions, and the likelihood of becoming a ticket dashboard with generated replies.

**Print preflight should lose** if reliable geometry extraction and valid PDF output cannot be demonstrated during week one. In that case, choose proof approval. A polished interface cannot rescue fabricated preflight findings.

## 2. Names

Availability and collisions are unverified:

- **RollCue — “The next production decision.”** Best fit for the initial operator and roll-media context; somewhat restrictive outside printing.
- **CutNext — “From artwork to the next right action.”** Memorable, but generic cutting terminology could create naming/search collisions.
- **ProofCue — “Decide once. Produce with confidence.”** Broader scope; could be confused with proofing or proofreading products.
- **PRESSENSE — “The next decision, not another dashboard.”** Strong positioning, but resembles the historical print-workflow name **Press-sense** that I recall. I would shortlist another name.

No trademark conclusions follow from these observations.

## 3. Architecture B: RollCue

### Operator and scope

One print-shop operator receives artwork and incomplete customer instructions.

Support PDF, PNG, and a deliberately restricted SVG subset. The first useful workflow is **rectangular labels and sticker proofs**, with poster/general-proof alternatives. Packaging and arbitrary die-cut shapes may be recognized but require manual preparation.

The proactive artifact is a dimensioned proof and job ticket. For supported rectangular work, also prepare a production PDF with a rectangular CutContour stroke. Never invent an irregular cut path from a silhouette.

### Screen states

The interface is an artwork workspace with one decision occupying the foreground:

| State | What appears |
|---|---|
| Intake | Drop artwork; paste the customer’s original notes. |
| Inspecting | Artwork preview and honest processing status. |
| Decision | One proposed action over the artwork, two or three supporting facts, primary approval/correction controls. |
| Uncertain | One specific question: “Finished size: 80 × 50 mm or supplied size?” |
| Corrected | Revised proposal and a short explanation of what changed. |
| Approved | Download the exact approved artifact and its approval receipt. |
| Invalidated | Changed input identified; refreshed proposal requires review. |

Example: “Prepare 80 × 50 mm rectangular labels?” Evidence: supplied page dimensions, requested dimensions, missing CutContour.

Detailed measurements remain available through disclosure. Avoid permanent KPI cards, job tables, confidence gauges, and chat transcripts.

### Intent inference

Separate **probabilistic intent** from **deterministic production checks**.

Features:

- Page dimensions, aspect ratio, page count, rotation.
- Requested dimensions and discrepancy from supplied dimensions.
- PNG pixel dimensions; effective DPI where placement and final size are known.
- Bleed-box relationships.
- Detected spot-color resource names.
- Notes represented by word/character n-grams, including negation.
- Missing or unknown evidence explicitly encoded.

Use regularized multinomial logistic regression implemented and executed locally in TypeScript. Classes: die-cut sticker, rectangular label, poster, packaging, general proof. No inference API is needed.

Generate approximately 5,000 labeled synthetic examples from independent intent, geometry, and note generators. Include contradictory instructions, misleading filenames, absent dimensions, and “do not cut.” Split by **generator family and phrase template**, not random rows; hold out geometry/note combinations too.

Use validation data for temperature calibration and abstention thresholds. Report held-out macro-F1, Brier score, calibration error, accepted-prediction accuracy, and coverage. Initial targets might be ≥95% accepted accuracy, probability ≥0.85, and margin ≥0.20; these are targets to test, not claims.

Synthetic evaluation establishes controlled behavior, not real-world accuracy. Also evaluate untouched, de-identified shop files labeled by the operator. Unsupported documents and contradictory evidence trigger abstention.

**After correction:** the corrected intent becomes an explicit constraint for that job. Recompute checks, cancel incompatible artifacts, and prepare the appropriate proposal. Save the correction as labeled evidence. Keep the deployed model frozen during the demo; future learning requires a separately evaluated model version.

### Proactive actions and approval

A deterministic action policy consumes inferred intent, extracted evidence, supported capabilities, and unresolved checks.

It can prepare a proof, rectangular cut PDF, ticket, or simple grid-based roll estimate. Estimate usable width from configured printable width and margins—not the nominal 160 cm media width. Label the estimate’s spacing and rotation assumptions.

Preparation happens automatically. Customer sending, production release, and approved export require human review. Draft viewing uses an interface overlay so approval does not silently change the underlying artifact bytes.

Bind approval to:

`SHA256(source bytes + canonical parameters + artifact hash + policy version + model version + job revision)`

Store the constituent fields, operator/session identity, and timestamp. Use a server-side authenticated receipt; the browser cannot manufacture approval.

Every source, parameter, correction, or relevant version change increments the revision and invalidates approval. Artifact generation records its starting revision; stale workers cannot publish results. Approval creation and release both check the current revision transactionally.

### Persistence and security

Use one Node 24 service serving the Vite build, handling uploads, running bounded parser workers, and accessing free Postgres. Store small, capped artifact bytes there initially. SQLite is acceptable only with verified durable hosting; ephemeral disks cannot support durable approvals.

Security boundaries:

- Session-scoped ownership on every job, artifact, and approval query.
- Secure, HttpOnly, SameSite cookies; CSRF protection for mutations.
- Example limits: 15 MB uploads, ten PDF pages, bounded decoded pixels, execution deadlines, and bounded concurrency.
- Reject encrypted, malformed, or unsupported documents with an actionable explanation.
- Never execute PDF JavaScript, attachments, launch actions, or external references.
- Sanitize SVG through an allowlist; reject scripts, entities, external URLs, `foreignObject`, and unsupported constructs.
- Never render uploaded SVG or notes as trusted HTML.
- Treat notes as untrusted evidence. They cannot override policy or authorize release.

Worker termination limits resource abuse; workers are not a strong isolation boundary. Public uploads therefore remain a material risk. Give sessions quotas and short retention, and encourage demonstration with sample artwork.

### Real PDF generation in Node

These are implementation candidates from existing knowledge; versions and compatibility are unverified.

- **pdf-lib:** page boxes, embedding PNG/PDF content, drawing proofs, and low-level PDF objects.
- **pdfjs-dist:** parsing, previews, and operator-list inspection; verify its Node 24 setup early.
- A strict XML parser for the supported SVG subset; convert only supported geometry.

A genuine CutContour requires a PDF **Separation color space**, named `CutContour`, with a tint transform and stroked path. A magenta RGB line is insufficient. This requires low-level pdf-lib work and a focused validity check.

Report separation **presence** separately from verified use on a cutting path. Account for nested resources; never search raw PDF text and claim complete detection. Likewise, report embedded-image DPI as unknown when transforms cannot be resolved reliably.

Do not claim PDF/X compliance, complete color management, automatic bleed repair, or production certification.

### Build and demo

**Week one:** prove extraction, spot-color PDF generation, and hosting.  
**Week two:** implement inference, revision binding, and correction.  
**Week three:** adversarial cases, comparison, deployment, and deliverables.

The 90-second video:

1. Compare manual inspection and preparation against the same job in RollCue.
2. Show real measurements and an automatically prepared artifact.
3. Approve and download it.
4. Introduce ambiguous artwork; the model proposes stickers.
5. Correct to “poster.” Show cut preparation canceled, scaling reconsidered, and previous approval invalidated.
6. Change a dimension and demonstrate stale-release rejection.

Keep fixture selection unrestricted and publish the failure test, architecture snapshot, evaluation results, and 300-word thesis alongside the public repo.

## 4. Adversarial critique

| Hidden failure | Concrete proof against it |
|---|---|
| Dashboard disguised as a card | Measure whether operators can complete the workflow from artwork plus one decision, without scanning status panels. |
| Chatbot disguised as buttons | Complete intake, correction, review, and release without conversational prompting. |
| Scripted demo | Run previously unseen files, paraphrased notes, and shuffled inputs; publish extracted features and model outputs. |
| Classifier merely follows keywords | Test conflicting geometry/notes, negation, removed filenames, and single-feature perturbations. |
| “Proactive” means canned output | Verify output dimensions and content change with source bytes and approved parameters. |
| Correction is cosmetic | Assert changed intent cancels incompatible artifacts and invalidates prior approval. |
| Approval is decorative | Attempt release after source replacement, stale-worker completion, and cross-session access. |

The top eight judging risks:

1. **Invalid CutContour output:** validate the separation and inspect it in an independent print/prepress tool.
2. **Synthetic inference theatre:** disclose synthetic limits and demonstrate unseen shop files.
3. **Oversized scope:** arbitrary die-cut extraction and packaging can consume the schedule.
4. **Dashboard drift:** a job queue and metrics wall can overwhelm the defining interaction.
5. **Weak benefit:** measure operator time and consequential clicks on identical jobs.
6. **Unconvincing recovery:** demonstrate regenerated output and revoked authority, not just a changed label.
7. **Free-host instability:** verify cold starts, persistence, limits, and deployment early.
8. **Overclaimed readiness:** distinguish prepared artifacts, human approval, and actual RIP/hardware validation.

**Verdict:** Build RollCue as a narrow, artifact-producing print-intake tool whose defining behavior is proposing one useful decision and recovering visibly when corrected. Print preflight earns the win through credible domain evidence, physical output, and a compelling manual comparison; abandon that choice if the week-one PDF feasibility gate fails. External research and library/runtime checks were skipped as requested. The main remaining risk is valid production output and robust parsing, which this brief alone cannot establish.