# Workflow

What the operator sees, state by state. Every state is a real server state; the UI never invents progress.

## 1. Arrival

On a first visit the server creates a session and seeds four sample jobs. They are read and prepared in the background straight away; while that runs, the card shows each step as the server records it (usually a few seconds). While the page is connecting it says so; if the server cannot be reached it says that nothing was changed and offers **Try again**. The queue shows one chip per job, each with its status. Nothing needs setting up.

Buttons: **+ Upload** (drop a PDF, PNG or JPEG, optionally fill quantity, size, media and notes), **Try a sample job** (seven synthetic samples with a one-line story each), **Compare: the old way**.

## 2. Reading

While a job is `analysing`, the card shows the real steps as the server records them: Received, Read the file, Worked out the job, Prepared the production file. Each step shows what it found (size, cut path, transparency, intent, artifact hash). The preview mat shows the customer's artwork as soon as inspection has rendered it.

## 3. Decision

One card. From top to bottom:

- **Intent line**: "Die-cut stickers", a confidence chip (`confident`, `likely`, `thin evidence`, `set by you`, `from your correction`), and **Not this?**.
- **Headline**: the one thing that matters, for example "No cut path in the file" or "Too soft to print at this size".
- **Found / why**: one sentence each.
- **The prepared result** on the mat: the production render on white media, the magenta cut line, the cyan trim, rulers in mm. A slider compares it with the customer's original.
- **Changes and keeps**: what RollCue did to the file ("Add a CutContour line 2 mm outside the artwork, traced from its transparency.") and what it left alone.
- **Options**, when the policy offers them (for example "Cut as a rectangle", "Print anyway", "Return to customer").
- **Approve and release** (or **Approve return**), and **Reject job**. The line under the button names the file hash it approves.
- **Evidence**, collapsed: probabilities, the strongest features for and against, every check, the verification results, the file facts, and the audit trail with its chain status.

There are four kinds of decision:

| Kind | When | What the operator does |
|---|---|---|
| `release` | The job is understood and printable. RollCue has prepared the production PDF. | Approve, or pick an option, or correct the intent. |
| `return` | Something only the customer can fix: resolution, a misnamed cut path RollCue must not guess, too large for the roll. RollCue has prepared the notice. | Approve the return, or print anyway where allowed. |
| `intent` | The model abstained: the evidence does not separate two jobs. | Choose from a small visual list. |
| `size` | A raster with no physical size and no size in the order. | Choose a size. |

## 4. Receipt

After approval: a **Released** (or **Returned**) stamp, the ticket (intent, quantity, media, build, layout, versions, approval time and binding hash), the verification count ("6/6 re-verified"), and the download link for the production PDF.

## 5. When something fails

- The worker cannot read the file: the job is `failed` with the reason in plain words, and nothing is prepared.
- Preparation or release verification fails: the proposal is `failed`, nothing is released, the card says so and offers **Prepare again**.
- The operator changes something while work is running: the running work is discarded when it finishes, and the card shows the new revision.

## Mobile

At widths up to 860 px the card becomes a sheet below the mat. The approve button stays in reading order, after the headline and summary it approves. Everything is reachable by keyboard; the compare slider is a real range input.
