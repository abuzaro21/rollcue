# Architecture decisions

Gate G1 record. Claude wrote Architecture A ([reviews/ARCH-A-claude.md](reviews/ARCH-A-claude.md)) before reading Codex's independent Architecture B ([reviews/ARCH-B-codex.md](reviews/ARCH-B-codex.md); prompt in [reviews/ARCH-B-codex.prompt.md](reviews/ARCH-B-codex.prompt.md), model `gpt-6.1-sol`, read-only sandbox). This file resolves the differences. Date: 2026-11-14.

Challenge: DOO Builders League, "Beyond the Chatbot". The official page (build.doo.ooo/challenges/beyond-the-chatbot) says "Open until Dec 15, 2026" and gives no closing time or time zone. Internal target: release-ready by **2026-12-10**.

## D1. Workflow: roll-fed print intake and preflight

Both proposals ranked print intake first. Claude scored it 40 against 30 or less for the others. Codex scored it 40 against 38 for proof approval and 33 for the support workbench. It wins on visual proof, on how much a wrong guess changes the work, and on a physical artifact (a production PDF). It is also the owner's professional domain.

Codex's condition was to abandon it if real geometry extraction and a valid spot-colour PDF could not be shown in week one. **The condition was met on day one:**
- pdf.js + @napi-rs/canvas rendered a transparent PDF to an alpha mask in Node 24. The measured opaque fraction was 0.421 against 0.422 expected.
- pdf-lib wrote a `Separation /CutContour /DeviceCMYK` stroke.
- Ghostscript 10.00 `tiffsep`, an independent RIP-class renderer, produced a separate `CutContour` plate from it.

Scope, frozen: one operator (prepress at a small roll-fed shop) and four intents: **die-cut stickers, rectangular roll labels, posters, banners**.
- Packaging and arbitrary dielines are out of scope. The system abstains on them or returns them; it never pretends.

## D2. Name: **RollCue**

| Name | Source | Finding |
|---|---|---|
| PRESSENSE | brief | **Rejected.** Press-sense was a print workflow product with preflight (trade press, 2009; Presstek partnership). Codex recalled it, and a web search confirmed it. Same-domain collision. |
| MAKEREADY | Claude | Rejected. Xerox FreeFlow Makeready and Konica Minolta Make Ready are print software. |
| KEYLINE | Claude | Rejected. Keyline (Crispy Mountain) is print-shop workflow SaaS. |
| CutNext, ProofCue | Codex | Generic. ProofCue invites confusion with proofing products. |
| **RollCue** | Codex | No software or app hits in a web search on 2026-11-14. This is not a trademark clearance. |

The name means the cue for the next move on the roll. Tagline (from the brief, kept): **"The next decision, not another dashboard."**

## D3. Inference: calibrated multinomial logistic regression plus deterministic checks

Both proposed the same model class. Final design:
- **Features** (about 40, named) come from the real inspection of the file and the partial intake:
  - geometry: size, aspect, page boxes, bleed
  - alpha shape: transparency, coverage, components, rectangularity, edge contact
  - spot-colour resources, effective PPI at size, quantity, media
  - curated keyword groups from notes and from the filename. These are separate features with negation handling, so the model can learn that filenames are weaker evidence.
  - explicit missing-value indicators
- **Training data:** synthetic jobs. A generator produces real PDF/PNG/JPEG files, which go through the same inspection code as live uploads.
- **Held-out split** is by generator family: unseen note-phrase templates and unseen shape kinds, so there are no near-duplicate leaks. There is also a separately authored set of hand-written edge cases, kept out of training.
- **Calibration:** temperature scaling on validation. Report ECE, Brier, top-1, top-2, accepted accuracy, coverage, and wrong high-confidence counts.
- **Abstention:** the threshold and margin are chosen on validation. When the model abstains, the UI shows a small visual choice, never a question box.
- **Explanations** are the model's own per-feature contributions (w·x). They are not generated prose.
- Production checks (size, scale, resolution, cut path, bleed, roll fit) are **deterministic policy**, versioned as `policyVersion`. Learning never touches them.

## D4. Learning from corrections — disagreement resolved

