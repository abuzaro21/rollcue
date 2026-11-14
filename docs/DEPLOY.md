# Deploy

**Status: live at <https://rollcue-a7jn.onrender.com>** (Render, free plan, deployed 2026-11-14). This file records the hosting decision, the procedure and the live verification.

## Constraints

- Free resources only. No payment methods, billing changes or paid plans.
- An **isolated** workspace for RollCue. The owner's other DOO projects (KEEL, WATCHSHIFT, CAVEAT, FIRMHAND) have their own Render workspaces; none of their services, databases, environment variables or workspaces may be touched or shared.
- No authentication for sample jobs; sessions isolated; state durable across restarts; resource limits enforced.

## Hosting decision

| Option | Finding (2026-11-14) |
|---|---|
| Render, existing workspaces | Off-limits: each belongs to another project. |
| Render, new free workspace | Chosen. The owner created an empty workspace named `RollCue`; the Render MCP was pointed at it, confirmed empty (no services, no databases), and the Blueprint was applied there. |
| Other free hosts | Not needed. |

Shape (Render Blueprint, [`render.yaml`](../render.yaml)):

- **Web service** `rollcue-a7jn`: Docker runtime, free plan, `autoDeploy: false`, health check `/healthz`.
- **Postgres** `rollcue-db-a7jn`: free plan, Postgres 18, **internal connections only** (empty IP allow list; Render's default was `0.0.0.0/0`).
- Environment: `NODE_ENV=production`, `TRUST_PROXY_HOPS=3`, `DATABASE_URL` from the database. `RC_DEBUG_IP=0` is left over from a removed diagnostic and has no effect.
- `RC_TEST_HOOKS` is never set in production: the server refuses to start with it when `NODE_ENV=production` (Codex R6-6).

Free-tier behaviour to expect:

- The service sleeps after about 15 minutes idle. The first request after that takes up to a minute while it wakes. Jobs, artifacts and sessions are in Postgres, so a wake-up or restart loses nothing.
- 512 MB RAM. The worker thread's heap is capped at 320 MB, and one file is processed at a time.
- **The free database expires on 2026-12-14 16:52 UTC**, the day before the submission deadline, and judging will run after that. Before release (target 2026-12-10), a new free database must replace it: re-run the Blueprint with a renamed database, let the service pick up the new `DATABASE_URL`, re-run the live checks, and record the new expiry here. Demo sessions are kept for 48 hours anyway, so no user data is lost by the swap.

## Procedure (as run)

1. Owner created the empty `RollCue` workspace (`tea-dbs92jbm8hqs73c3j5o0`).
2. Render MCP: selected it; `list_services` and `list_postgres_instances` returned nothing.
3. `create_blueprint` from `https://github.com/abuzaro21/rollcue` (`main`, `render.yaml`, auto-sync off). The plan created exactly one free database and one free web service; approved.
4. A second Blueprint sync applied the internal-only database allow list (plan: one `UpdateDatabaseIPAllowList` action).
5. Live checks below.

## Live verification

[`scripts/live-check.ts`](../scripts/live-check.ts) runs the checks over HTTPS and prints one line per check. Run on 2026-11-14 against `1b7b7b5`:

```
node scripts/live-check.ts https://rollcue-a7jn.onrender.com checks <state-file>
node scripts/live-check.ts https://rollcue-a7jn.onrender.com resume <state-file>   # after a restart
```

| Check | Result |
|---|---|
| HTTPS, health; plain HTTP | 200 on `/healthz`; HTTP answers 301 to HTTPS |
| Page, "Try a sample job", security headers | served; `X-Frame-Options: DENY`, CSP present |
| Session start needs the `x-rollcue` header | 403 without it |
| First visit seeds sample jobs; proactive preparation | 4 jobs; `market-stickers` prepared before any operator action |
| Inference | `market-stickers` read as stickers by the model |
| Approval bound to the artifact; release | wrong hash 409 `artifact-mismatch`; correct hash 200 `released`, every verification check passing |
| Valid artifact | downloaded bytes match the approved SHA-256; pdf-lib parses one page; `Separation /CutContour` present |
| Ambiguous intent and correction | `stickers-final` flagged as thin evidence; correcting to poster re-prepares; the old proposal is superseded and approving it gives 409 `superseded` |
| Cross-session isolation | a second session gets 404 for the first session's job, artifact and approval |
| Rate limit | 150 parallel requests from one client: 62 answered 429 |
| No leaked secrets | no connection string, `DATABASE_URL`, database host, API key or private key in any response, header or the client bundle |
| Restart recovery | see below |
| Browser, live | Playwright with `E2E_BASE_URL`: 7 desktop runs (first visit, approval and PDF, wrong guess, return path, refresh, legacy gating, no overflow) and 3 mobile runs passed. Tests that need test hooks are not run live |
| No access to other projects | the `RollCue` workspace holds only `rollcue-a7jn` and `rollcue-db-a7jn` |

**Restart recovery.** A prepared `honey-labels` proposal was left pending, the service was redeployed (a full process restart), and `resume` was run with the same session (deploy `dep-dbs9ap3bc2fs73aurbp0`, live 17:08 UTC). The session, job and prepared proposal were intact, and approving it after the restart returned 200 `released`.

**Client address behind Render.** A temporary diagnostic (hashed addresses, removed in `1b7b7b5`) showed that `X-Forwarded-For` arrives as `[client, edge, proxy]`, and that the third entry from the right equals Cloudflare's `CF-Connecting-IP`. With `TRUST_PROXY_HOPS=3` the limiters key on the client; a client-supplied `X-Forwarded-For` is prepended and does not change the key. One observation is not explained: in the service's first two minutes a burst of 200 session requests created 49 sessions where the per-address budget allows 10. Two later bursts of the same shape created exactly 10, with the diagnostic showing a single stable key. The global session cap (5,000) and the worker admission limit bound the damage either way.

## Record

| Item | Value |
|---|---|
| URL | <https://rollcue-a7jn.onrender.com> |
| Workspace | `RollCue` (`tea-dbs92jbm8hqs73c3j5o0`) |
| Blueprint | `exs-dbs93cdg1s2s73ehpsng` |
| Service ID | `srv-dbs93nei0phs73cfsal0` (free, Oregon) |
| Database ID | `dpg-dbs93eei0phs73cfrn30-a` (free, Postgres 18) |
| Deployed commit | `1b7b7b5` |
| Database expires | **2026-12-14 16:52 UTC** (replace before release; see above) |
