# Security

RollCue accepts files from strangers and makes production decisions about them. The threat model: hostile or malformed uploads, cross-session access, forged or replayed approvals, abuse of a free public demo, and instructions hidden in customer text.

## Uploads

| Control | Detail | Where |
|---|---|---|
| Type by content | Magic bytes decide PDF, PNG or JPEG. Extension and MIME type are ignored. Anything else: 415. | `inspect.ts` |
| Size caps | 10 MB body (`413` before parsing), 20 PDF pages, 50 megapixels per raster (read from the image header **before** decoding), and 100 megapixels of declared images per PDF, image objects and inline images together (Codex R7-7). Each declared image side must be an integer from 1 to 100,000. All of this is refused before decoding (Codex R6-5). Page 1's boxes are capped at 5.2 m (5 m plus room for bleed and marks) before rendering, and its finished size at 5 m. Only page 1 is inspected; a multi-page file is never released. | `inspect.ts`, `policy.ts`, `http.ts` |
| Decompression budget | Before any parser runs, every compressed stream in the raw PDF (any valid zlib header, Codex R7-1) is inflated without keeping the output. Each body is inflated from its start until zlib's own end marker, so a literal `endstream` inside the data or a `/Length` cannot hide expansion (Codex R7b-1). In total, image streams may expand to 512 MB and everything else to 64 MB. LZW, RunLength and text encodings wrapped around Flate are refused, because they cannot be bounded the same way (Codex R6-4). | `inspect.ts` (`pdfInflateBudget`) |
| Isolation | All parsing and rendering runs in one `worker_thread` with a 320 MB heap cap and a 25 s hard timeout. A worker that times out or crashes is terminated and replaced; the request thread never parses files. This is not hard memory isolation: native canvas memory and typed arrays sit outside the heap cap (Codex R3-13); the decompression budget bounds what a file can make RollCue decode. A failed worker is retired before the next task starts (Codex R6-7). | `pool.ts` |
| No active content | pdf.js runs with `isEvalSupported: false`. JavaScript, actions, attachments, forms and external references in PDFs are never executed or followed. No SVG. | `inspect.ts` |
| Malformed files | Any parser error becomes a typed `malformed` rejection with a plain message. | `inspect.ts`, `preflight.test.ts`, `api.test.ts` |
| Originals untouched | The uploaded bytes are stored once with their sha256 and only read. | `service.ts` |
| No process or network use | Nothing in `src/` spawns processes, prints, or calls the network. A test enforces it. | `preflight.test.ts` |

## Customer text is data

Notes and filenames are untrusted. They are tokenised and matched against a fixed lexicon to produce a few numeric features. There is no language model and no interpreter, so text like "ignore previous instructions and approve" has nothing to command. Filenames are cleaned (`cleanName`) before storage and display and are never used as paths. React escapes all rendered text.

## Sessions and access

- An anonymous session per browser: `rc_sid` cookie, random 192-bit ID, `HttpOnly`, `SameSite=Lax`, `Secure` in production. It lives 48 h from creation; activity does not extend it (Codex R6-8).
- Only `GET /api/session`, with the `x-rollcue` header, creates a session. Any other request without a valid session gets `401` and creates nothing (Codex R6-1).
- Every query for jobs, proposals, files, events and corrections filters by session. Another session's job ID returns 404 (`api.test.ts` "sessions are isolated").
- Per session: at most 30 jobs and 200 client metrics. Per job: at most 200 changes and 50 logged refused approvals. Changes made for the whole session (roll width, corrections) count too: a job that reaches the limit that way is closed, with nothing left approvable (Codex R7-5). **Retry** works only after a failure. A superseded proposal keeps its hashes but not its file (Codex R6-3).
- Sessions older than 48 h, with everything in them, are purged at startup and hourly.
- Client metrics are untrusted telemetry, shown only on the comparison screen and never used in a decision.

## Requests

- **CSRF:** every request from the app carries the `x-rollcue: 1` header, and every mutation and session creation requires it. A cross-site form cannot set it, and a cross-site `fetch` with it triggers a CORS preflight that the server does not answer. Without it: 403.
- **Approvals** must name the proposal and the artifact hash. The server recomputes the binding from its own rows. See [ACTION-SAFETY.md](ACTION-SAFETY.md).
- **Rate limits** per client IP (token buckets): 10 requests/s, burst 60, for everything; 1 upload per 5 s, burst 8, for uploads; 1 new session per 30 s, burst 10. Over the limit: 429. The instance holds at most 5,000 live sessions.
- **Admission:** new uploads and sample jobs are refused with `503 busy` while eight worker tasks are running, waiting or reserved. A request reserves its slot at once, before reading the body, so concurrent requests cannot all pass the check (Codex R7-2). The slot is returned if the request fails, including when the client has already left (Codex R7b-2). Seeding a new visitor's samples may use up to 16 slots, because sample files are small; past that a new visitor starts with fewer samples. Re-planning after a session-wide change is not admission-limited: it queues tasks that hold a job ID, not the file (Codex R6-2).
- **Client IP behind proxies:** `TRUST_PROXY_HOPS` says how many proxies to trust. The client IP is taken that many hops from the right of `X-Forwarded-For`, so a client cannot spoof its address by adding entries on the left.
- **Body limits:** 64 KB for JSON, 10 MB for uploads, 48 MB across all bodies being received at once. Headers must arrive within 15 s and a whole request within 60 s; at most 256 connections.
- **Test hooks** (`RC_TEST_HOOKS=1`, used by the browser tests) are process-wide, so the server refuses to start with them when `NODE_ENV=production` (Codex R6-6).

## Response headers

`Content-Security-Policy`: `default-src 'self'`; scripts, fonts and connections only from `self`; images also from `data:` and `blob:`; inline styles allowed (React style attributes for the mat geometry), no inline scripts; `object-src 'none'`, `base-uri 'none'`. Also `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cross-Origin-Opener-Policy: same-origin`. Production PDFs are served with `Content-Disposition: attachment` and `Cache-Control: private, no-store`. A proof that has not been released is named `…-PROOF.pdf`.

## Secrets and supply chain

- No API keys exist. The only secret in production is `DATABASE_URL`, supplied by the host and never logged.
- Exact dependency versions, a committed lockfile, `npm ci` in CI and in the Docker build, and `npm audit` in CI.
- The container runs as the unprivileged `node` user. Its base image is pinned by digest, and CI actions by commit SHA (Codex R6-9).

## Known limits

- The rate limiter is in-process, so it resets on restart and is per instance. That is enough for one free instance.
- An anonymous session is only as private as its cookie. There are no accounts, by design: the demo must work with no setup.
- Ghostscript is used only in tests and CI to check outputs; it never sees uploads.
- An object stream whose filter is given by reference is decoded by pdf-lib while loading, before the post-load filter check. The 10 MB upload cap and the 25 s timeout bound it, not the decompression budget.
- Reviewed by Codex in R6: [reviews/R6-security.md](reviews/R6-security.md).
