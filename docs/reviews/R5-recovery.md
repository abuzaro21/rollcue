# Codex review R5: wrong-guess recovery

- **Reviewer:** Codex CLI, model `gpt-6.1-sol` (from the run log), sandbox `read-only`, reasoning effort `high`. Session `01a1da88-c448-7140-b5fe-2031371d0883`.
- **Reviewed commit:** `a909ee7` (includes the R4 fixes from `f23555e`).
- **Brief:** [R5-recovery.prompt.md](R5-recovery.prompt.md). When RollCue guesses wrong, can the operator recover quickly, completely and safely, and does the system learn only what it should? It covers correction, session memory, honesty of the reading, other wrong guesses (size, media, overrides, contour), races, and claims in the docs.
- **Raw output:** kept locally under `docs/reviews/raw/` and not published, because the logs contain machine paths.

## Verdict (Codex, quoted)

> R5 does not pass. Ordinary intent correction is discoverable and takes two taps; thin-evidence and abstention wording are generally honest, session memory is isolated, and direct correction correctly supersedes proposals. However, memory reconciliation can release obsolete work, replacement proposals can retain previous-type choices, and several recovery paths require detours or API access. Everything built on the wrong guess is therefore **not reliably invalidated**.

Codex reproduced the findings with in-memory PGlite and regenerated dataset files. It did not run the browser tests.

## Findings and what was done

Server findings have a regression test in [`test/api-r5.test.ts`](../../test/api-r5.test.ts), named after the finding. R5-5 (media) and R5-7 have Playwright tests in `e2e/rollcue.spec.ts`. Every one of those tests failed on `a909ee7` (server tests against the old `src/`, browser tests against the old `ui/`) and passes now. Policy version bumped to `rc-policy-5`.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R5-1 | **blocker** | After a correction, other jobs were re-planned one by one, each waiting for its preparation. Meanwhile a twin job's old sticker proposal could still be approved, although memory now said poster. The same happened in reverse after **Forget**. | Approval now re-decides the job from current memory, roll and choices inside its transaction. If the card would read differently, approval is refused (`409 superseded`) and the job is re-planned at once. Reconciliation first re-decides and supersedes every affected job, then prepares the new files. A correction starts reconciliation before preparing its own job. Tests: approval is refused with a correction committed but not yet reconciled, and again after memory is cleared behind the job's back. A twin's old proposal is refused right after a correction. |
| R5-2 | major | A type change kept choices made for the old type. A memory-driven change kept everything (a 6 mm sticker border on a label). An explicit change kept the size, so a 50 mm sticker preset became a 50 mm poster. | When the effective type changes for any reason, all choices except an explicit type are dropped and logged as `options-reset`. An explicit type change also drops the size. Tests cover both cases. |
| R5-3 | major | Correcting a correction (sticker → poster → banner) left two lessons. The next identical file read **poster**, the superseded answer. | One active correction per job: a new one replaces the old. The history stays in the audit trail. Test: one `banner` lesson, and the next identical job reads banner. |
| R5-4 | major | Similarity is an average over all features, so a distinct job could be re-typed. Correcting a generated label (`label-1949`) flipped a correctly read sticker job (`sticker-2512`, 78% similar) to label at 94%, with no question. | Policy lets a correction re-type a job by itself only for near-duplicates (similarity ≥ 0.9). Below that, if memory would overturn the model's own reading, the card asks "Which job is this?", names the correction, and offers the remembered answer first. Tests: Codex's two generated files through the real service, and policy cases for near-duplicate versus distinct. The evaluation now also reports what the operator sees under this rule: 80.0% of near-variants are corrected without a question, 16.4% are asked, and no unrelated job is harmed. |
| R5-5 | major | Size, media and overrides had no way back from the card. After picking a size the chooser disappeared. After **Print anyway** the card had no options at all. Media could be set only at upload. | The card offers **Change size** after an operator-chosen size and **Do not print it soft** after **Print anyway**. Media is a control in the card header. Each one supersedes the old proposal. Tests: size and override through the API, media through the browser. |
| R5-6 | major | A traced contour could not be refused while keeping the job type. Transparent artwork always got a contour, even when the request asked for a rectangle. | An explicit rectangle now takes precedence over tracing. Contour decisions offer **Rectangle at the trim**, and rectangle decisions on transparent art offer **Trace the contour** back. Test: the rectangle is prepared, the sticker type is kept, and the old contour proposal is refused. |
| R5-7 | major | An idle tab stopped polling, so another tab's correction or **Forget** left it showing an old reading, attribution and memory count until the operator clicked something. | The open job and the session are re-read every 5 s while idle, and a response older than the revision on screen is ignored. Test: a correction in a second page reaches the first page by itself. |
| R5-8 | minor | On abstention only three types were offered, so one supported answer was unreachable without passing through a wrong one. | All four types are offered, best first. Test: the policy offers four options on abstention. |

## What this does not fix

- A correction that applies to near-duplicates by itself is still a judgment about similarity, not proof. The card flags it and names the job it came from.
- There is no "return to customer" option for a contour the operator dislikes. **Reject job** and **Rectangle at the trim** cover that case.
- Polling every 5 s is the simplest way to keep tabs in step. It is not a live push.

## Status

Totals after the fixes:
- 64/64 unit tests (9 new);
- 38/38 browser runs (2 new tests, each on desktop and mobile);
- 7/7 sample artifacts valid;
- evaluation re-run: every earlier figure is unchanged, and the two policy rows are new.

These fixes were made **after** R5 and have not been re-reviewed by Codex. The final-diff review (R7) covers them.
