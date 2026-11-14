# Failure test

What happens when things go wrong, shown by tests that make them go wrong. Each row is an automated test that runs in CI. The browser tests run on desktop and on a Pixel 7 viewport.

## The headline case: release fails at the last step

The operator approves the honey-label job, and execution fails after approval: the test hook `fail-next-release` makes the re-verification throw.

| Step | Observed | Test |
|---|---|---|
| Approve | The response comes back with the job still `ready`. No `released` event exists. The proposal is `failed`, with the error stored. | `api.test.ts` "an execution failure is reported…" |
| What the operator sees | Toast: "Release failed verification. Nothing was released." The card shows the failure and **Prepare again**. | `e2e/rollcue.spec.ts` "execution failure: nothing released, retry recovers" |
| Retry | The revision goes up, the failed proposal stays in history, and a new proposal is prepared and verified. Its artifact is **byte-identical** to the first (deterministic output), so the operator is not asked to review a different file. | both |
| Approve again | Released once. The audit chain verifies. | both |

The hook exists only when the server starts with `RC_TEST_HOOKS=1`. Production does not set it, and the endpoint returns 404 there.

## Other failures, deliberately caused

| Failure | Expected behaviour | Test |
|---|---|---|
| Server restarts with an approval pending | The prepared proposal survives and can still be approved. Its binding still verifies. | `durability.test.ts` |
| Server restarts mid-analysis | The interrupted job is superseded and analysed again from the stored original. | `durability.test.ts` |
| Approval of a proposal that was replaced | 409 `superseded`, recorded as `approval-refused`; the current proposal is shown. | `api.test.ts` "approval after the job changed…" |
| Proposal from an older policy, or stored artifact tampered | 409 `policy-changed` / `binding-mismatch`, both recorded; job stays `ready`. | `api.test.ts` "older policy or model version…" |
| Double-clicked approval, two concurrent requests | Exactly one `approved` and one `released` event. | `api.test.ts` "duplicate submission…" |
| Approval without the CSRF header | 403, nothing changes. | `api.test.ts` "mutations need the custom header" |
| A shell script upload, a file 1 byte over 10 MB, an out-of-range cut offset, a text file in the browser | 415 / 413 / 400 before any parsing; the browser shows "Only PDF, PNG and JPEG". | `api.test.ts` "bad input…", e2e "unsupported upload…" |
| A truncated, broken PDF | The worker rejects it as `malformed` with a plain message. The server keeps running. | `api.test.ts` "a broken PDF…", `preflight.test.ts` |
| Confident wrong intent | Flagged as thin evidence; one-step correction; superseded proposal can't be approved. | `preflight.test.ts`, `e2e` "wrong guess…" |
| Not enough evidence to choose | Abstains and asks with a choice. | `preflight.test.ts` "inference abstains…" |
| Oversized or rotated page, missing bleed, misnamed/filled/unneeded cut path | Refused, returned or warned. Never silently "fixed" by guessing. | `preflight.test.ts` |
| Custom UserUnit, rotated JPEG (EXIF), multi-page PDF, printable annotations, a cut hidden in a pattern or open, a stencil image, a fill that would cut off-page | Refused or returned with the reason; verification fails any cut that is open, off the page or miscounted (Codex R3) | `preflight-r3.test.ts` |
| Artwork too soft for the ordered size | A return notice is prepared instead of a blurry print. | `api.test.ts`, e2e "return path…" |
| Page reload in the middle of work | All state is on the server; the correction and memory are still there. | e2e "refresh keeps the work…" |

## Run them

```bash
npm test             # unit + integration, includes durability
npm run test:e2e     # browser, desktop + mobile
```

The live deployment is checked with the same browser suite (`E2E_BASE_URL=… npx playwright test`). There the hook-based test is skipped, since production has no test hooks. A real restart of the hosted service is checked by hand; see [DEPLOY.md](DEPLOY.md).
