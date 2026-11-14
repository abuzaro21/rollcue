#!/usr/bin/env bash
# Build the production image, start it, and check health, the page, and that a new session gets four prepared, verified proposals.
set -euo pipefail
docker build -t rollcue:ci .
docker rm -f rc-ci >/dev/null 2>&1 || true
docker run -d --name rc-ci -p 3399:3000 rollcue:ci >/dev/null
trap 'docker logs rc-ci | tail -20; docker rm -f rc-ci >/dev/null' EXIT
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:3399/healthz >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3399/healthz
node --disable-warning=ExperimentalWarning scripts/smoke-prepared.ts http://127.0.0.1:3399
curl -sf http://127.0.0.1:3399/ | grep -q '<div id="root">'
echo "docker smoke ok"
