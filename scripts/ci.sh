#!/usr/bin/env bash
# One CI definition, used by GitHub Actions and by the clean-clone local run (scripts/ci-local.sh).
# Expects: Node 24.13, ghostscript on PATH, Playwright Chromium installed. Docker stage runs only if docker exists.
set -euo pipefail
step() { echo; echo "=== $1 ($(date -u +%H:%M:%S))"; }

step "node $(node --version), gs $(gs --version 2>/dev/null || echo missing)"
step "install";            npm ci && npx playwright install --with-deps chromium
step "typecheck";          npm run typecheck
step "build";              npm run build
step "unit + integration"; RC_REQUIRE_GS=1 npm test
step "inference eval (must reproduce committed results)"
npm run eval
git diff --exit-code -I generatedAt -- docs/evidence/inference-eval.json
step "samples (must be byte-identical)"
npm run samples
git diff --exit-code -- samples
step "artifact validation";  RC_REQUIRE_GS=1 node --disable-warning=ExperimentalWarning scripts/validate-artifacts.ts
step "browser tests";        npx playwright test
step "audit";                npm audit --audit-level=high
if command -v docker >/dev/null; then
  step "docker build + smoke"; bash scripts/docker-smoke.sh
else
  step "docker build + smoke: SKIPPED (no docker in this environment)"
fi
step "CI PASSED"
