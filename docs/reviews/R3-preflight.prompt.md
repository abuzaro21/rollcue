You are an independent, adversarial reviewer for a competition entry. You are read-only. Work only inside the current repository (RollCue). Do not read any other directory. You may run read-only commands such as `node` one-liners that read files and print results, but do not write files.

CHALLENGE: DOO Builders League, "Beyond the Chatbot". The product must do real work on a real workflow and produce a valid artifact. RollCue prepares roll-printing jobs (stickers, labels, posters, banners): it inspects the customer file, decides what production needs, and builds a production PDF with a `CutContour` spot-colour cut line where a cutter needs one. It never prints or controls hardware.

THIS REVIEW: R3, preflight correctness. Is what RollCue measures, decides and outputs actually correct for print production?

Read what you need: src/inspect.ts, src/worker.ts, src/geom.ts, src/features.ts (targetSize, effectivePpi), src/policy.ts, src/layout.ts, src/pdfout.ts, scripts/validate-artifacts.ts, test/preflight.test.ts, test/gs.ts, docs/ACTION-SAFETY.md, docs/WORKFLOW.md, samples/manifest.json.

YOUR TASKS:
1. **Measurement.** Page boxes (MediaBox, CropBox, TrimBox, BleedBox), rotation (/Rotate), user units, multi-page files, raster DPI metadata (pHYs, JFIF, EXIF) and effective PPI at the finished size. Find inputs where RollCue measures size, bleed or resolution wrongly. Cite file:line.
2. **Cut paths.** Detection of an existing `CutContour` separation: name matching, stroked vs filled, spot vs process, paths hidden in forms or patterns. Contour tracing from transparency: is the offset correct in mm, are holes and islands handled, is the path closed, is the coordinate transform from pixels to PDF points right (y-flip, box origin, rotation)? Rectangular cut: is it at trim?
3. **Policy.** Resolution thresholds per intent, scaling (e.g. a 1:10 banner), return reasons, roll-fit and layout maths (rotation, margins, utilisation, length of roll). Any decision that a print operator would call wrong or dangerous? Any check that reports pass when it did not actually check?
4. **Output PDF.** Is the production PDF valid and production-usable: the artwork embedded unchanged (vectors, fonts, colours), the page at finished size, the cut line as a stroked Separation `/CutContour` with a sensible alternate, overprint where needed, bleed preserved? Does `verifyArtifact` really verify what it claims, or does it re-check its own assumptions? Is the Ghostscript plate check in CI meaningful?
5. **Safety of parsing.** Malformed or hostile files: limits, timeouts, worker isolation, decompression bombs, huge page sizes. Is the original file ever modified?
6. Any claim in the docs that the code does not support.

FORMAT: plain markdown, at most about 1500 words. Number each finding R3-1, R3-2, … with a severity (blocker / major / minor / nit), evidence (file:line or a concrete input), and the smallest fix. For each reproducible defect, describe a concrete failing test. End with a one-paragraph verdict: would a print operator trust this output?
