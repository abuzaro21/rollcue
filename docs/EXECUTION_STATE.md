# Execution state

Single source of truth for progress. Every PASS links its evidence. A gate is PASS only when that evidence exists in this repository or in a named, reproducible command.

- **Deadline:** 2026-12-15 (official page: "Open until Dec 15, 2026"; no time or zone given; re-check before submitting).
- **Target:** release-ready by **2026-12-10**.
- **Last updated:** 2026-11-15.

## Phase

PLAN ✔ → NAME ✔ → DESIGN ✔ → IMPLEMENT ✔ → TEST ✔ (local, clean clone, GitHub Actions) → REVIEW ✔ (R0–R8) → DEPLOY ✔ → FILM ✔ (machine-verified) → RELEASE ✔ (v1.0.0). Owner: YouTube upload and DOO form.

## Gates

| Gate | Requirement | Status | Evidence |
|---|---|---|---|
| G1 Concept and naming | Independent Claude and Codex proposals reconciled | **PASS** | [reviews/ARCH-A-claude.md](reviews/ARCH-A-claude.md), [reviews/ARCH-B-codex.md](reviews/ARCH-B-codex.md), [ARCHITECTURE-DECISIONS.md](ARCHITECTURE-DECISIONS.md) |
| G2 Genuine workflow | Real intake, analysis, decision and output | **PASS** | `scripts/validate-artifacts.ts` → [evidence/artifact-validation.json](evidence/artifact-validation.json): 7/7 samples through the real service, released and checked independently (since R3: 11 verification checks for each cut job, 7 for the uncut banner, 3 for each return notice; loop count, closure, bounds, bleed box and art presence included) |
| G3 Non-chat | Primary operation with no conversational prompt | **PASS** | No free-text prompt in the main flow (`ui/src/main.tsx`, `ui/src/card.tsx`); e2e completes every flow by clicks ([evidence/e2e-local.log](evidence/e2e-local.log)) |
| G4 Non-dashboard | Guided by decisions, not a wall of KPIs | **PASS** | One decision card per job ([WORKFLOW.md](WORKFLOW.md)). Codex R1 tried to prove it a dashboard or scripted flow and concluded it is not ([reviews/R1-concept-ux.md](reviews/R1-concept-ux.md)) |
| G5 Intent inference | Real engine, varied inputs, held-out evaluation | **PASS** | [INFERENCE-EVALUATION.md](INFERENCE-EVALUATION.md), [evidence/inference-eval.json](evidence/inference-eval.json); CI fails if results drift. Codex R2 reproduced every figure and confirmed no label leakage; test-set overlap with training is now reported ([reviews/R2-inference-eval.md](reviews/R2-inference-eval.md)) |
| G6 Proactive action | Useful action initiated automatically | **PASS** | Seeded and uploaded jobs are prepared and verified before the operator opens them (`api.test.ts` "first visit seeds jobs that RollCue has already prepared") |
| G7 Human review | Approval gates consequential changes | **PASS** | [ACTION-SAFETY.md](ACTION-SAFETY.md); `api.test.ts` binding, idempotency, superseded, policy-changed, binding-mismatch; `api-r4.test.ts` exact-view binding, overlapping edits, closed jobs, stranded releases (Codex R4) |
| G8 Wrong-guess recovery | Correct intent, invalidate proposals, continue safely | **PASS** | [WRONG-GUESS-RECOVERY.md](WRONG-GUESS-RECOVERY.md); e2e "wrong guess…" (desktop + mobile); `api.test.ts`; `api-r5.test.ts` and e2e R5-5, R5-7 (Codex R5) |
| G9 Real artifact | Valid output for the workflow | **PASS** | Production PDFs with `Separation /CutContour`. `verifyArtifact` checks loop count, closure, bounds, bleed box and art presence from what the page paints (Codex R3-10). Ghostscript 10.00 `tiffsep` (in the `node:24.13.0` container) yields a CutContour plate for every artifact that has a cut and none for the others, 7/7, in the clean-clone run on `0cbfe48` ([evidence/ci-local.log](evidence/ci-local.log)); that is a colourant smoke test, not a geometry check. The earlier log was from `c40ae2e`, before R3 (Codex R7-10); local Windows runs record `ghostscript: false` because Ghostscript is not installed there. |
| G10 Legacy comparison | Same task, genuine UI states | **PASS** | [LEGACY-COMPARISON.md](LEGACY-COMPARISON.md), [evidence/comparison.json](evidence/comparison.json), [evidence/comparison.png](evidence/comparison.png). Legacy output is gated on ticket, preflight and cut (Codex R1-3), tested in e2e |
| G11 Security | Uploads, sessions, artifact access protected | **PASS** | [SECURITY.md](SECURITY.md); `api.test.ts` isolation, CSRF, bad input; `preflight.test.ts` no process/network; `api-r6.test.ts` (Codex R6: sessions, admission, storage, decompression, image budget, hooks, worker, retention); live isolation, rate-limit, header and secret checks in [DEPLOY.md](DEPLOY.md) |
| G12 Durability | Refresh and restart preserve state | **PASS** | `durability.test.ts`; e2e "refresh keeps the work…" (also run live); live: a prepared proposal survived a full redeploy and was approved afterwards ([DEPLOY.md](DEPLOY.md)) |
| G13 Browser quality | Desktop and mobile pass | **PASS** | Playwright 40/40 (desktop 1440×900 + Pixel 7) on the release build `638f83b` in the clean-clone run ([evidence/ci-local.log](evidence/ci-local.log)); live on the public URL 20 passed, 4 skipped (need test hooks) ([DEPLOY.md](DEPLOY.md)); earlier log [evidence/e2e-local.log](evidence/e2e-local.log); legacy return notice shown before approval (Codex R7-8); preview-gated approval and post-409 recovery tested (Codex R4-5, R4-8); R1 UX fixes (job-switch race, connection states, mobile approve order) are tested |
| G14 Clean clone | Build, tests, audit, Docker | **PASS** (local Docker and GitHub Actions) | Release build `638f83b`, run 2026-11-14: typecheck, 98/98 unit and integration, eval reproduces the committed results, samples byte-identical, 7/7 artifacts with Ghostscript 10.00 plates, 40/40 browser, `npm audit` 0 vulnerabilities, Docker build and smoke (4 seeded jobs prepared and verified), "ALL STAGES PASSED" in [evidence/ci-local.log](evidence/ci-local.log). GitHub Actions green on `638f83b` ([43630643378](https://github.com/abuzaro21/rollcue/actions/runs/43630643378)) |
| G15 Live demo | Core workflows on the public URL | **PASS**, with a dated database risk | <https://rollcue-a7jn.onrender.com>, isolated free `RollCue` workspace, release build `638f83b`. `scripts/live-check.ts`: 20/20 checks (HTTPS, samples, inference, proactive preparation, ambiguous intent, correction, approval, valid artifact, isolation, rate limit, no secrets), restart recovery after a redeploy, Playwright against the URL 20 passed and 4 skipped ([DEPLOY.md](DEPLOY.md)). **The free database expires 2026-12-14 16:52 UTC.** Render allows one free database per workspace, so it cannot be replaced early; the dated procedure is in [DEPLOY.md](DEPLOY.md#database-continuity) |
| G16 Film | ~90 s, rendered and checked | **PASS** (machine checks; no person has watched it) | 89.6 s, 1920×1080, 30 fps, H.264/AAC, burned-in captions and SRT, attached to release v1.0.0. All 10 automated checks pass ([FILM.md](FILM.md), [evidence/film-verification.json](evidence/film-verification.json)) |
| G17 Submission | Docs and submission content complete | **PASS** for content; submission itself is the owner's | [SUBMISSION.md](SUBMISSION.md). Not submitted until the DOO form confirms it |

## Critical regressions (directive §17)

| Case | Test |
|---|---|
| Wrong intent with high confidence | `preflight.test.ts` "wrong intent with high confidence is flagged as thin evidence…" |
| Contradictory job metadata | `preflight.test.ts` "contradictory metadata…" |
| Misleading filename | `preflight.test.ts` "misleading filename does not decide the job" |
| Unsupported file | `preflight.test.ts` "unsupported and malformed files…", `api.test.ts` "bad input…", e2e "unsupported upload…" |
| Malformed PDF | `preflight.test.ts`, `api.test.ts` "a broken PDF fails cleanly inside the worker" |
| Unexpected page dimensions | `preflight.test.ts` "unexpected page dimensions…" |
| Missing bleed | `preflight.test.ts` "missing bleed is a warning…" |
| Wrong cut path | `preflight.test.ts` "wrong cut paths are returned…" |
| Duplicate submission | `api.test.ts` "duplicate submission…" |
| Operator correction after proposal preparation | `api.test.ts` "wrong guess: correction supersedes…", e2e "wrong guess…", `api-r5.test.ts` R5-1, R5-2 |
| Approval after file changes | `api.test.ts` "approval after the job changed is refused…", "older policy or model version…" |
| Cross-session artifact access | `api.test.ts` "sessions are isolated" |
| Execution failure and retry | `api.test.ts` "an execution failure…", e2e "execution failure…", `api-r4.test.ts` R4-3 (failed final write, resume) |
| Restart while approval is pending | `durability.test.ts` |
| Output file validity | `preflight.test.ts` "output validity…", `scripts/validate-artifacts.ts` (Ghostscript in CI) |
| Abstention on missing critical evidence | `preflight.test.ts` "inference abstains…" |
| No unauthorized hardware operation | `preflight.test.ts` "no hardware, network or process control…" |

## Codex reviews (gpt-6.1-sol, read-only)

| # | Scope | Status | Record |
|---|---|---|---|
| R0 | Independent architecture | done | [reviews/ARCH-B-codex.md](reviews/ARCH-B-codex.md) |
| R1 | Product concept and UX (dashboard/scripted-flow attack) | done: 12 findings (6 major), all fixed with tests except doc-only R1-12 and screenshot-checked R1-1; fixes not re-reviewed until R7 | [reviews/R1-concept-ux.md](reviews/R1-concept-ux.md) |
| R2 | Inference model and evaluation | done: 10 findings (4 major), all fixed; aspect-ratio feature bug fixed, dataset rebuilt, model retrained, every figure regenerated; fixes not re-reviewed until R7 | [reviews/R2-inference-eval.md](reviews/R2-inference-eval.md) |
| R3 | Preflight correctness | done: 14 findings (2 blockers, 11 major), all fixed with a regression test each; cut detection now follows executed content, verification counts real loops and checks bounds and art; unsupported inputs refused or returned; fixes not re-reviewed until R7 | [reviews/R3-preflight.md](reviews/R3-preflight.md) |
| R4 | Approval and execution | done: 8 findings (1 blocker, 2 major), all fixed; the decision shown is stored with and bound to its proposal, one open proposal per job, closed jobs cannot be approved, stranded releases resume, preview must load before approval; regression tests for 7 (R4-4 is a Postgres race fixed by construction); fixes not re-reviewed until R7 | [reviews/R4-approval.md](reviews/R4-approval.md) |
| R5 | Wrong-guess recovery | done: 8 findings (1 blocker, 6 major), all fixed with tests; approval re-decides the job against current memory and roll, reconciliation invalidates before preparing, type changes drop old choices, one lesson per job, a distinct job's correction asks instead of re-typing, every choice has a way back, idle tabs refresh; `rc-policy-5`; fixes not re-reviewed until R7 | [reviews/R5-recovery.md](reviews/R5-recovery.md) |
| R6 | Security | done: 9 findings (7 major, 2 minor), all fixed; 13 regression tests; sessions only from a header-protected start, per-address and global caps, worker admission and lazy file loading, storage caps, decompression budget, signed image sizes and inline images, no test hooks in production, worker retirement, absolute 48 h retention, pinned actions and base image; fixes not re-reviewed until R7 | [reviews/R6-security.md](reviews/R6-security.md) |
| R7 | Final release diff | done: 10 findings (1 blocker, 7 major, 2 minor), all fixed or corrected in docs; 7 server regression tests, 1 browser test, 1 strengthened test; zlib headers, capacity reservation, per-colourant tint, resumed approvals re-checked, session-wide change limit, size undo on return cards, one image budget, legacy notice review, real extraction in the R2 test, evidence wording; focused re-check R7b on `c64233a`: 4 more findings (1 blocker: a literal `endstream` hid expansion; slot leak on abandoned uploads; malformed colour operands; closure reason hidden), all fixed with 3 tests; Docker smoke fixed for the session header (found by clean-clone CI); the R7b fixes were reviewed in R8 | [reviews/R7-final-diff.md](reviews/R7-final-diff.md) |
| R8 | Final review before release | done on `93a3499`: 9 findings (2 blockers, 2 major, 5 minor): nested and indirect compression, strings and arrays dropped before the operand check, limiter eviction reset, address-key gaps, a session-ceiling race, the Docker smoke's job count, the live check's CutContour test, and a wrong DEPLOY.md claim. Seven are fixed in `fbda6a6` with tests that fail on the old code (98/98), and R8-9 is fixed in the docs. R8-3 (a fail-closed false positive) is documented as a limitation; the 49-session observation is unexplained. **The R8 fixes and everything after them have not been reviewed by Codex** (listed in [SUBMISSION.md](SUBMISSION.md)) | [reviews/R8-final.md](reviews/R8-final.md) |

## CI

- GitHub Actions workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `scripts/ci.sh` with Ghostscript installed. Status: **green** on the release build `638f83b` ([43630643378](https://github.com/abuzaro21/rollcue/actions/runs/43630643378)) and earlier on `1b7b7b5` ([43619011614](https://github.com/abuzaro21/rollcue/actions/runs/43619011614)): unit tests, eval, 7/7 artifacts with Ghostscript plates, 40/40 browser runs, audit 0 vulnerabilities, Docker build and smoke. While the repository was private, GitHub refused to start runs ("recent account payments have failed or your spending limit needs to be increased"); since it was made public on 2026-11-14, runs start and pass.
- Clean-clone local CI: `scripts/ci-local.sh` clones the committed HEAD into a fresh `node:24.13.0` Linux container with Ghostscript, runs `scripts/ci.sh`, then builds and smoke-tests the Docker image on the host.

## Owner actions

| Action | Why |
|---|---|
| Watch and listen to the film | Uploaded by the owner to YouTube on 2026-11-15 (<https://youtu.be/EKGT1vQ0tRo>); whether it was watched in full is not recorded here |
| Replace the free database between 2026-12-09 and 2026-12-14 16:52 UTC ([DEPLOY.md](DEPLOY.md#database-continuity)) | Deleting the old database is irreversible and needs the owner's confirmation |
| Submit the DOO form | Owner's account; only the form's confirmation completes the submission |
