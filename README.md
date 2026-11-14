# RollCue

**The next decision, not another dashboard.**

RollCue is print intake for a small roll-fed print shop. A customer's file arrives. RollCue reads it: page geometry, transparency, spot colours, effective resolution, the order details and the customer's notes. It works out what job this is (die-cut stickers, roll labels, a poster or a banner) and runs the preflight a prepress operator would run. Then it **prepares the fix**: a traced cut contour, a resized page, a corrected cut path, or a return notice to the customer. The operator sees one card: what RollCue found, the file it prepared, and one button.

Nothing happens until the operator approves. The approval is bound to the exact bytes they reviewed. If RollCue guessed the job wrong, "Not this?" fixes it in one step, the work is re-prepared, and the correction is remembered for similar files in that session.

Built for the DOO Builders League challenge "Beyond the Chatbot".

- **Live demo:** _pending deployment, see [docs/DEPLOY.md](docs/DEPLOY.md)_
- **Film (90 s):** _pending, see [docs/SUBMISSION.md](docs/SUBMISSION.md)_
- **Thesis (≤300 words):** [docs/THESIS.md](docs/THESIS.md)

## Try it in 30 seconds

Open the demo. Four sample jobs are already waiting, already read and prepared. Click **olive-market-sticker.pdf**: RollCue found no cut path, inferred die-cut stickers, traced a contour from the artwork's transparency, and prepared the production PDF. Drag the slider to compare the customer's file with the prepared one. Click **Approve and release**.

Then open **stickers-final.pdf**. The filename says stickers; the customer meant one A4 window poster. RollCue reads it as stickers but flags the evidence as thin. Click **Not this?**, choose **Poster**, and watch it re-prepare. **Try a sample job** adds more jobs, including a similar file that RollCue now reads correctly because of your correction.

**Compare: the old way** opens a representative legacy preflight workstation running the same job on the same backend.

## What makes it not a chatbot and not a dashboard

| | Chatbot | Dashboard | RollCue |
|---|---|---|---|
| Who starts the work | You type a request | You go looking | The file arriving starts it |
| What you see | A conversation | Every metric at once | One decision, with the prepared result |
| What you do | Describe, then check the answer | Navigate, filter, enter, apply | Approve, or correct in one step |
| When it is wrong | Re-prompt | You notice, or you don't | It says when evidence is thin; "Not this?" re-prepares |

## How it works

```
upload ─► inspect (worker thread, hard limits) ─► features ─► calibrated model ─► intent or abstain
                                                                    │
                    deterministic policy (size, resolution, cut, bleed, roll fit) ◄┘
                                                                    │
                    prepare: production PDF with CutContour, or return notice ─► verify ─► proposal (prepared)
                                                                    │
operator: approve (bound to sha256 of the artifact + versions) ─► re-verify ─► release ticket (nothing prints)
          or "Not this?" ─► revision + 1, old proposal superseded, correction remembered ─► prepare again
```

- **Inference:** a small multinomial logistic regression over 36 named features extracted from the real file, with temperature calibration and abstention. Explanations are the model's own per-feature contributions. No LLM, no external API. See [INTENT-INFERENCE.md](docs/INTENT-INFERENCE.md) and [INFERENCE-EVALUATION.md](docs/INFERENCE-EVALUATION.md).
- **Production rules** are deterministic and versioned. Learning never changes them.
- **Artifacts** are real PDFs: the customer's page embedded unchanged plus a `Separation /CutContour` stroke. They are re-parsed and re-rendered, and the cut strokes the page actually paints are counted and bounds-checked. In CI, Ghostscript also separates them into plates; that only confirms a CutContour plate exists.
- **Safety:** every change bumps a revision and supersedes open proposals; stale work cannot be approved; execution is idempotent and re-verified. See [ACTION-SAFETY.md](docs/ACTION-SAFETY.md).

## Run locally

Node 24.13 (native TypeScript), no other services needed (PGlite runs Postgres in-process).

```bash
npm ci
npm run build        # UI into public/
npm start            # http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm test` | Unit and integration tests (real worker, real PDFs, HTTP) |
| `npm run test:e2e` | Playwright, desktop and mobile |
| `npm run eval` | Inference evaluation into `docs/evidence/inference-eval.json` |
| `npm run validate` | Every sample through the service, released and checked independently |
| `bash scripts/ci.sh` | The whole CI pipeline |
| `bash scripts/ci-local.sh` | The same pipeline in a clean clone inside a Linux container |

Environment: `PORT`, `DATABASE_URL` (Postgres; otherwise PGlite in `RC_DATA_DIR`), `TRUST_PROXY_HOPS`, `NODE_ENV`.

## Documents

[Architecture](docs/ARCHITECTURE.md) · [Decisions](docs/ARCHITECTURE-DECISIONS.md) · [Product thesis](docs/PRODUCT-THESIS.md) · [Workflow](docs/WORKFLOW.md) · [Intent inference](docs/INTENT-INFERENCE.md) · [Evaluation](docs/INFERENCE-EVALUATION.md) · [Action safety](docs/ACTION-SAFETY.md) · [Wrong-guess recovery](docs/WRONG-GUESS-RECOVERY.md) · [Legacy comparison](docs/LEGACY-COMPARISON.md) · [Failure test](docs/FAILURE-TEST.md) · [Security](docs/SECURITY.md) · [Deploy](docs/DEPLOY.md) · [AI disclosure](docs/AI-DISCLOSURE.md) · [Submission](docs/SUBMISSION.md) · [Execution state](docs/EXECUTION_STATE.md)

## Limits, stated plainly

- Four intents only. A job whose notes or filename mention packaging, cartons or dielines is returned as out of scope unless the operator picks an intent. Other unsupported work (multi-up imposition, for example) is not detected and may be read as one of the four.
- The model is trained on synthetic files that RollCue generates and then inspects with the same code as uploads. It has not been measured on real customer files.
- "Release" writes a ticket to this demo's queue. RollCue does not print, cut, or send anything.

## License

MIT. All sample artwork is synthetic and generated by `dataset/gen.ts`.
