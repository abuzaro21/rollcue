#!/usr/bin/env bash
# Build the production image, start it, and check health, session seeding and a prepared job over HTTP.
set -euo pipefail
docker build -t rollcue:ci .
docker rm -f rc-ci >/dev/null 2>&1 || true
docker run -d --name rc-ci -p 3399:3000 rollcue:ci >/dev/null
trap 'docker logs rc-ci | tail -20; docker rm -f rc-ci >/dev/null; rm -f "${jar:-}"' EXIT
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:3399/healthz >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3399/healthz
jar=$(mktemp -p .)
curl -sf -H "x-rollcue: 1" -c "$jar" http://127.0.0.1:3399/api/session >/dev/null
for _ in $(seq 1 60); do
  n=$(curl -sf -H "x-rollcue: 1" -b "$jar" http://127.0.0.1:3399/api/jobs | grep -o "\"status\":\"ready\"" | wc -l || true)
  [ "$n" -ge 4 ] && break; sleep 1
done
echo "ready jobs: $n"; [ "$n" -ge 4 ]
curl -sf http://127.0.0.1:3399/ | grep -q '<div id="root">'
echo "docker smoke ok"
