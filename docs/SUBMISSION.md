# Submission

DOO Builders League, challenge **"Beyond the Chatbot"**: what replaces the dashboard and the chatbot in an AI-native world?

- **Deadline:** open until **2026-12-15**, per the official page (build.doo.ooo/challenges/beyond-the-chatbot). The page states no closing time or time zone, so re-check it before submitting. It was last checked on 2026-11-14.
- **Internal target:** release-ready by **2026-12-10**. Release v1.0.0 was cut on 2026-11-15.
- **The submission is complete only when the DOO form confirms it.** Two steps belong to the owner and are not done by the agents:
  - signing in to DOO and submitting the form;
  - uploading the film to YouTube as Unlisted.

  Nothing in this repository claims that either has happened.

## Form content

| Field | Content |
|---|---|
| Project name | RollCue |
| Tagline | The next decision, not another dashboard. |
| One-line description | AI-native print intake: RollCue reads each customer file, infers the job, prepares the production fix and waits for one approval. |
| Repository | <https://github.com/abuzaro21/rollcue> (public, MIT) |
| Live demo | <https://rollcue-a7jn.onrender.com>. Free hosting: the first visit after an idle spell takes up to a minute. The database terms are under Limitations. |
| Release | <https://github.com/abuzaro21/rollcue/releases/tag/v1.0.0> |
| Film | The YouTube (Unlisted) link, from the owner. The same file is attached to the release as [`rollcue-film.mp4`](https://github.com/abuzaro21/rollcue/releases/download/v1.0.0/rollcue-film.mp4), with captions in [`rollcue-film.srt`](https://github.com/abuzaro21/rollcue/releases/download/v1.0.0/rollcue-film.srt). |
| Thesis | [THESIS.md](THESIS.md) (295 words) |
| Architecture | [ARCHITECTURE.md](ARCHITECTURE.md); snapshot below |
| Failure test | [FAILURE-TEST.md](FAILURE-TEST.md) |
| AI disclosure | [AI-DISCLOSURE.md](AI-DISCLOSURE.md); summary below |

## Architecture snapshot

```
upload ─► inspect (worker thread, hard limits) ─► 36 features ─► calibrated model ─► intent or abstain
       ─► deterministic, versioned policy (size, resolution, cut, bleed, roll fit)
       ─► prepare: production PDF with a CutContour stroke, or a return notice ─► verify ─► one decision card
operator ─► approve (bound to the artifact's SHA-256 and versions) ─► re-verify ─► release ticket (nothing prints)
         └► "Not this?" ─► revision + 1, old proposal superseded, correction remembered ─► prepare again
```

- **One process (Node 24, native TypeScript)** with a worker thread for untrusted PDFs.
- **Storage:** Postgres in production; PGlite (Postgres compiled to WASM) locally and in tests.
- **Interface:** React. It shows one decision at a time, not a list of metrics.
- **Inference:** a small multinomial logistic regression with temperature calibration and abstention. No LLM and no external API at runtime.

## Wrong-guess evidence

- **Scenario.** `stickers-final.pdf` is named "stickers", but the customer meant one A4 window poster. RollCue reads it as stickers and flags the evidence as thin. **Not this?** → **Poster** re-prepares the job:
  - the revision increases;
  - the old proposal is superseded, and approving it returns 409 `superseded`;
  - the approval binding changes.

  A similar file that arrives later is read as a poster "from your correction", in that session only.
- **Where it is shown and tested.**

  | Where | What |
  |---|---|
  | Film | 0:50–1:11 |
  | Screenshots | [05-wrong-guess](screenshots/05-wrong-guess.png) and [06-corrected](screenshots/06-corrected.png) |
  | Browser tests | e2e "wrong guess…", desktop and mobile |
  | Server tests | `api.test.ts` and `api-r5.test.ts` |
  | Live check | "correction re-prepares and supersedes the old proposal" passed on the public URL |
- **Write-up:** [WRONG-GUESS-RECOVERY.md](WRONG-GUESS-RECOVERY.md).

## AI disclosure (summary)

- **Claude Code** (Claude Opus 5.5) wrote the code, tests, documents and film script.
- **OpenAI Codex CLI** (GPT-6.1 Sol, read-only) proposed an independent architecture and ran reviews R0–R8. It wrote no code.
- **Film narration** is a synthetic voice, Kokoro-82M. Caption timing and the transcript check used Whisper, run locally.
- **All sample files are synthetic.** Nothing was printed.

## YouTube (owner uploads, visibility Unlisted)

**Title** (91 characters; YouTube allows 100):

```
RollCue: The next decision, not another dashboard | DOO Builders League, Beyond the Chatbot
```

**Description:**

```
RollCue is AI-native print intake for a small roll-fed print shop. A customer's file arrives; RollCue reads it, infers what job it is (die-cut stickers, roll labels, a poster or a banner), prepares the production fix, and waits for one human approval bound to the exact file. If it guessed wrong, "Not this?" corrects it in one step and the work is re-prepared.

Not a chatbot, not a dashboard: one decision at a time.

0:00 A file arrives, already read and prepared
0:23 The customer's file and the prepared proof
0:34 Approval bound to the file, and the real production PDF
0:50 A wrong guess, corrected and remembered
1:11 The old way, side by side

Live demo: https://rollcue-a7jn.onrender.com
Code (MIT): https://github.com/abuzaro21/rollcue
Release, film and captions: https://github.com/abuzaro21/rollcue/releases/tag/v1.0.0

Every product shot is a recording of the running app. Sample files are synthetic; nothing was printed. Narration is a synthetic voice (Kokoro-82M). The legacy screen is a representative preflight workstation built for the comparison. Built with Claude Code and OpenAI Codex CLI; see docs/AI-DISCLOSURE.md.

Built for the DOO Builders League challenge "Beyond the Chatbot".
```

**Tags:**

```
RollCue, print intake, prepress, preflight, CutContour, die-cut stickers, roll labels, human in the loop, intent inference, AI-native, beyond the chatbot, DOO Builders League
```

**Captions:** upload `rollcue-film.srt` from the release as English subtitles. The film also has the same captions burned in.

**Chapters:** the timestamps in the description become chapters. Each chapter is at least 10 seconds long, as YouTube requires.

## DOO form notes

1. Re-check the challenge page for the deadline and any new required fields.
2. Upload the film to YouTube as **Unlisted**, using the text above. Paste that link into the form.
3. Use the Form content table above for the rest. If the form limits the thesis length, [THESIS.md](THESIS.md) is 295 words.
4. Open the live demo once before submitting, so the free instance is awake when judges first visit.
5. **The submission counts only when DOO shows its confirmation.** Then record the date here.

## Checklist

| Item | Status |
|---|---|
| Public repository, MIT licence, history scanned for secrets and personal data | done 2026-11-15 |
| CI green on GitHub Actions | green on the release build `638f83b` ([43630643378](https://github.com/abuzaro21/rollcue/actions/runs/43630643378)). The tag commit adds only documents and the live-check script, and its run is linked from the release notes |
| Clean-clone local CI | `638f83b`, ALL STAGES PASSED ([evidence/ci-local.log](evidence/ci-local.log)) |
| Live demo verified against the public URL | `638f83b`, 2026-11-14: 20/20 HTTP checks, restart recovery, browser 20 passed and 4 skipped ([DEPLOY.md](DEPLOY.md)) |
| Film: about 90 s, 1920×1080, 30 fps, H.264/AAC, narration, burned-in captions | done; machine-verified ([FILM.md](FILM.md)). **No person has watched or listened to it yet** |
| Release v1.0.0 with film MP4 and SRT attached | done |
| Codex reviews | R0–R8 done (nine reviews, plus the R7b re-check). The changes after R8 are listed below |
| Free database replaced for judging | **open, dated:** between 2026-12-09 and 2026-12-14 16:52 UTC ([DEPLOY.md](DEPLOY.md#database-continuity)) |
| Owner uploads film to YouTube (Unlisted) | owner |
| Owner submits the DOO form and sees the confirmation | owner |

## Changes after Codex's final review

Codex R8 reviewed `93a3499`. **None of these later commits has been reviewed by Codex**, and no Codex approval is claimed for them:

| Commit | Change |
|---|---|
| `fbda6a6` | The fixes for R8-1, R8-2, R8-4, R8-5, R8-6, R8-7 and R8-8, with regression tests (see [reviews/R8-final.md](reviews/R8-final.md)) |
| `9c67c62` | Film narration script and the local text-to-speech generator |
| `638f83b` | Film capture, assembly and verification scripts; screenshots; README and film documents |
| release commit | Documents: deploy, security, execution state, this file. `scripts/live-check.ts` now stops with a clear message when session start is rate-limited |

## Limitations, stated plainly

- **The live database is temporary.** Render's free Postgres expires 30 days after creation, and only one can exist per workspace. The current one expires **2026-12-14 16:52 UTC**. A dated replacement procedure is in [DEPLOY.md](DEPLOY.md#database-continuity). If it is not run, the demo can still run without Postgres, but then sessions do not survive restarts. Anonymous demo sessions are lost whenever the database is replaced.
- **Four intents only.** The model is trained on synthetic files and has not been measured on real customer files.
- **"Release" writes a ticket.** RollCue does not print, cut or send anything.
- **One unexplained live observation.** A cold-start burst once admitted 49 new sessions against a budget of 10, and it has not been reproduced since. See [DEPLOY.md](DEPLOY.md).
- **One known false positive.** A legitimate PDF with an uncompressed attachment that contains stream-like text can be refused and the customer asked to re-export it (R8-3). This fails closed.
