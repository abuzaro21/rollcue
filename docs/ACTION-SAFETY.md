# Action safety

RollCue prepares work on its own. It never makes that work consequential on its own. This document lists the guarantees and where each is enforced and tested.

## What counts as consequential

**Releasing** a production file to the queue, **returning** a job to the customer, and **rejecting** a job. Each needs an explicit operator action. Inference, preflight, preparation and verification happen without asking, because they change nothing outside RollCue. They never touch the original upload: the source bytes are stored once with their sha256 and only ever read.

Nothing in RollCue prints, cuts, emails or calls an external service. "Release" writes a ticket to this demo's queue, and the ticket says so. A test (`test/preflight.test.ts`) fails if any file in `src/` imports process, network-printing or fetch APIs.

## States

```
job:       analysing ─► ready ─► released | returned | rejected        (failed: the file could not be read)
proposal:  preparing ─► prepared ─► approved ─► released
                │           │           └─► failed (verification at execution) ─► retry creates a new proposal
                └───────────┴─► superseded (any change to the job)
```

Inference, preparation, approval, execution and verification are separate states with separate records. A proposal is `prepared` only after its artifact has been built **and** verified.

## Guarantees

| # | Guarantee | Enforced in | Tested in |
|---|---|---|---|
| 1 | Nothing is released without an approval request that names the proposal and the sha256 of its artifact. | `Service.approve` | `api.test.ts` "approval is bound…" (wrong hash → 409 `artifact-mismatch`); "mutations need the custom header" (403) |
| 2 | The approval is bound to the job revision, source hash, parameters, the decision the operator was shown (stored with the proposal and hashed into its parameters), artifact hash, policy version, model version and memory version. The server recomputes the binding hash from its own rows. The approve button stays disabled until the production preview of that proposal has loaded. | `bindingHash`, `approve`, `#replan`; `ui/src/main.tsx` | `api.test.ts`, `durability.test.ts`, `api-r4.test.ts` R4-1; e2e R4-5 |
| 3 | Any change (intent correction, option, intake edit, retry, restart recovery) bumps the job revision and supersedes every open proposal in the same transaction. A session-wide change (roll width, memory) does the same for every open job whose displayed decision or checks change in any detail. Opening a proposal always supersedes the open ones first, and a unique index allows one open proposal per job. | `#supersede` inside `decide`, `editIntake`, `retry`, `recover`, `#replan`; `proposals_one_open` | `api.test.ts` "approval after an intake edit" → 409 `superseded`; `api-r4.test.ts` R4-1, R4-2 |
| 4 | Work started for an older revision cannot publish its result. | `#prepare` compares the revision before writing | Indirectly: `api.test.ts` wrong-guess flow and `durability.test.ts`. No test forces the race. |
| 5 | A refused approval is recorded in the audit trail. | `approve` logs `approval-refused` in its own transaction; `#event` locks the job before numbering | `api.test.ts` (the Postgres race in R4-4 is fixed by construction, not tested) |
| 6 | Approval is idempotent. A double click or a retried request executes once. An approval whose release never finished can be resumed by approving again, and a closed job cannot be approved. | `approve` returns early for `released` and for a release running in this process; row lock; `409 closed` | `api.test.ts` concurrent double approve: one `approved`, one `released` event; `api-r4.test.ts` R4-2, R4-3 |
| 7 | Execution re-verifies the stored bytes in the worker before anything is called released. A failure leaves nothing released and says so. If the final write fails, the proposal is marked failed so it can be prepared again. Errors after the release do not claim that nothing was released; the UI reloads the stored job instead. | `#execute`, `http.ts`, `ui/src/main.tsx` | `api.test.ts`, e2e "execution failure… retry recovers", `api-r4.test.ts` R4-3, R4-6; e2e R4-8 |
| 8 | If the job changed or closed while execution ran, the release is aborted. | `#execute` re-checks job status, proposal status and revision under lock | Not directly tested; the window is the length of one verification. |
| 9 | A policy or model upgrade voids prepared proposals made under the old version. | `approve` → 409 `policy-changed` | `api.test.ts` "older policy or model version…" (also a tampered stored artifact → 409 `binding-mismatch`) |
| 10 | Interrupted work after a restart is superseded and redone, never resumed half-way. | `Service.recover` | `durability.test.ts` |
| 11 | Every state change is an event in a per-job hash chain. The UI shows whether the chain verifies. | `#event`, `verifyChain` | `api.test.ts` (`chainOk`) |
| 12 | Each session sees only its own jobs, proposals, files and events. | every query filters by `session_id` | `api.test.ts` session isolation: 404 across sessions |

## The approval request

```http
POST /api/jobs/{jobId}/approve
x-rollcue: 1
cookie: rc_sid=…

{ "proposalId": "…", "artifactSha256": "…" }
```

Refusals: `404 not-found`, `409 closed`, `409 superseded`, `409 not-ready`, `409 artifact-mismatch`, `409 policy-changed`, `409 binding-mismatch`. The UI turns each into a plain sentence and reloads the current proposal.

## The release ticket

On success the proposal stores a ticket: job, file, source hash, intent and how it was decided (model, operator, memory), quantity, media, build parameters, roll layout (from the decision stored with the proposal), artifact kind and hash, approval time and approver (both as committed at approval), (a hash of the session, not a person), binding hash, versions, every verification result, and the note "RollCue does not print, cut or send anything." The `released` event stores the ticket's hash.
