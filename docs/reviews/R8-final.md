# Codex review R8: final review before v1.0.0

- **Reviewer:** Codex CLI, model `gpt-6.1-sol` (from the run log), sandbox `read-only`, reasoning effort `high`. Session `01a1db41-d408-7ca1-bd5c-c050ff247d08`.
- **Reviewed range:** `c64233a..93a3499`. This range covers four things:
  - the R7b fixes;
  - the Docker smoke fix;
  - the Blueprint change (database reachable on internal connections only);
  - the live-check script and the limiter change.

  Commits whose message starts with "Temporary" were excluded. Codex confirmed that none of their diagnostic code remains in the runtime.
- **Brief:** [R8-final.prompt.md](R8-final.prompt.md).
- **Raw output:** kept locally under `docs/reviews/raw/`. It is not published, because the logs contain machine paths.

## Verdict (Codex, quoted)

> R8-1 and R8-2 block v1.0.0. Upload-slot release and rejected-card explanations are fixed; hash binding, superseding and resumed-approval checks remain intact. Blueprint internal-only intent is explicit. Docker, browser and live infrastructure checks were not rerun; the unresolved admission anomaly remains a release qualification.

Codex ran the focused tests: 24 passed. The durability test could not create temporary directories in its sandbox.

## Findings and what was done

Each fix has a regression test. All six backend tests below (R8-1, R8-2, R8-4, R8-5, R8-6 and the strengthened R7b-3) were also run against the pre-fix source. Every one of them fails there.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R8-1 | **blocker** | The decompression pre-pass measured one layer of compression. A 1,272-byte PDF with `/Filter [/FlateDecode /FlateDecode]` was counted at 81,546 bytes, but pdf-lib then decoded 83,886,080 bytes. | A stream with more than one Flate layer is refused before any parser decodes it. A filter held in another object (`/Filter 5 0 R`, or a reference inside the filter array) cannot be checked by the pre-pass, so it is refused too. Test: Codex's fixture (80 MiB of spaces, compressed twice, both spellings), the indirect form, and a one-layer control that still reads. |
| R8-2 | **blocker** | The content reader dropped strings and array delimiters before it looked at operands. With a CutContour separation, `0 SCN 1 (bad) SCN 20 20 160 160 re S` and `1 SCN 20 20 160 160 (bad) re S` were kept as valid cuts and passed every verification check. | Strings, arrays and dictionaries now count as operands. Two operator groups must have exactly their number of finite numbers: the path operators (`m l c v y re`) and `cm`, and spot colour operators (`SC SCN sc scn` in a separation or DeviceN space). Anything else refuses the file as malformed, rather than guessing what a RIP would draw. Test: five malformed forms (Codex's two, an array operand, a missing operand, an extra operand) are refused. A control with text strings and a dash array still finds the cut. R7b-3 now expects refusal too. |
| R8-3 | minor | Because each body is inflated to the end of the file (the R7b-1 fix), the pre-pass can mistake payload text for another stream. An unfiltered embedded file containing `stream` followed by compressed bytes was refused as a decompression bomb. | **Not changed.** This fails closed: such a file is refused and the customer is asked to re-export, and nothing unsafe is accepted. Print files with embedded attachments of this shape are rare. Recorded as a known limitation in [SECURITY.md](../SECURITY.md). |
| R8-4 | major | When the limiter's table was full, eviction removed buckets that had not refilled. Draining one key and then touching 10,000 others gave the drained key a fresh budget. | Only fully refilled buckets are ever removed, and the sweep runs at most once a second. While every tracked bucket is still refilling, unseen keys share one `overflow` bucket. They are never given a fresh budget, and the table never grows past its cap. Test: Codex's sequence leaves the drained key refused; unseen keys share 10 tokens; after a full refill, new keys are served normally. |
| R8-5 | minor | Address keys had gaps. Same-/64 IPv6 addresses with an embedded IPv4 tail got distinct keys. Hex-form mapped IPv4 addresses collapsed into one shared key. Malformed entries became keys of their own. | `addressKey` canonicalises every accepted form. A dotted tail becomes the last two groups; IPv4-mapped addresses in either form become the IPv4 address; zone ids are dropped. Anything that does not parse shares one `invalid` key. Test: equivalent spellings give one key; distinct mapped addresses stay distinct; garbage shares `invalid`. |
| R8-6 | major | The global session ceiling (5,000) counted and then inserted without serialisation. Two requests that both counted 4,999 produced 5,001 sessions. | Count and insert now run one at a time in the process. Render's free plan runs a single instance; several instances would need a database lock, and the code says so. Test: two overlapping requests at a simulated 4,999. One is created and the other gets 503 `busy`. Codex notes this race does not explain the 49-session observation, because the per-address check before it is synchronous. |
| R8-7 | minor | The Docker smoke counted jobs with status `ready`. A job reaches that status before preparation, so the smoke passed even when every preparation failed. | `scripts/smoke-prepared.ts` (called by `docker-smoke.sh`) requires four seeded jobs whose current proposal is `prepared` and whose verification checks all pass. It stops early when a proposal fails. |
| R8-8 | minor | `live-check.ts` looked for the substring `/CutContour` in the PDF and scanned only JSON bodies for secrets, which was less than `DEPLOY.md` claimed. | The released PDF is read with `pdfStructure`, the same reader the release gate uses. It must have a separation named exactly `CutContour`, stroked, not filled or hidden, with at least one loop and no open loops. Binary bodies are now included in the secret scan. |
| R8-9 | minor | `DEPLOY.md` said replacing the database loses no user data because sessions are kept for 48 hours. Sessions from the last 48 hours are lost when an empty replacement is connected. | `DEPLOY.md` now says that replacing the database discards every anonymous session, and why that is acceptable for this demo. |

## The 49-session observation

Codex reviewed the key selection for the observed three-entry chain and found it correct. A client-supplied prefix does not change the key, and short chains share only their fallback bucket. It could not explain the 49 admissions from the code. Its candidate mechanisms are multiple limiter instances, a reset, or different keys earlier on. It proposed one test: two bursts on one persistent instance, recording boot identity, the normalised key, the token balance and the elapsed time.

That test was already run on the deployed service before this review, as recorded in [DEPLOY.md](../DEPLOY.md):
- one instance;
- one stable key;
- three-entry chains;
- exactly 10 admissions from a cold start.

The anomaly was not reproduced. It is recorded as unexplained, not as fixed.

## Status after the R8 fixes

- R8-1, R8-2, R8-4, R8-5, R8-6, R8-7 and R8-8 are fixed with tests.
- R8-9 is fixed in the docs.
- R8-3 is accepted as a fail-closed limitation.
- Codex has not reviewed these fixes. Per the release brief, no further review loop was started.
