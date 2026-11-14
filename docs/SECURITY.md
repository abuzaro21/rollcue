# Security

RollCue accepts files from strangers and makes production decisions about them. The threat model: hostile or malformed uploads, cross-session access, forged or replayed approvals, abuse of a free public demo, and instructions hidden in customer text.

## Uploads

| Control | Detail | Where |
|---|---|---|
| Type by content | Magic bytes decide PDF, PNG or JPEG. Extension and MIME type are ignored. Anything else: 415. | `inspect.ts` |
| Size caps | 10 MB body (`413` before parsing), 20 PDF pages, 50 megapixels per raster (read from the image header **before** decoding), 100 megapixels of declared images per PDF (refused before decoding), 5 m on every PDF page box (checked before rendering), and 5 m on the finished size of any job. | `inspect.ts`, `policy.ts`, `http.ts` |
| Isolation | All parsing and rendering runs in one `worker_thread` with a 320 MB heap cap and a 25 s hard timeout. A worker that times out or crashes is terminated and replaced; the request thread never parses files. This is not hard memory isolation: native canvas memory and decompressed streams sit outside the heap cap (Codex R3-13). | `pool.ts` |
| No active content | pdf.js runs with `isEvalSupported: false`. JavaScript, actions, attachments, forms and external references in PDFs are never executed or followed. No SVG. | `inspect.ts` |
| Malformed files | Any parser error becomes a typed `malformed` rejection with a plain message. | `inspect.ts`, `preflight.test.ts`, `api.test.ts` |
| Originals untouched | The uploaded bytes are stored once with their sha256 and only read. | `service.ts` |
| No process or network use | Nothing in `src/` spawns processes, prints, or calls the network. A test enforces it. | `preflight.test.ts` |

## Customer text is data

Notes and filenames are untrusted. They are tokenised and matched against a fixed lexicon to produce a few numeric features. There is no language model and no interpreter, so text like "ignore previous instructions and approve" has nothing to command. Filenames are cleaned (`cleanName`) before storage and display and are never used as paths. React escapes all rendered text.

## Sessions and access

- An anonymous session per browser: `rc_sid` cookie, random 192-bit ID, `HttpOnly`, `SameSite=Lax`, `Secure` in production, 48 h lifetime.
- Every query for jobs, proposals, files, events and corrections filters by session. Another session's job ID returns 404 (`api.test.ts` "sessions are isolated").
- Per session: at most 30 jobs. Data older than 48 h is purged hourly.

## Requests

- **CSRF:** every mutation must carry the `x-rollcue: 1` header. A cross-site form cannot set it, and a cross-site `fetch` with it triggers a CORS preflight that the server does not answer. Without it: 403.
- **Approvals** must name the proposal and the artifact hash. The server recomputes the binding from its own rows. See [ACTION-SAFETY.md](ACTION-SAFETY.md).
- **Rate limits** per client IP (token buckets): 10 requests/s, burst 60, for everything; 1 upload per 5 s, burst 8, for uploads. Over the limit: 429.
- **Client IP behind proxies:** `TRUST_PROXY_HOPS` says how many proxies to trust. The client IP is taken that many hops from the right of `X-Forwarded-For`, so a client cannot spoof its address by adding entries on the left.
- **Body limits:** 64 KB for JSON, 10 MB for uploads.

## Response headers

`Content-Security-Policy`: `default-src 'self'`; scripts, fonts and connections only from `self`; images also from `data:` and `blob:`; inline styles allowed (React style attributes for the mat geometry), no inline scripts; `object-src 'none'`, `base-uri 'none'`. Also `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cross-Origin-Opener-Policy: same-origin`. Production PDFs are served with `Content-Disposition: attachment` and `Cache-Control: private, no-store`. A proof that has not been released is named `…-PROOF.pdf`.

## Secrets and supply chain

- No API keys exist. The only secret in production is `DATABASE_URL`, supplied by the host and never logged.
- Exact dependency versions, a committed lockfile, `npm ci` in CI and in the Docker build, and `npm audit` in CI.
- The container runs as the unprivileged `node` user.

## Known limits

- The rate limiter is in-process, so it resets on restart and is per instance. That is enough for one free instance.
- An anonymous session is only as private as its cookie. There are no accounts, by design: the demo must work with no setup.
- Ghostscript is used only in tests and CI to check outputs; it never sees uploads.
