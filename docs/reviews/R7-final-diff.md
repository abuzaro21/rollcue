# Codex review R7: final diff

- **Reviewer:** Codex CLI, model `gpt-6.1-sol` (from the run log), sandbox `read-only`, reasoning effort `high`. Session `01a1dabd-ec81-7e30-9585-03f87c88ce61`.
- **Reviewed range:** `d9a96cc..2ca15c5`, which covers every fix commit from R1 to R6.
- **Brief:** [R7-final-diff.prompt.md](R7-final-diff.prompt.md). It asked whether the fixes are real and complete, whether they broke anything else, whether RollCue is a dashboard or a hardcoded flow in disguise, whether the claims in the docs hold, and what still blocks a public demo.
- **Raw output:** kept locally under `docs/reviews/raw/` and not published, because the logs contain machine paths.

## Verdict (Codex, quoted)

> The R1–R6 fixes contain substantial, real repairs, but they are not collectively sound enough for **v1.0.0 or an unrestricted public demo**. Inference is learned and preparation computes real artifacts; I found no sample-ID scripting mechanism. The legacy comparison remains a disclosed, team-built simulation rather than independent productivity evidence. Browser reruns, live Postgres/proxy behavior, Docker and current dependency advisories were not checked; the reproduced resource-limit and stale-release failures remain release risks.

Codex ran typecheck and the unit tests (75 passed; two could not create temporary directories in its sandbox) and reproduced the inference evaluation exactly. It loaded earlier source snapshots and confirmed that the backend regression tests fail without their fixes, with the exception of R7-9.

## Findings and what was done

Server findings have a regression test in [`test/api-r7.test.ts`](../../test/api-r7.test.ts), named after the finding. R7-8 has a Playwright test in `e2e/rollcue.spec.ts`. All 7 server tests failed on `2ca15c5` (run against its `src/`), the browser test failed against the old `ui/`, and all pass now.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R7-1 | **blocker** | The R6 decompression pre-pass only counted streams starting with byte `0x78`. A valid zlib stream with a small window (`windowBits: 9`) starts with another byte: a 67 KB PDF expanded to 65 MB unnoticed. | Every body with a valid zlib header is counted (compression method 8 and a header checksum divisible by 31). Test: an 80 MB stream with `windowBits: 9` is refused. |
| R7-2 | major | Admission checked the backlog, then awaited the body, the sample and the database. Twenty concurrent sample requests all passed while the worker was busy, and the backlog reached 20. | A request reserves a worker slot synchronously, before any await. The slot is returned when the job's analysis is queued, from which point the pool counts it, or when creation fails. Seeding reserves slots the same way. Test: with the worker held, 20 concurrent requests get at most 7 acceptances and `503` for the rest. |
| R7-3 | major | A `DeviceN [/CutContour /Varnish]` stroke painted with `0 1 SCN` counted as a CutContour, because all components were collapsed to their maximum tint. Codex released such a file with a "kept" cut, and verification agreed. This completes R3-4 and R3-10. | Tints are tracked per colourant. A colourant is painted only when its own tint is above zero. Preparation and verification share the scanner, so both are fixed. Test: `1 0` finds the cut, and `0 1` does not. |
| R7-4 | major | Resuming an approval whose release never finished skipped the hash, version, binding and current-decision checks. After a committed roll change, the old 23-across layout was released. | A resumed approval goes through the same checks as a first approval and is refused with `409 superseded` if the decision would differ now. Test: a stranded approval, then a committed roll change, then approving again is refused and nothing is released. |
| R7-5 | major | Re-planning after a session-wide change (roll, correction) bumped revisions without the R6 change limit: a job at revision 200 went to 202. | Session-wide changes count against the same limit. A job that reaches it is closed (`rejected`, with the reason in its audit trail), and its open proposals are superseded. Test: at revision 200, a roll change closes the job, the revision stays at 200, and nothing is approvable. |
| R7-6 | major | A chosen size that could not be made (3000 × 3000 mm stickers) led to a return card offering only **Return to customer**: the size could not be undone without changing the job type. | Return cards also offer **Change size** when the operator chose the size. Test: the oversized choice is undone from the return card, and the job is releasable again with the same type. |
| R7-7 | major | Inline images and image objects had separate 100-megapixel budgets, so 60 + 60 megapixels passed. | One budget: inline images get what the image objects leave. Test: a 60-megapixel object and a 60-megapixel inline image together are refused. |
| R7-8 | major | The legacy screen let the operator approve a return notice after seeing only "A return notice was generated." | The legacy output shows the notice's title, findings and request, as the decision card does, and approval needs it on screen. Browser test: the soft poster's notice text is visible before **Approve** is enabled. |
| R7-9 | minor | The R2 aspect-ratio test read cached feature vectors from `dataset/cases.json`, so it passed with the old, buggy extractor. | The test generates both files, inspects them and calls `featurize`. Checked: it fails with the `6832547` extractor ("a raster without density keeps its pixel aspect ratio") and passes with the current one. |
| R7-10 | minor | G9 was marked PASS on a Ghostscript log from `c40ae2e`, before the R3 fixes, while the local validation records `ghostscript: false`. G2 said "11 verification checks each", but the counts are 11, 7 and 3. | G9 now reads "PASS (Ghostscript evidence pending regeneration)" until the clean-clone CI log names the release commit. G2 gives the real counts: 11 for cut jobs, 7 for the uncut banner, 3 for return notices. |

