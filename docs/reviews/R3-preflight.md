# Codex review R3: preflight correctness

- **Reviewer:** Codex CLI 0.166.0, model `gpt-6.1-sol` (from the run log), sandbox `read-only`, reasoning effort `high`. Session `01a1da55-8489-7af2-82d8-ecd312f49230`.
- **Reviewed commit:** `f6d43c2`.
- **Brief:** [R3-preflight.prompt.md](R3-preflight.prompt.md). Is what RollCue measures, decides and outputs actually correct for print production? Covers page boxes, units, resolution, cut detection and tracing, policy and roll maths, the output PDF, `verifyArtifact`, hostile-file safety, and claims in the docs.
- **Raw output:** kept locally under `docs/reviews/raw/` and not published, because the logs contain machine paths.

## Verdict (Codex, quoted)

> A print operator should not yet trust RollCue's production output without independent prepress inspection. Its ordinary generated cases work, and source bytes remained unchanged in the probes, but accepted artifacts can lose artwork, misreport resolution and contain unusable cuts while verification passes.

Codex reproduced the defects with in-memory fixtures. It did not run Ghostscript, CI, a RIP, cutter hardware or memory-exhaustion tests.

## Findings and what was done

Every finding has a regression test in [`test/preflight-r3.test.ts`](../../test/preflight-r3.test.ts), named after it. All 14 tests failed on `f6d43c2` and pass now. Where full support would be a large feature (custom units, rotated JPEGs, multi-page jobs, annotations), the fix is a clear refusal or return instead of a wrong result.

| # | Severity | Finding | Fix |
|---|---|---|---|
| R3-1 | major | `/UserUnit` was ignored, so a page with `UserUnit 10` measured a tenth of its real size. | Refused at upload with a message naming the unit. |
| R3-2 | major | Effective PPI used only the image's x-axis and only the target width. A 600 × 60 px image stretched to a square read 600 ppi instead of 60, and a fill ignored the larger scale. | Both pixel axes are measured through the transform and the weaker one counts. Policy measures resolution with the actual fit (fit uses the smaller scale, fill the larger). The model's feature keeps the proportional reading; the rebuilt dataset is byte-identical, so the model and every evaluation figure are unchanged. |
| R3-3 | major | `/ImageMask` stencils were not counted, so a 16 ppi stencil passed as "vector artwork". | Stencils are measured like images. Repeated and grouped images cannot be measured, so one of them makes the page's resolution unknown instead of reporting the best of the rest. |
| R3-4 | **blocker** | Cut detection tracked colour-space resources, not painted strokes. A process-colour reset, an empty path, a zero tint and a form that is never invoked all counted as a CutContour stroke, and patterns were not followed. | A new interpreter follows only executed content: page streams, invoked forms with their own resources and matrix, and painted tiling patterns. It tracks colour, tint and path. A cut inside a pattern, shading or text is marked hidden, and policy returns the job, because a cutter does not read it there. It also counts stroked loops, open loops and page-space bounds. |
| R3-5 | **blocker** | Fill-and-crop traced the whole preview while the PDF clips to the trim. On a 35.4 mm page the contour ran from −107 to 142 mm, and verification passed. | Before tracing, the mask is cut to what the page prints (trim plus bleed). Verification now fails any cut off the page. |
| R3-6 | major | A rounded-rectangle radius above half the shorter side drew a loop outside the trim. | The radius is clamped to half the shorter side. |
| R3-7 | major | Fill clipped the art at the trim, which destroyed its bleed. Re-inspecting the output then reported the blank 15 mm margin as bleed. Policy compared unscaled source bleed with its 2 mm threshold. | Fill clips at trim + 3 mm for trimmed products. Every output declares a `BleedBox` (equal to the trim when there is no bleed). Bleed is measured at the finished size and counts only where art reaches the outer box. Crop marks start outside the bleed. |
| R3-8 | major | Printable annotations (for example a stamp) were dropped from the production file, contradicting "embedded as-is". | PDFs with printable annotations or form fields are returned, asking the customer to flatten them. |
| R3-9 | major | Roll fit used the trim, so a 1570 mm poster "fitted" 1570 mm of usable width although its crop marks did not. | Layout uses the footprint (trim plus crop marks, or plus the contour offset). Utilisation still counts the finished area. |
| R3-10 | major | `verifyArtifact` checked syntax and metadata only. A blank page passed, nine promised loops passed with none drawn, and `ARCHITECTURE.md` claimed a loop count it did not check. | Verification now counts stroked loops against the exact expected number, and requires every loop to be closed and on the page. It checks the declared bleed and that the art region actually shows the art (at least a quarter of the source's opaque coverage). The release re-check uses the same stored expectation. Ghostscript stays in CI as a colourant smoke test only. |
| R3-11 | major | EXIF orientation was ignored. The canvas preview rotated the image, but the PDF embedded raw pixels, so preview and print disagreed. EXIF-only density was ignored. | JPEGs with a non-default EXIF orientation are refused. EXIF density is read when JFIF gives none. |
| R3-12 | major | Multi-page PDFs released page 1 only, after a warning. | Multi-page PDFs are returned ("one design per file, or tell us which page") until page selection exists. |
| R3-13 | major | The worker's V8 heap limit does not bound decompressed streams or native canvas memory, so "hostile files cost one timeout" overstated the containment. | Declared PDF image pixels are budgeted (100 MP across the file) and refused before decoding. The docs now say the worker is a heap cap plus a timeout, not hard memory isolation. |
| R3-14 | minor | The 5 m cap checked only the box that sets the size, and only after rendering. A 6000 mm MediaBox with a 10 mm TrimBox passed, and so did a 12.8 m density-tagged PNG. | Every PDF page box is checked before rendering. A raster's density is metadata, not an order, so it is not refused at upload; instead policy never prepares anything over 5 m and asks for a size. |

Policy version bumped to `rc-policy-4`.

## What this does not fix

- Hard memory containment needs a separate process or container limit. The free host gives one container, and the worker is a heap cap plus a timeout.
- Ghostscript (CI only) shows that a CutContour plate exists. Geometry is checked by RollCue's own interpreter, not by a RIP. No RIP or cutter was used.
- The content interpreter is deliberately small. Anything it cannot follow is refused or marked unknown, never treated as a cut.

## Status

Totals after the fixes:
- 47/47 unit tests;
- 30/30 browser tests;
- 7/7 sample artifacts valid, each now with 11 verification checks (it was 6);
- evaluation unchanged.

These fixes were made **after** R3 and have not been re-reviewed by Codex. The final-diff review (R7) covers them.
