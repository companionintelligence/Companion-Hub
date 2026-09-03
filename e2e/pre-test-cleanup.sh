#!/usr/bin/env bash
# e2e/pre-test-cleanup.sh — Clean stale E2E processes before Playwright starts.
#
# Playwright webServers start BEFORE globalSetup, and reuseExistingServer
# skips startup scripts when ports are already bound. This script runs
# before Playwright to kill zombies and tear down stale Docker stacks.

set -euo pipefail

SUITE="${E2E_SUITE:-standard}"
echo "[pre-test-cleanup] Cleaning up before $SUITE E2E suite..."

# Kill any process on known E2E ports (except Docker proxy)
# Only runs in CI or when explicitly opted-in to avoid killing unrelated local processes.
if [ "${CI:-}" = "true" ] || [ "${E2E_CLEANUP_PORTS:-}" = "true" ]; then
  if command -v lsof >/dev/null 2>&1; then
    for port in 3000 4444 5173 8012 9091 6543 5672 8880 8881 8843; do
      pids=$(lsof -ti :$port 2>/dev/null || true)
      for pid in $pids; do
        [ -z "$pid" ] && continue
        # Skip Docker proxy processes (works on both Linux and macOS)
        procname=$(ps -p "$pid" -o comm= 2>/dev/null || true)
        if echo "$procname" | grep -q docker-proxy; then continue; fi
        echo "[pre-test-cleanup] Killing stale process on port $port (pid $pid)"
        kill "$pid" 2>/dev/null || true
      done
    done
    sleep 1
  fi
else
  echo "[pre-test-cleanup] Skipping port cleanup (set CI=true or E2E_CLEANUP_PORTS=true to enable)"
fi

# Tear down cross-domain Docker stack
PROJECT="ci-hub-e2e"
if docker compose -p "$PROJECT" -f docker-compose.local.yml -f e2e/cross-domain/docker-compose.cross-domain.yml ps -q 2>/dev/null | grep -q .; then
  echo "[pre-test-cleanup] Tearing down stale cross-domain Docker stack..."
  docker compose -p "$PROJECT" -f docker-compose.local.yml -f e2e/cross-domain/docker-compose.cross-domain.yml down -v 2>/dev/null || true
fi

# Tear down standard E2E infra
if docker compose -f e2e/docker-compose.e2e.yml ps -q 2>/dev/null | grep -q .; then
  echo "[pre-test-cleanup] Tearing down stale standard E2E infra..."
  docker compose -f e2e/docker-compose.e2e.yml down -v 2>/dev/null || true
fi

# Remove .internal symlink left by cross-domain suite (points to .internal-e2e
# which is owned by Docker/root — the standard suite cannot unlink its contents)
if [ -L ".internal" ]; then
  echo "[pre-test-cleanup] Removing stale .internal symlink"
  rm -f .internal
fi

# Clean data dirs
rm -rf /tmp/ci-hub-e2e test-results 2>/dev/null || true

echo "[pre-test-cleanup] Cleanup complete."
