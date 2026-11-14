# Codex review R4: approval and execution

- **Reviewer:** Codex CLI, model `gpt-6.1-sol` (from the run log), sandbox `read-only`, reasoning effort `high`. Session `01a1da72-87c9-79a0-b562-f867397f501e`.
- **Reviewed commit:** `d2bd398`.
- **Brief:** [R4-approval.prompt.md](R4-approval.prompt.md). Can anything consequential happen without the operator approving exactly what they saw? It covers binding, idempotency and races, execution and re-verification, what the approve control shows, the legacy surface, and claims in `ACTION-SAFETY.md` and `WORKFLOW.md`.
- **Raw output:** kept locally under `docs/reviews/raw/` and not published, because the logs contain machine paths.

## Verdict (Codex, quoted)

> R4 fails the exact-view requirement. I found no autonomous release or separate legacy bypass: legacy uses the same approval endpoint, release only persists the demo ticket, and normal hash/session gates and worker re-verification function. Nevertheless, an operator can approve displayed notice text and return different PDF content, approve an old layout and release a changed ticket, or encounter conflicting terminal outcomes.

Codex reproduced R4-1, R4-2, R4-3, R4-6 and R4-7 with in-memory PGlite and injected faults. It did not run live Postgres or a browser. R4-4 is derived from the source only.

## Findings and what was done

Server findings have a regression test in [`test/api-r4.test.ts`](../../test/api-r4.test.ts), named after the finding. UI findings have a Playwright test in `e2e/rollcue.spec.ts`, also named after the finding. Every one of those tests failed on `d2bd398` (server tests against the old `src/`, browser tests against the old `ui/`) and passes now.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R4-1 | **blocker** | A session-wide change (roll width, memory) compared only the intent, decision kind, build and check statuses. It then replaced the displayed plan but kept the proposal and its binding. A return notice could read "550 mm" on the card and "450 mm" in the PDF. A ticket could release a layout of 11 across / 3.12 m that the operator had approved as 23 across / 1.49 m. | The whole decision (text, layout, notice, options) and every check detail are now part of the comparison. Any visible difference bumps the revision and supersedes the proposal. Each proposal stores the decision it was built from, and that decision is part of its parameter hash and binding. The ticket takes its layout from the proposal, not from the job's latest plan. Tests: a roll change on a sticker job and on a banner return both refuse the old approval, and the card's decision equals the proposal's. |
| R4-2 | major | Replanning superseded old proposals only when it bumped the revision. Two edits that overlapped could leave two approvable proposals at one revision. Both could then be released, or one job could be released and then returned. Approval and execution did not check that the job was still open. | Replanning always supersedes open proposals before it opens a new one. A partial unique index allows at most one open proposal per job on both databases. Approval refuses a closed job (`409 closed`), and the final release transaction requires the job to be open. Tests: two edits queued back to back leave one open proposal and one release. Approving on a released job is refused. |
| R4-3 | major | If the final release transaction failed, the proposal stayed `approved` forever. A second approval returned without doing anything, and the UI showed "Reading" with no way out. | A failed final write is recorded as a failed proposal ("Nothing was released"), so **Prepare again** appears. If even that write fails, the proposal stays `approved`, the view reports that no release is running, and approving again resumes the release. A per-process set of running releases keeps a double click from running the release twice. Tests cover both cases. |
| R4-4 | minor | Event sequence numbers were read, then inserted, without a job lock in some transactions. On Postgres two refusals could race, and one would fail with a 500. | `#event` locks the job row before it allocates a sequence number. This is a source fix: there is no local Postgres test, and PGlite serialises transactions, so the race cannot occur there. |
| R4-5 | minor | Approve was enabled before the production preview had loaded, on both the decision card and the legacy screen. | Approve stays disabled until the preview of *that* proposal has loaded. If the preview fails, the card says so. Tests: the approve button stays disabled while the preview request is held and while it fails. |
| R4-6 | minor | Any server error became "Something went wrong. Nothing was released.", even when the release had already committed and only the read afterwards failed. The UI said the same for network errors. | The server's generic message no longer claims an outcome. After any failed action, the UI reloads the job as stored and shows that. Test: a read that fails after a release returns a 500 without the claim, and the job reads as released. |
| R4-7 | minor | The ticket used the proposal as read before approval (`approved_by` null) and stamped the execution time as the approval time. The receipt did not show media, build, layout or versions, although `WORKFLOW.md` said it did. | Approval returns the updated row, and the ticket uses its stored approver and approval time. The receipt now shows media, build, layout and versions. Test: the ticket's approver and time equal the proposal's. |
| R4-8 | minor | After a `409`, the UI installed the current job but did not restart polling. If that job was still being prepared, the card stayed on "Reading" until a reload. | The recovery fetch restarts polling when the job is still working. Test: another tab changes the job, and this tab approves the old proposal while the replacement is being prepared. The card reaches the new decision by itself. A test-only hook (`/api/test/slow-next-prepare`, on only with test hooks) holds that preparation open long enough for the test to see it. |

## What this does not fix

- The concurrency guarantees are tested on PGlite only. R4-4 is fixed by construction and has no live Postgres test. The deployment check (G15) exercises the Postgres path end to end, but not under forced races.
- "A release is running" is held in process memory. That is enough for one instance, which is what the free host runs. Several instances would need a database lease.

## Status

Totals after the fixes:
- 55/55 unit tests (8 new);
- 34/34 browser runs (2 new tests, each on desktop and mobile);
- 7/7 sample artifacts valid.

These fixes were made **after** R4 and have not been re-reviewed by Codex. The final-diff review (R7) covers them.
