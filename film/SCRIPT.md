# RollCue film: storyboard and narration (draft)

Target 89–90 s. 1920×1080, 30 fps. Every product frame is a real capture of the running app driven by Playwright; nothing mocked or sped up beyond cuts between scenes.

| # | ~At | Scene (real capture) | Narration |
|---|---:|---|---|
| 1 | 0:00 | Black → the queue strip lands with four jobs already prepared; mat shows olive-market-sticker | Every print shop starts the day the same way. Files arrive. Someone opens each one and works out what the customer meant. |
| 2 | 0:09 | Click the old way: legacy tabs, product-type dropdown, preflight table, cut tab | Today's tools wait. You tell them the job, run the checks, choose the fix, and type it in. |
| 3 | 0:18 | Back to RollCue: the sticker card. Cut line draws itself. Slider sweeps original → production | RollCue starts the work itself. It read this file, saw transparent artwork with no cut path, inferred die-cut stickers, and traced the contour. |
| 4 | 0:31 | Hover the approve line (file hash). Click Approve. Released stamp, 6/6 re-verified, PDF downloads | Nothing is real until I approve, and my approval is bound to the exact file I reviewed. |
| 5 | 0:40 | stickers-final.pdf: "thin evidence" chip and note | Sometimes it's wrong. This one is named "stickers", but the customer wants one poster. RollCue still guesses stickers, but tells me the evidence is thin. |
| 6 | 0:51 | Not this? → Poster. Revision bumps, cut line disappears, "set by you", "Remembers 1 correction" | One tap fixes it. The old proposal is void, the poster file is prepared, and the correction is remembered. |
| 7 | 1:01 | Try a sample job → a similar file arrives → read as Poster, "from your correction" | The next similar file comes in already right, and nothing unrelated moves. |
| 8 | 1:09 | window-poster.jpg: "Too soft to print at this size", the prepared customer notice. Approve return | When only the customer can fix it, RollCue writes the note instead of printing something blurry. |
| 9 | 1:17 | Side-by-side composite: legacy 9 clicks, 3 fields; RollCue 2 clicks, 0 fields | Same job, same checks. Nine clicks and three typed decisions, or two clicks. |
| 10 | 1:24 | End card: RollCue, tagline, repo URL. Small line: "Synthetic sample files. Nothing was printed." | RollCue. The next decision, not another dashboard. |

Word count target: about 190–210 words at a calm pace.

Honesty notes for the edit:
- Scene 7 claim "nothing unrelated moves": the measured effect on unrelated jobs is 0.1%, not zero. Keep the line only if the on-screen evidence shows the other open jobs unchanged; otherwise say "and unrelated jobs stay as they were".
- Scene 9 numbers come from `docs/evidence/comparison.json` at the time of recording.
- The voice is synthetic (Kokoro-82M, local). The end card and AI-DISCLOSURE say so.
