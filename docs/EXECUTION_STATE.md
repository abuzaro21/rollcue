# Execution state

Single source of truth for progress. Every PASS links its evidence. A gate is PASS only when that evidence exists in this repository or in a named, reproducible command.

- **Deadline:** 2026-12-15 (official page: "Open until Dec 15, 2026"; no time or zone given; re-check before submitting).
- **Target:** release-ready by **2026-12-10**.
- **Last updated:** 2026-11-14.

## Phase

PLAN ✔ → NAME ✔ → DESIGN ✔ → IMPLEMENT ✔ → TEST ✔ (local and clean clone) → **REVIEW (in progress)** → DEPLOY → FILM → RELEASE

## Gates

| Gate | Requirement | Status | Evidence |
|---|---|---|---|
| G1 Concept and naming | Independent Claude and Codex proposals reconciled | **PASS** | [reviews/ARCH-A-claude.md](reviews/ARCH-A-claude.md), [reviews/ARCH-B-codex.md](reviews/ARCH-B-codex.md), [ARCHITECTURE-DECISIONS.md](ARCHITECTURE-DECISIONS.md) |
| G2 Genuine workflow | Real intake, analysis, decision and output | **PASS** | `scripts/validate-artifacts.ts` → [evidence/artifact-validation.json](evidence/artifact-validation.json): 7/7 samples through the real service, released and checked independently |
| G3 Non-chat | Primary operation with no conversational prompt | **PASS** | No free-text prompt in the main flow (`ui/src/main.tsx`, `ui/src/card.tsx`); e2e completes every flow by clicks ([evidence/e2e-local.log](evidence/e2e-local.log)) |
| G4 Non-dashboard | Guided by decisions, not a wall of KPIs | **PASS (pending Codex R1)** | One decision card per job ([WORKFLOW.md](WORKFLOW.md)); Codex R1 is asked to attack this |
| G5 Intent inference | Real engine, varied inputs, held-out evaluation | **PASS** | [INFERENCE-EVALUATION.md](INFERENCE-EVALUATION.md), [evidence/inference-eval.json](evidence/inference-eval.json); CI fails if results drift |
| G6 Proactive action | Useful action initiated automatically | **PASS** | Seeded and uploaded jobs are prepared and verified before the operator opens them (`api.test.ts` "first visit seeds jobs that RollCue has already prepared") |
| G7 Human review | Approval gates consequential changes | **PASS** | [ACTION-SAFETY.md](ACTION-SAFETY.md); `api.test.ts` binding, idempotency, superseded, policy-changed, binding-mismatch |
| G8 Wrong-guess recovery | Correct intent, invalidate proposals, continue safely | **PASS** | [WRONG-GUESS-RECOVERY.md](WRONG-GUESS-RECOVERY.md); e2e "wrong guess…" (desktop + mobile); `api.test.ts` |
| G9 Real artifact | Valid output for the workflow | **PASS** | Production PDFs with `Separation /CutContour`; Ghostscript 10.00 `tiffsep` yields a CutContour plate exactly where a cut was planned, 7/7 ([evidence/ci-local.log](evidence/ci-local.log)) |
| G10 Legacy comparison | Same task, genuine UI states | **PASS** | [LEGACY-COMPARISON.md](LEGACY-COMPARISON.md), [evidence/comparison.json](evidence/comparison.json), [evidence/comparison.png](evidence/comparison.png) |
| G11 Security | Uploads, sessions, artifact access protected | **PASS (pending Codex R6)** | [SECURITY.md](SECURITY.md); `api.test.ts` isolation, CSRF, bad input; `preflight.test.ts` no process/network |
| G12 Durability | Refresh and restart preserve state | **PASS (local)**; live restart open | `durability.test.ts`; e2e "refresh keeps the work…" |
| G13 Browser quality | Desktop and mobile pass | **PASS** | Playwright 22/22 (desktop 1440×900 + Pixel 7) |
| G14 Clean clone | Build, tests, audit, Docker | _see below_ | [evidence/ci-local.log](evidence/ci-local.log) |
| G15 Live demo | Core workflows on the public URL | OPEN | Needs an isolated free workspace from the owner ([DEPLOY.md](DEPLOY.md)) |
| G16 Film | ~90 s, rendered and checked | OPEN | |
| G17 Submission | Docs and submission content complete | OPEN | [SUBMISSION.md](SUBMISSION.md) |

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
| Operator correction after proposal preparation | `api.test.ts` "wrong guess: correction supersedes…", e2e "wrong guess…" |
| Approval after file changes | `api.test.ts` "approval after the job changed is refused…", "older policy or model version…" |
| Cross-session artifact access | `api.test.ts` "sessions are isolated" |
| Execution failure and retry | `api.test.ts` "an execution failure…", e2e "execution failure…" |
| Restart while approval is pending | `durability.test.ts` |
| Output file validity | `preflight.test.ts` "output validity…", `scripts/validate-artifacts.ts` (Ghostscript in CI) |
| Abstention on missing critical evidence | `preflight.test.ts` "inference abstains…" |
| No unauthorized hardware operation | `preflight.test.ts` "no hardware, network or process control…" |

## Codex reviews (gpt-6.1-sol, read-only)

| # | Scope | Status | Record |
|---|---|---|---|
| R0 | Independent architecture | done | [reviews/ARCH-B-codex.md](reviews/ARCH-B-codex.md) |
| R1 | Product concept and UX (dashboard/scripted-flow attack) | running | |
| R2 | Inference model and evaluation | open | |
| R3 | Preflight correctness | open | |
| R4 | Approval and execution | open | |
| R5 | Wrong-guess recovery | open | |
| R6 | Security | open | |
| R7 | Final release diff | open | |

## CI

- GitHub Actions workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `scripts/ci.sh`. Status: repository not created yet.
- Clean-clone local CI: `scripts/ci-local.sh` clones the committed HEAD into a fresh `node:24.13.0` Linux container with Ghostscript, runs `scripts/ci.sh`, then builds and smoke-tests the Docker image on the host.

## Owner actions

| Action | Why |
|---|---|
| Create an empty, free Render workspace named `RollCue` | Isolated hosting; the MCP cannot create workspaces, and existing workspaces belong to other projects |
| Approve making `abuzaro21/rollcue` public | Repository visibility is an account-level action |
| Watch the film; upload it to YouTube as Unlisted | Owner's account |
| Submit the DOO form | Owner's account; only the form's confirmation completes the submission |
