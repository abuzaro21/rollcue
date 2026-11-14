# Architecture

One Node 24 process serves the API and the built React UI. File work runs in a separate worker thread with hard limits. State lives in Postgres (PGlite in-process when no `DATABASE_URL` is set). There are no external services and no external API calls.

```
 browser (React, one card at a time)                      legacy.html (representative multi-tab preflight)
        │  x-rollcue header, rc_sid cookie                         │  same API, decisions marked manual
        ▼                                                          ▼
 src/http.ts ── rate limits, CSRF header, body caps, CSP, session cookie, SPA + static
        │
 src/service.ts ── sessions, jobs, proposals, approvals, corrections, events (hash chain), recovery
        │                     │
        │                     └─► src/pool.ts ── one worker_thread, one task at a time, 25 s timeout,
        │                                         320 MB heap cap, killed and replaced on timeout or crash
        │                                              │
        │                                         src/worker.ts
        │                                           analyse: inspect.ts → features.ts → model.ts → policy.ts
        │                                           prepare: geom.ts (contour) → pdfout.ts (production PDF / notice)
        │                                           verify:  pdfout.ts verifyArtifact (re-parse, re-render, checks)
        ▼
 src/db.ts ── pg (DATABASE_URL) or PGlite (RC_DATA_DIR); tables: sessions, jobs, proposals, corrections, events, metrics
```

## Modules

| File | Responsibility |
|---|---|
| `src/inspect.ts` | Sniffs magic bytes, enforces size/page/pixel caps, reads PDF boxes and spot-colour resources with pdf.js, renders to an alpha mask with @napi-rs/canvas, decodes PNG/JPEG. Any parser failure becomes a typed `Rejected('malformed')`. |
| `src/features.ts` | 36 named features from the inspection and the intake: geometry, transparency shape, spot colours, effective PPI, quantity, media, keyword groups from notes and filename (separately, with negation), missing-value flags. |
| `src/model.ts` | Multinomial logistic regression, temperature calibration, abstention, per-feature explanations, session correction memory, evidence gate. |
| `src/policy.ts` | Deterministic production rules (`POLICY_VERSION`): resolution at size, roll fit, cut path presence and naming, bleed, size mismatch. Produces one decision: `intent`, `size`, `return` or `release`. |
| `src/geom.ts` | Alpha mask → distance-transform offset → marching squares → simplified cut loops in mm. |
| `src/pdfout.ts` | Production PDF: the source page embedded unchanged, scaled to target, crop marks, and a `Separation /CutContour` stroke. Return notices. `verifyArtifact` re-parses and re-renders the output and checks page size, trim, cut name, cut stroke and loop count. |
| `src/layout.ts` | Places the job on the roll width and estimates media length. |
| `src/service.ts` | All state transitions. See [ACTION-SAFETY.md](ACTION-SAFETY.md). |
| `src/http.ts` | Routes, limits and headers. See [SECURITY.md](SECURITY.md). |
| `ui/src/*` | `main.tsx` (queue, arrival, add-job sheet), `card.tsx` (the decision card and its states), `mat.tsx` (the cutting-mat preview with before/after slider), `legacy.tsx` (comparison surface). |

## Data model

- **jobs**: one row per uploaded file. Holds the source bytes (never modified), `source_sha256`, intake, inspection, prediction, plan, `revision`, and status (`analysing`, `ready`, `released`, `returned`, `rejected`, `failed`).
- **proposals**: one row per prepared action. Holds kind, intent, build parameters, the artifact bytes and `artifact_sha256`, verification results, `policy_version`, `model_version`, `memory_version`, `binding_hash`, and status (`preparing`, `prepared`, `approved`, `released`, `superseded`, `failed`).
- **corrections**: the operator's intent corrections with the feature vector, scoped to the session.
- **events**: an append-only audit trail per job. Each event hashes the previous one (`sha256(canon([job, seq, at, type, data, prev]))`); the UI shows whether the chain verifies.
- **metrics**: interaction counts posted by both surfaces for the comparison.

## Request flow for one job

1. `POST /api/jobs` (raw bytes, `x-filename`, `x-intake`) or `POST /api/samples/:id`. The job row is written as `analysing`, and the response returns at once.
2. The worker inspects the file and predicts intent. Policy picks the decision. If the decision is `release` or `return`, the service immediately asks the worker to **prepare** the artifact, then **verify** it. Only a verified artifact becomes a `prepared` proposal. This is the proactive step: by the time the operator opens the card, the work is done.
3. The UI polls the job and shows real progress events.
4. The operator approves (`proposalId` + `artifactSha256`), corrects ("Not this?"), changes an option, edits intake, or rejects. Any change bumps the revision and supersedes the open proposal.
5. Approval re-verifies in the worker and writes a release ticket. Nothing is printed or sent.

## Restart behaviour

On start, `recover()` finds jobs left `analysing` and proposals left `preparing` or `approved`. It supersedes them and runs the work again, so an interrupted approval never half-completes. Sessions, jobs, artifacts and events are in the database, so a restart loses nothing. Expired sessions (48 h) are purged hourly.

## Why this shape

- **No LLM.** The job needs a calibrated, explainable decision over measured file properties. A small model trained on generated files gives exact explanations and honest abstention, costs nothing to run, and has no prompt-injection surface. See [ARCHITECTURE-DECISIONS.md](ARCHITECTURE-DECISIONS.md) D3.
- **Worker thread, not child processes.** Hostile files cost one timeout, not the server. Nothing in `src/` spawns processes; a test enforces that.
- **Artifacts in the database.** A restart or redeploy on an ephemeral disk keeps every prepared file.
