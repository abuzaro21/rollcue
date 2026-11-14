#!/usr/bin/env bash
# Clean-clone CI without GitHub Actions: clone the committed HEAD into a fresh Linux container (same Node as
# production, ghostscript from apt), run scripts/ci.sh there, then run the Docker stage on the host.
# The log is written to docs/evidence/ci-local.log.
set -euo pipefail
cd "$(dirname "$0")/.."
log=docs/evidence/ci-local.log
{
  echo "RollCue clean-clone CI — commit $(git rev-parse HEAD) — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [ -z "$(git status --porcelain)" ] && echo "working tree clean" || echo "note: uncommitted changes exist and are NOT part of this run"
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W 2>/dev/null || pwd)/.git:/src.git:ro" node:24.13.0 bash -c '
    set -euo pipefail
    apt-get update -qq >/dev/null && apt-get install -y -qq ghostscript >/dev/null
    git config --global --add safe.directory "*"
    git clone -q /src.git /work && cd /work
    bash scripts/ci.sh'
  echo; echo "=== host stage: docker build + smoke"
  bash scripts/docker-smoke.sh
  echo; echo "=== ALL STAGES PASSED"
} 2>&1 | sed -u 's/\x1b\[[0-9;]*[A-Za-z]//g' | tee "$log"
exit "${PIPESTATUS[0]}"
