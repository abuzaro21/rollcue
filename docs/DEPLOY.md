# Deploy

**Status: live at <https://rollcue-a7jn.onrender.com>** (Render, free plan). The release build `638f83b` was deployed on 2026-11-14 at 19:12 UTC. This file records the hosting decision, the procedure and the live verification.

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
- **The free database expires on 2026-12-14 16:52 UTC**, the day before the submission deadline, and judging will run after that. See [Database continuity](#database-continuity).

## Database continuity

Render's free Postgres terms, read from <https://render.com/docs/free> on 2026-11-14:

- A free database expires 30 days after it is created. After that it is inaccessible for a 14-day grace period, during which the only way to keep it is a paid upgrade. Then Render deletes it with its data.
- Only one free database can be active in a workspace at a time.
- Storage is fixed at 1 GB. There are no backups and no managed connection pooling.

The current database (`dpg-dbs93eei0phs73cfrn30-a`) was created on 2026-11-14 at 16:52 UTC. So:

| Date (UTC) | What happens |
|---|---|
| 2026-12-14 16:52 | It expires and becomes inaccessible. Without action, the live demo stops working: session start needs the database. |
| 2026-12-28 16:52 | Render deletes it. |

**Why it was not replaced on 2026-11-14.** A second free database cannot be created next to the active one. A replacement created that day would also have expired on 2026-12-14, so replacing it early gains nothing. A useful replacement can only be made in the last days before expiry, and it needs the active one removed first. RollCue will not use another project's workspace, and will not use a paid plan.

**Procedure, to run between 2026-12-09 and 2026-12-14 16:52 UTC**, in the `RollCue` workspace only:

1. **Keep the demo up without Postgres first.** Remove `DATABASE_URL` from the service's environment in the Render dashboard, or set it to an empty value, and deploy. The server then uses PGlite inside the container. This is the same mode the Docker smoke test runs in. Check that `/healthz` answers and that a fresh visit gets four prepared sample jobs. In this mode, data lives only in that container: a restart or the free plan's idle sleep clears all sessions.
2. **Then free the slot.** Only after step 1 is verified live, the owner confirms deleting the old database `rollcue-db-a7jn`. This is irreversible. All anonymous demo sessions stored in it are lost. They are synthetic and expire after 48 hours anyway, but anyone holding one will start again with fresh sample jobs.
3. **Create the new database.** Make one free Postgres 18 database in Oregon in the `RollCue` workspace, with internal connections only (empty IP allow list). Confirm that the plan reads `free`, and record its `expiresAt` (about 30 days after creation, so around 2027-01-08 to 2027-01-13).
4. **Validate before switching.** Wait until the database reports `available` and a read-only query against it succeeds. Only then set `DATABASE_URL` to its internal connection string and deploy. The service creates its schema on start.
5. **Re-run the full live checks.** That means `live-check.ts checks`, a redeploy, `live-check.ts resume`, and Playwright with `E2E_BASE_URL`. Then update the Record table below.

The Blueprint ([`render.yaml`](../render.yaml)) has auto-sync off, so the manual `DATABASE_URL` change is not overwritten.

**The demo database is temporary.** It is not permanent hosting, and a new one expires 30 days after creation. If nobody acts after 2026-12-14, step 1 alone keeps the demo working, without persistence across restarts.

## Procedure (as run)

1. Owner created the empty `RollCue` workspace (`tea-dbs92jbm8hqs73c3j5o0`).
2. Render MCP: selected it; `list_services` and `list_postgres_instances` returned nothing.
3. `create_blueprint` from `https://github.com/abuzaro21/rollcue` (`main`, `render.yaml`, auto-sync off). The plan created exactly one free database and one free web service; approved.
4. A second Blueprint sync applied the internal-only database allow list (plan: one `UpdateDatabaseIPAllowList` action).
5. Live checks below.

## Live verification

[`scripts/live-check.ts`](../scripts/live-check.ts) runs the checks over HTTPS and prints one line per check. Last run on 2026-11-14 against `638f83b`, the release build. The first run was against `1b7b7b5`. All 20 checks passed on both:

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
| Rate limit | 150 parallel requests from one client: 68 answered 429 (62 on `1b7b7b5`) |
| No leaked secrets | no connection string, `DATABASE_URL`, database host, API key or private key in any response, header or the client bundle |
| Restart recovery | see below |
| Browser, live | Playwright with `E2E_BASE_URL` on `638f83b`, one worker: 20 passed (10 desktop, 10 mobile), 4 skipped because they need test hooks, which production refuses. That covers job switching, unreachable server, approval and PDF, return path, upload, keyboard, refresh, legacy gating, suggested sizes, media correction and legacy return notice (on `1b7b7b5`: 7 desktop and 3 mobile) |
| No access to other projects | the `RollCue` workspace holds only `rollcue-a7jn` and `rollcue-db-a7jn` |

**Restart recovery.** On `638f83b`, `honey-labels` was left prepared and pending. The service was redeployed (deploy `dep-dbsb6sjl550s73fvv090`, live 19:16:25 UTC), and `resume` then found the session, job and proposal intact; approving returned 200 `released`. Earlier, on `1b7b7b5`, a prepared `honey-labels` proposal was left pending, the service was redeployed (a full process restart), and `resume` was run with the same session (deploy `dep-dbs9ap3bc2fs73aurbp0`, live 17:08 UTC). The session, job and prepared proposal were intact, and approving it after the restart returned 200 `released`.

**Client address behind Render.** A temporary diagnostic (hashed addresses, removed in `1b7b7b5`) showed that `X-Forwarded-For` arrives as `[client, edge, proxy]`, and that the third entry from the right equals Cloudflare's `CF-Connecting-IP`. With `TRUST_PROXY_HOPS=3` the limiters key on the client; a client-supplied `X-Forwarded-For` is prepended and does not change the key. One observation is not explained: in the service's first two minutes, a burst of 200 session requests created 49 sessions where the per-address budget allows 10. Two later bursts of the same shape created exactly 10, and the diagnostic showed a single stable key.

**Re-test on the release build.** Two bounded bursts of 20 parallel session starts were run from one client, with no diagnostics deployed, and only status codes were recorded:

| Burst | When (2026-11-14 UTC) | Admitted |
|---|---|---|
| 1 | 19:13:09, 47 s after the deploy went live | 10, and 10 answered 429 |
| 2 | 19:16:52, 27 s after a restart | 10, and 10 answered 429 |

Both match the budget. The 49-session result has not been reproduced. Its cause is unknown, and it is **not** claimed fixed. Codex R8 found the key selection correct for the observed chain. Its candidates are a second limiter instance, for example the old and new processes overlapping during a deploy, a reset, or different keys earlier on. The global session cap (5,000, now serialised, Codex R8-6) and the worker admission limit bound the cost either way. The diagnostic was removed in `4c9f350` and is not in the release build.

## Record

| Item | Value |
|---|---|
| URL | <https://rollcue-a7jn.onrender.com> |
| Workspace | `RollCue` (`tea-dbs92jbm8hqs73c3j5o0`) |
| Blueprint | `exs-dbs93cdg1s2s73ehpsng` |
| Service ID | `srv-dbs93nei0phs73cfsal0` (free, Oregon) |
| Database ID | `dpg-dbs93eei0phs73cfrn30-a` (free, Postgres 18) |
| Deployed commit | `638f83b`. Later commits change only documentation and `scripts/live-check.ts`, and the Docker image copies neither |
| Database expires | **2026-12-14 16:52 UTC**; deleted by Render 2026-12-28 unless replaced. See [Database continuity](#database-continuity) |
