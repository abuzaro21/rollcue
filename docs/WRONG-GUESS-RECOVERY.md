# Wrong-guess recovery

RollCue will sometimes infer the wrong job. Recovery must be fast and honest. A wrong guess must never reach production unnoticed or silently undo the operator's work. It also must not happen again for the same kind of file.

## The demonstration case: `stickers-final.pdf`

A customer uploads `stickers-final.pdf` with no other instructions. The file is an A4 page with a free-form shape on a transparent background. The customer means one window poster, but nothing in the job says so, and the filename says stickers. The case is ambiguous on purpose: the filename is the strongest signal, and it is wrong.

1. **RollCue reads it as die-cut stickers**, p = 0.9999. On the hand-written test set this is the one confident wrong call ([INFERENCE-EVALUATION.md](INFERENCE-EVALUATION.md)).
2. **The card does not look certain.** The chip says **thin evidence**, not "confident". The note under it says why: most of the evidence is the filename, and the job came with almost no instructions. "Check this one before approving."
3. Because it believes stickers, RollCue has prepared a sticker job: a contour traced around the shape. The magenta cut line on the mat makes the consequence visible.
4. **One correction.** The operator taps **Not this?**. The alternatives appear with their probabilities and their own evidence. The operator taps **Poster**.
5. **In the same transaction:** the job's revision goes up. The sticker proposal is **superseded**, so it can never be approved, even by an old tab or a replayed request. Every choice made for stickers (border, fit, rectangle, a chosen size, an accepted override) is dropped, because it belonged to the wrong job type. The correction is stored, replacing any earlier correction of this job, and an `intent-corrected` event is chained into the audit trail.
6. **Re-prepared.** The poster plan is prepared and verified: no cut path, trim and crop marks. The chip now says **set by you**. The approval line names a new file hash.
7. **Remembered for this session.** The header shows "Remembers 1 correction". Every other open job is re-planned against the new memory: first all of them are re-decided and their old proposals superseded, then the new files are prepared. A job's revision changes only if something on its card changed. Until that has happened, approval re-decides the job itself and refuses anything memory no longer supports. Other tabs pick up the change within about five seconds.
8. **Carried over.** A near-identical file arriving later (from **Try a sample job**, `stickers-final.pdf` again) is read as **Poster** with the chip **from your correction**. The card names the remembered job it matched. A file that only resembles it, and that the model reads differently, is not re-typed silently: the card asks "Which job is this?", names the correction, and offers the remembered answer first.
9. **Reversible.** "Use RollCue's reading again" puts the model's reading back on this job. **Forget them** clears the session memory, and open jobs are re-planned without it.

Steps 1–8 are an end-to-end browser test: `e2e/rollcue.spec.ts` "wrong guess: flagged, corrected in one step, remembered, re-prepared", on desktop and mobile. The API-level version, including the "no collateral changes" check, is in `test/api.test.ts`.

## Why the memory does not spread

The deployed model is frozen. A correction does not change its weights. It adds a remembered example that votes only for jobs that look like it (similarity = exp(−mean squared difference of the standardised features ÷ τ), with τ = 0.08). Below a similarity of 0.05 it has no effect. At 0.9 or above, the job is a near-duplicate of one the operator already answered, and the operator's answer wins. But it is flagged "Check this one", naming the correction, because looking alike is not the same as being the same job (Codex R2-2). Below 0.9, memory may only suggest: if it would overturn the model's own reading, policy asks the operator instead (Codex R5-4). Codex found a real pair of generated files, a label and a distinct sticker job 78% similar, where one correction would otherwise have flipped a correctly read sticker job to label at 94%. Each job holds one correction at a time, so correcting a correction does not leave two competing lessons (Codex R5-3).

Measured over every wrong prediction in the held-out set:

| | Before correction | After correction |
|---|---|---|
| The corrected job | wrong | right (100%) |
| Near-variants of it (165) | 4.2% right | 96.4% right by the model with memory; under policy 80.0% applied right and 16.4% asked with the remembered answer first |
| All other jobs (20,625 correction–job pairs) | 94.9% right | 94.9% right |
| Other jobs the memory matched at all | | 31 pairs |
| Other jobs whose top intent changed | | 0 pairs |

The first design was a weight-delta adapter. It hurt unrelated jobs (98.3% → 90.3% on an earlier version of the benchmark) and was replaced. See [ARCHITECTURE-DECISIONS.md](ARCHITECTURE-DECISIONS.md) D4.

## Other wrong-guess paths

- **The model abstains.** When the evidence cannot separate two intents, the card shows "Which job is this?" with all four job types, best first, instead of preparing the wrong work.
- **A wrong option.** If the operator picks an option and then changes their mind, the same revision-and-supersede rule applies. Every choice has a way back on the card: **Change size** after picking a size, **Do not print it soft** after **Print anyway**, **Rectangle at the trim** instead of a traced contour (and **Trace the contour** back), and the media on the card header. Each change supersedes the old proposal (Codex R5-5, R5-6).
- **The operator is wrong.** A correction is an operator decision, so it is in the audit trail with the model's original reading and probability. Undoing it is one tap.
- **Legacy surface decisions** are sent with `manual: true` and are not treated as corrections. Typing a product type in a form is not a statement that the model was wrong.
