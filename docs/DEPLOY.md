# Deploy

**Status: not deployed yet.** This file records the hosting decision, the procedure and, once deployed, the live verification.

## Constraints

- Free resources only. No payment methods, billing changes or paid plans.
- An **isolated** workspace for RollCue. The owner's other DOO projects (KEEL, WATCHSHIFT, CAVEAT, FIRMHAND) have their own Render workspaces; none of their services, databases, environment variables or workspaces may be touched or shared.
- No authentication for sample jobs; sessions isolated; state durable across restarts; resource limits enforced.

## Hosting decision

| Option | Finding (2026-11-14) |
|---|---|
| Render, existing workspaces | Off-limits: each belongs to another project. |
| Render, new free workspace | Preferred. The Render MCP cannot create workspaces; the owner creates one in the dashboard (no payment method), then the MCP or a Blueprint deploys into it. |
| Other free hosts | Only if Render is not possible, and only with the owner's approval. |

Target shape (Render Blueprint, [`render.yaml`](../render.yaml)):

- **Web service** `rollcue`: Docker runtime, free plan, `autoDeploy: false`, health check `/healthz`.
- **Postgres** `rollcue-db`: free plan. Render's free Postgres **expires 30 days after creation**. Created on or after 2026-11-15, it outlives the 2026-12-15 deadline.
- Environment: `NODE_ENV=production`, `TRUST_PROXY_HOPS=3` (Render's edge adds the client plus two proxy hops to `X-Forwarded-For`), `DATABASE_URL` from the database.

Free-tier behaviour to expect and state honestly:

- The service sleeps after about 15 minutes idle. The first request after that takes up to a minute while it wakes. Jobs, artifacts and sessions are in Postgres, so a wake-up or restart loses nothing.
- 512 MB RAM. The worker thread's heap is capped at 320 MB, and one file is processed at a time.

## Procedure

1. The owner creates an empty Render workspace named `RollCue`.
2. Select that workspace in the Render MCP and confirm it contains no services.
3. Plan and apply the Blueprint from the public repo (`main`, `render.yaml`).
4. Wait for the deploy to go live. Record the service ID, database ID, deploy commit and database expiry date here.
5. Run the live checks below.

## Live verification

_To be filled in from real runs against the public URL._

| Check | How | Result |
|---|---|---|
| HTTPS, health | `curl -sI https://…/healthz` | |
| Sample jobs load, inference, proactive preparation | Playwright suite with `E2E_BASE_URL` | |
| Ambiguous intent, correction, approval, valid artifact | same; downloaded PDF checked | |
| Restart recovery | Restart the service with a prepared job pending; approve it afterwards | |
| Cross-user isolation | Second session gets 404 for the first session's job and files | |
| Rate limits | Burst beyond the limit returns 429 from one client IP | |
| No leaked secrets | Responses, headers and the client bundle contain no `DATABASE_URL` or keys | |
| No access to other projects | Workspace contains only RollCue's service and database | |

## Record

| Item | Value |
|---|---|
| URL | |
| Workspace | |
| Service ID | |
| Database ID | |
| Deployed commit | |
| Database expires | |
