# Film

**File:** `rollcue-film.mp4`, 89.6 s, 1920 × 1080, 30 fps, H.264 (High) with AAC stereo audio. English captions are burned in and also published as `rollcue-film.srt`. Both are attached to [release v1.0.0](https://github.com/abuzaro21/rollcue/releases/tag/v1.0.0). Neither is in the repository, so the MP4 never enters git history.

| File | SHA-256 |
|---|---|
| `rollcue-film.mp4` | `b7e1a7ba38611f0d96b3b759b8eef92aa79bc793e1aa1ad456a5749a39c6947f` |
| `rollcue-film.srt` | `3ed42a9ba0e57a20b86b0e40370664d09efca7eed5cb9ceb658f0ff24fdaaae0` |

## What is real

- **Every product shot is a recording of the running app.** [`film/capture.ts`](../film/capture.ts) starts a fresh local RollCue server with its own empty database and no test hooks. Playwright then drives it as an operator would: real clicks on real buttons, real files, real server work. Chrome's screencast saves every painted frame with its timestamp. No interface is mocked, no screen is staged, and nothing is sped up.
- **Two things are added for viewers, and only in the film recordings.** First, a drawn pointer with a click ripple, because a headless browser has no visible cursor. Second, the app's notification toast is moved from the bottom to the top of the window, so the burned-in captions never cover it.
- **In the side-by-side scene, each pane shows a counter.** The capture script updates it after each action it performs. The counts recorded in that run were 9 clicks and 3 typed fields for the legacy flow, and 2 clicks and 0 fields for RollCue. That matches [`docs/evidence/comparison.json`](evidence/comparison.json). The legacy screen is a representative preflight workstation built for this comparison, not a real product, and the film says so on screen.
- **The PDF scene shows the production PDF that was downloaded in the approval scene.** It is rendered with pdf.js and read back with RollCue's own structural reader. The script refuses to continue unless all of these hold:
  - the downloaded bytes match the approved SHA-256;
  - the spot colour is named exactly `CutContour`;
  - the cut is stroked, not filled;
  - every cut loop is closed.
- **Sample files are synthetic.** Nothing was printed.

## Voice and captions

- **Narration** is a synthetic voice: Kokoro-82M, voice `af_heart`. It runs locally from [`film/tts.py`](../film/tts.py) with the script in [`film/narration.json`](../film/narration.json). There is no human narrator, and the end card says "synthetic voice".
- **Caption timing** comes from OpenAI Whisper (`small.en`, run locally by [`film/captions.py`](../film/captions.py)). Whisper gives word timings for each narration segment. The captions use the script's own words, placed on those timings, so a transcription slip never reaches the screen.
- **Audio** is loudness-normalised to about −16 LUFS. There is no music.

## Storyboard (as recorded)

| Time | Scene | What happens on screen |
|---|---|---|
| 0:00–0:23 | A file arrives | Four sample jobs are already prepared. **Try a sample job** adds `poster-for-jars.pdf`. RollCue reads it, and the evidence panel shows why it reads roll labels and not a poster. The card says "Prepared automatically · waiting for your approval". |
| 0:23–0:34 | Customer file and prepared proof | `olive-market-sticker.pdf`: no cut path in the file, so a contour is traced. The slider sweeps from the customer's file to the production file. |
| 0:34–0:43 | Approval | The approval line names the file hash. **Approve and release**, then the receipt shows every check re-verified, and the production PDF is downloaded. |
| 0:43–0:50 | The real output | The downloaded PDF is rendered, with its hash, page size, CutContour spot colour and closed stroked cut. |
| 0:50–1:04 | A wrong guess | `stickers-final.pdf` is read as stickers on thin evidence. **Not this?**, then **Poster**: the job is re-prepared, marked "set by you", and the file binding changes. |
| 1:04–1:11 | Remembered | A similar file arrives and is read as a poster "from your correction", in this session only. |
| 1:11–1:22 | The old way, side by side | The same sticker job runs on the legacy preflight and on RollCue at the same time, with live click and field counters. |
| 1:22–1:29.6 | End card | The RollCue mark and wordmark are traced by an animated magenta dashed cut line. Then the tagline, the repository URL, and "Synthetic sample files · synthetic voice · nothing was printed". |

## How it was checked

[`film/verify.py`](../film/verify.py) wrote `film/out/verification.json`. Every check passed:

| Check | Result |
|---|---|
| Duration | 89.6 s (2,688 frames) |
| Video | 1920 × 1080, 30/1 fps, H.264 High, yuv420p, TV range, BT.709 |
| Audio | AAC, 48 kHz, stereo; integrated loudness −16.5 LUFS |
| Full decode (`ffmpeg -f null`) | no errors |
| Captions | 36 cues, in order, none overlapping, all within the video |
| Narration | Whisper `small.en` transcribed the finished file. Word error rate against the script: 0.99%, after treating "roll" and "role" as the same word (they are homophones, and Whisper spells the product name "Role-Q") |
| Logo on the end card | 8,841 magenta pixels (the cut line and mark) and 35,773 paper-white pixels (wordmark and text) in the frame 1.2 s before the end |

**These are machine checks only.** No person has watched or listened to the film as part of them.

## Rebuilding it

```bash
python -m venv --system-site-packages film/.venv   # then: pip install kokoro soundfile openai-whisper
film/.venv/Scripts/python film/tts.py              # narration → film/tts/*.wav, durations.json
film/.venv/Scripts/python film/captions.py         # Whisper word timings → film/tts/words.json
npm run build && node film/capture.ts all          # scenes → film/capture/, screenshots → docs/screenshots/
node film/assemble.ts                              # → film/out/rollcue-film.mp4 and .srt
film/.venv/Scripts/python film/verify.py           # → film/out/verification.json
```

[`film/timeline.ts`](../film/timeline.ts) places each scene and narration segment, and both capture and assembly use it. `film/out`, `film/capture`, `film/tts` and `film/.venv` are not committed.
