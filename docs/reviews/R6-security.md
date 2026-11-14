# Codex review R6: security

- **Reviewer:** Codex CLI, model `gpt-6.1-sol` (from the run log), sandbox `read-only`, reasoning effort `high`. Session `01a1da9e-e7eb-7650-be66-da5464d42329`.
- **Reviewed commit:** `140e3e1` (includes the R4 and R5 fixes).
- **Brief:** [R6-security.prompt.md](R6-security.prompt.md). Can a stranger on the internet harm the service, other visitors or the host, or make RollCue claim or do something it should not? It covers access control, request forgery and browser security, hostile files, abuse of a public demo, configuration and supply chain, integrity claims, and claims in the docs.
- **Raw output:** kept locally under `docs/reviews/raw/` and not published, because the logs contain machine paths.

## Verdict (Codex, quoted)

> Do not expose this commit as an unrestricted free demo. Session churn, unbounded queued/stored work, and decompression outside a hard memory boundary let strangers impair other visitors or repeatedly terminate the instance. Production hooks also need an explicit prohibition. Live proxy topology, Postgres behavior, Docker execution, browser tests, and current dependency advisories were not verified; those deployment and supply-chain risks remain unresolved.

Codex found **no** cross-session read, download or approval bypass, no direct XSS path, and no way around the CSRF header on POST routes. The legacy screen uses the same server gates. Its scan of 94 tracked text files and the patch history of 17 commits found no credentials. It ran 62 of the 64 existing tests; two could not create temporary directories in its sandbox.

## Findings and what was done

Each finding has a regression test in [`test/api-r6.test.ts`](../../test/api-r6.test.ts), named after the finding, except R6-9, which is configuration. All 13 tests failed on `140e3e1` (run against the old `src/`) and pass now.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R6-1 | major | A session, with four seeded sample jobs, was created **before** the route was checked. Three cookieless GETs to an unknown path made three sessions and 12 jobs, bypassing every upload limit. | Only `GET /api/session` creates a session. It needs the `x-rollcue` header (a cross-site page cannot send it without a preflight that is never answered), has its own per-address limit (10 at once, then one every 30 s), and the instance holds at most 5,000 live sessions. Any other request without a valid session gets `401` and no cookie. When the worker is backed up, a new session starts empty instead of seeded. Tests: cookieless GETs create nothing; the 11th session from one address in a row is refused. |
| R6-2 | major | No overall budget: the worker queue was unbounded, each queued task held its file, request bodies had only a per-request limit, and Node's default timeouts allowed slow clients to hold connections for minutes. | New uploads and sample jobs are refused with `503 busy` once eight tasks are running or waiting. All request bodies being received share a 48 MB budget. Queued tasks hold only the job ID; the file is read from the database when the worker is free. Headers must arrive within 15 s and a request within 60 s; at most 256 connections. Tests: a full backlog refuses new work with `503`, and a queued task reads its file only when the worker is free. |
| R6-3 | major | Storage grew without limit: **Retry** rebuilt a good proposal (four retries made five stored artifacts), superseded proposals kept their files, and events and metrics had no count limit. | **Retry** needs a failed proposal (`409 nothing-to-retry` otherwise). A superseded proposal drops its file and preview but keeps their hashes as evidence. A job takes at most 200 changes (`429`). At most 50 refused approvals are logged per job, and at most 200 client metrics per session. Tests: retry of a good proposal is refused, the old proposal's bytes are gone and its hash kept, metrics stop at 200, the 201st change is refused. |
| R6-4 | major | A 17 KB PDF expanded to a 16 MB content stream, and nothing bounded larger expansion: pdf-lib inflates without an output limit, outside the worker's heap cap. | Before any parser runs, every compressed stream in the raw file is inflated **without keeping the output**, and the totals are capped: 512 MB for image streams, 64 MB for everything else. Filters that cannot be bounded this way (LZW, RunLength, or a text encoding wrapped around Flate) are refused, both in the raw file and after loading, where filters given by reference are resolved. Tests: an 80 MB stream in a PDF under 1 MB is refused before parsing; LZW and ASCII85 around Flate are refused. |
| R6-5 | major | The PDF image budget summed signed width × height, so a negative-width decoy cancelled a 110-megapixel image. Inline images were not counted. Separately, `SECURITY.md` claimed every page box was capped at 5 m. | Each declared side must be an integer from 1 to 100,000, or the file is refused as malformed. Inline images are counted against the same 100-megapixel budget. The documentation now says what the code does: page 1's boxes are checked (up to 5.2 m including bleed and marks), and a multi-page file is never released. Tests: negative and fractional sides are refused, and an oversized inline image is refused. |
| R6-6 | major | `RC_TEST_HOOKS=1` worked in production. The hooks are process-wide, so one visitor could make another visitor's release fail. | The server refuses to start when test hooks are requested with `NODE_ENV=production`, whether they come from the environment or from code. Test: `start({ testHooks: true })` under `NODE_ENV=production` throws. |
| R6-7 | minor | After a timeout or crash, the next queued task was sent to the dying worker and failed with "Processing stopped unexpectedly". | The failed worker is retired before the next task starts, so that task gets a fresh worker. Test: a task queued behind a timed-out one succeeds. |
| R6-8 | major | Retention was by inactivity. Any request refreshed it, so an active visitor could keep stored work forever, against the documented 48 h. | Sessions now expire 48 h after **creation**, whatever the activity. An expired session is not resumed, and purge also runs at startup, before recovery. Test: a session created 49 h ago and active a moment ago gets `401`, and purge deletes its jobs. |
| R6-9 | minor | CI actions and the Docker base image were referenced by mutable tags. | Actions are pinned to commit SHAs (`v4` noted in a comment), and `node:24.13.0-slim` to its image digest. |

## What this does not fix

- **Native memory is still not hard-isolated.** Parsing runs in a worker thread with a 320 MB heap cap, but canvas buffers and typed arrays live outside it. The new budgets bound what a file can make RollCue decode. A separate process with an OS memory limit would be stronger, and is not done.
- **Indirect corners of the inflate pre-pass.** An object stream whose filter is given by reference, or wrapped in a text encoding, is decoded by pdf-lib while loading, before the post-load check sees it. pdf-lib bounds nothing there; the 10 MB upload cap and the worker timeout are what remains.
- **Rate limits are per process** and reset on restart. Behind the host's proxy they depend on `TRUST_PROXY_HOPS` being right, which is checked during live verification.
- **Client metrics are untrusted telemetry.** They are stored only for the comparison screen and are never used in a decision.
- Codex did not verify the live proxy, Postgres, the Docker image at runtime, or current dependency advisories. Those are covered by CI (`npm audit`, Docker build and smoke) and by live verification after deployment.

## Status

These fixes were made **after** R6 and have not been re-reviewed by Codex. The final-diff review (R7) covers them.