## What this does not fix

- **The legacy comparison is a simulation built by the same team.** Codex calls it a disclosed simulation, not independent productivity evidence. The docs say the same.
- **Re-planning after a session-wide change is not admission-limited.** Those tasks hold a job ID, not a file, and the change limit bounds how often they can be triggered.
- Codex did not check browser runs, live Postgres, the proxy, Docker or current advisories. The browser suite was re-run here (40/40). The rest is covered by clean-clone CI and by live verification after deployment.

## R7b: focused check of the R7 fixes

A blocker had been fixed after the last scheduled review, so Codex checked those fixes once more.

- **Reviewer:** Codex CLI, model `gpt-6.1-sol` (from the run log), sandbox `read-only`, reasoning effort `high`. Session `01a1dad2-3cc2-79f0-8514-a7cb02253639`.
- **Reviewed range:** `2ca15c5..c64233a` only. Brief: [R7b-fix-check.prompt.md](R7b-fix-check.prompt.md).
- **Assessment of R7:** R7-4, R7-6, R7-7, R7-8 and R7-9 fixed. R7-10's counts were corrected, and the Ghostscript evidence was correctly marked pending. R7-1, R7-2 and R7-3 were only partly fixed, and R7-5 lacked an explanation on the card.

> The R7 repairs contain real improvements, but the decompression bypass, permanent admission leak and falsely verified cut still prevent a v1.0.0 release of this free public demo.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R7b-1 | **blocker** | The pre-pass ended each stream body at the first literal `endstream`. A valid Flate stream whose first stored block contained `%endstream` hid 80 MB of expansion; its correct `/Length` let parsers decode all of it. | Each body is inflated from its start to the end of the file, so zlib's own end marker bounds it. Neither a literal `endstream` nor a `/Length` changes what is counted. Test: Codex's fixture (stored block with `%endstream`, then 80 MB of compressed spaces) is refused. |
| R7b-2 | major | An upload whose client left while its session was being looked up never released its capacity slot: `readBody` waited for a `close` event that had already fired. Eight such requests left the service refusing all new work. | `readBody` rejects at once when the request is already destroyed or aborted, and the slot is returned. Test: eight uploads abandoned during the session lookup, then a sample job is accepted. |
| R7b-3 | major | Malformed colour operands still claimed a cut. A name operand was dropped (`0 1 /P SCN`), and a missing tint defaulted to 1 (`0 SCN` on two colourants). Through the service such a file was released with a "kept" cut. | A colour needs exactly one finite number per colourant. Anything else paints no colourant, so a malformed colour can never claim a cut. Test: both sequences find no CutContour, and a well-formed one still does. |
| R7b-4 | minor | A job closed by the change limit showed only "Rejected", hiding the stored reason and the instruction to upload again. | A closed card shows the stored reason. No browser test: reaching the limit needs database access that the browser tests do not have. The change is a single conditional line in `card.tsx`. |

Separately, the clean-clone CI run on `c64233a` (not Codex) showed that the R6 session gate had broken the Docker smoke test: its `curl` to `/api/session` had no `x-rollcue` header. That run stopped there and did not print "ALL STAGES PASSED". The smoke script now sends the header.

## Status

Totals after the R7 and R7b fixes:
- 87/87 unit tests (10 new, 1 strengthened);
- 40/40 browser runs (1 new test, on desktop and mobile);
- 7/7 sample artifacts valid;
- evaluation re-run, with every figure unchanged.

The R7b fixes were made **after** the last Codex review and **have not been reviewed by Codex**. No claim in this repository says Codex approved them.
