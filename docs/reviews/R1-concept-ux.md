# Codex review R1: product concept and UX

- **Reviewer:** Codex CLI 0.166.0, model `gpt-6.1-sol` (from the run log), sandbox `read-only`, reasoning effort `high`. Session `01a1d78f-62e8-7d13-8547-c58ee906b558`.
- **Reviewed commit:** `d9a96cc`, plus eight screenshots of the running app (desktop and Pixel 7).
- **Brief:** [R1-concept-ux.prompt.md](R1-concept-ux.prompt.md). Try to prove that RollCue is a dashboard, a chatbot or a hard-coded flow in disguise. Attack first impression, decision clarity, recovery and the legacy comparison.
- **Raw output:** kept locally under `docs/reviews/raw/` and not published, because the logs contain machine paths. This record gives every finding.

## Verdict (Codex, quoted)

> RollCue passes the **not a dashboard, not a chatbot, not a scripted flow** bar on the reviewed evidence. Its thesis is clear and substantially implemented: infer from files and intake, prepare an artifact, then request approval. The largest judging risks are mobile review hierarchy, misleading recovery behavior, and an overstated legacy benchmark.

Codex also checked for sample-id special cases in the inference and policy code and found none.

## Findings and what was done

Each fix has a test that failed on the reviewed code and passes now, unless the row says otherwise.

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| R1-1 | major | On mobile, the sticky approve bar appeared before the headline and summary it approves. | The approve button is no longer sticky on small screens. It stays in reading order, after the headline, summary and changes. | Checked by screenshot (Pixel 7). There is no automated layout assertion. |
| R1-2 | major | After switching jobs, the previous job's card stayed visible and actionable until the new one loaded. A late response for the old job could also replace the new one. | The card renders only when the loaded job is the selected job. Otherwise it shows "Opening the job…" with no actions. Responses for any other job are discarded. | e2e "switching jobs never leaves the previous job actionable" |
| R1-3 | major | The legacy surface let an operator open Output and approve RollCue's prepared file without doing any manual step, so the comparison did not measure the shortest path the tool allows. | Legacy output is gated: the ticket must be saved, preflight run and a cut method applied. "Keep" or "none" is accepted only when it matches the prepared output. The wrong-guess comparison changed from 7 clicks / 1 field / 4 screens to 9 / 2 / 5. The clean job is unchanged (9 / 3 / 5). The comparison docs now say the step order has not been validated by a practising print operator. | e2e "legacy will not output until ticket, preflight and cut are done" |
| R1-4 | major | A suggested size option was shown as already applied and could not be clicked. | An option is shown as active only when its parameters are actually set. | e2e "a suggested size is a choice, not a setting already applied" |
| R1-5 | major | "Use RollCue's reading again" cleared the override but kept the correction in session memory, so the job stayed in the corrected reading. | Withdrawing an override also deletes that job's correction from memory and records a `correction-withdrawn` event. | `api.test.ts` "Use RollCue's reading again withdraws the correction…" |
| R1-6 | major | The docs promised abstention on unsupported work, but packaging jobs were read as one of the four intents. | A policy scope guard returns jobs whose notes or filename mention packaging, cartons or dielines as out of scope, unless the operator picks an intent. The README limits now say other unsupported work is not detected. | `preflight.test.ts` "unsupported work (packaging, dielines) is stopped by policy…" |
| R1-7 | minor | The first screen did not make clear that the work was already done and waiting for approval, or that nothing would print. | Added a "Prepared automatically · waiting for your approval" line, a "sample job" tag, and a note under the approve button: the release goes to the demo queue and nothing is printed, cut or sent. | e2e "first visit…" asserts the line and the tag. |
| R1-8 | minor | After a correction, the evidence panel's probabilities included the memory pull, which looks like independent confirmation. | The prediction now carries `modelProbs` (the frozen model alone). The panel shows those and states separately what the corrections add. | `preflight.test.ts` memory test asserts both the model-only and the memory-adjusted figures. |
| R1-9 | minor | The recovery demo depends on knowing the job is a poster, which nothing on screen says. | Samples can carry a demo-only context line, shown as "Demo context, not seen by RollCue" and never passed to inference. A second "similar file" sample was tried and dropped: below the near-duplicate threshold, the bounded memory boost does not overturn a very confident model, and that is intended. Transfer to near variants is measured in the evaluation instead (3.8% → 96.8%). | e2e "wrong guess…" asserts the context line. |
| R1-10 | minor | When the server could not be reached, the screen looked like an empty state, with only a toast. | Separate states for connecting and unreachable. The unreachable state says nothing was changed and offers **Try again**. | e2e "server unreachable: says so, changes nothing, and retries" |
| R1-11 | minor | "Every check passes" could appear next to a check whose result was unknown. | Unknown checks are listed as "Not confirmed: …" warnings, and the summary says how many could not be confirmed. | `preflight.test.ts` "an unresolved check is never reported as every check passes" |
| R1-12 | minor | Docs called the memory similarity "cosine". WORKFLOW said unreadable jobs are "rejected" and that samples are ready by page load. | Docs now give the real formula, exp(−mean squared difference of the standardised features ÷ τ). WORKFLOW now says `failed` and that preparation runs in the background with visible progress. | Documentation only. |

## Found while fixing (not from Codex)

- **Clean-clone start crashed:** on a fresh checkout with no `data/` folder, `npm start` failed with `ENOENT … mkdir 'data/pglite'` because PGlite does not create parent folders. `src/db.ts` now creates the folder first, and `durability.test.ts` starts from a path whose parents do not exist. It failed before the fix and passes now.

## Status

All twelve findings are addressed. These fixes were made **after** R1 and have not been re-reviewed by Codex. The final-diff review (R7) covers them.