Codex: keep the deployed model frozen; the correction becomes a hard constraint plus saved labelled evidence. Claude: a session-scoped online update. Resolution as built, which keeps both safety properties:
1. The global model is frozen and versioned (`modelVersion`). Corrections never change its weights.
2. A correction is a **hard constraint** on that job. The operator's intent replaces the model's.
3. The correction is also stored as **session correction memory**: the corrected job's feature vector and intent. A new job's prediction is mixed with a kernel vote from remembered corrections (similarity = exp(−mean squared difference of the standardised features ÷ τ), τ = 0.08, strength β = 6, ignored below similarity 0.05). A near-duplicate (similarity ≥ 0.9) overrides the model, because the operator already answered that exact question. The memory is scoped to one session. The operator can see it ("Remembers N corrections") and clear it ("Forget them"). Its version (`memoryVersion`) is part of every approval binding.
4. The first implementation was a bounded weight-delta adapter, as planned. It was replaced by the kernel memory because it hurt unrelated jobs: accuracy on them fell from 98.3% to 90.3% after corrections. That was measured on an earlier, easier version of the synthetic benchmark, before the generator was widened. A weight change shifts every job's score; the kernel memory changes only jobs that resemble a correction.
5. Corrections are stored as labelled evidence for a future, separately evaluated model version.

Measured on the held-out set ([INFERENCE-EVALUATION.md](INFERENCE-EVALUATION.md)): the corrected case is right afterwards (1.0), near-variants are right 96.4% of the time, accuracy on other jobs is unchanged (94.9% before and after), and memory changed the top intent of none of 20,625 correction–job pairs. A memory-driven reading that disagrees with the model is flagged for checking.

**Evidence gate.** A confident reading is flagged "thin evidence" when the filename carries at least 35% of the decision or at most one context signal supports it. The flag does not change the reading; it tells the operator to look before approving. On the hand-written set it flags the one confident wrong case.

**Explanations** list only features that are present in the job (value ≠ 0), so the evidence never cites, for example, a media type the customer did not give.

## D5. Cut contours — disagreement resolved

Codex: never invent an irregular cut path from a silhouette. Claude: deriving the contour from real alpha is the standard RIP workflow. Resolution:
- An irregular contour is prepared **only when the source has real transparency** (a PNG alpha channel, or PDF content over a transparent page). It is derived from that alpha: distance-transform offset, marching squares, then simplification. The UI and ticket state the derivation resolution and the tolerance.
- Opaque artwork never gets a guessed shape. The only cut offered is a rectangle, and only for rectangular intent. Anything else is returned for a cut path.
- The stroke is `Separation /CutContour` with tint 1.0, stroke only, overprint on, 0.25 pt, and the source page embedded unchanged (vectors preserved).
- Verification has three layers: a pdf-lib re-parse, a pdf.js re-render, and Ghostscript `tiffsep` in CI, which must emit a `CutContour` plate.

## D6. Action safety

Inference, proposal, preparation, approval, execution and verification are separate states.
- Each job carries a `revision`. Any source, parameter or intent change increments it and supersedes every open proposal in the same transaction.
- A worker records the revision it started from. If the job has moved on, it cannot publish.
- An approval must echo `proposalId` and `artifactSha256`. The server recomputes `bindingHash = sha256(sourceSha256, action, canonical params, artifactSha256, policyVersion, modelVersion, memoryVersion, revision)` from its own rows. Any mismatch, or a superseded proposal, returns 409.
- Execution is idempotent. A release is not "done" until verification passes; a failure is recorded as failed and nothing is claimed.
- Nothing prints. Nothing is sent externally. The uploaded original is never modified.

## D7. Formats and security

- Formats: PDF, PNG and JPEG. **SVG is deferred**: Codex flagged sanitisation risk, and the core workflow does not need it.
- Mutations need a custom header (CSRF). Session cookies are HttpOnly, SameSite=Lax, and Secure in production.
- Every job, proposal, artifact and audit query is scoped by session.
- Limits: magic-byte sniffing, a 10 MB cap, a megapixel cap read from headers before decode, page cap, worker_thread resource limits with a hard timeout, one analysis at a time, per-IP rate limits, per-session quotas, 48 h retention.
- pdf.js runs with `isEvalSupported: false`. No JS, actions, attachments or external references are ever executed or followed.
- Notes are only tokenised into features. There is no LLM, so injected instructions have nothing to command; a test pins this.

## D8. Persistence and hosting

- One Node 24 TypeScript service (native type stripping) serves the Vite-built React UI.
- Postgres via `pg` when `DATABASE_URL` is set; PGlite (Postgres in WASM) locally and in tests. One SQL dialect.
- Artifacts live in `bytea`, so restarts keep them.
- Hosting: free tiers only, in a new isolated workspace. Existing DOO workspaces are off-limits.

## D9. Interface

Five states, one decision at a time:
- arrival
- reading (real analysis steps)
- decision (a single card, with "Not this?" alternatives)
- review (before/after: the "after" is a server render of the actual output PDF)
- released (artifact, verification, receipt)

Evidence only on demand. No KPI cards, no chat box, no tool palette. The legacy comparison is a separate, clearly labelled, representative multi-tab preflight UI that runs the same job on the same backend. Interaction counts come from Playwright runs of both.
