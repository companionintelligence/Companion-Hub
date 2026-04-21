#!/usr/bin/env bash
# e2e/cross-domain/start-hub-docker.sh
#
# Starts the full Hub stack (postgres, rabbitmq, backend, frontend) inside
# Docker for cross-domain E2E tests. Data is isolated under .internal-e2e/.
#
# Environment variables:
#   PORTAL_PORT              — port the Portal is listening on (default: 8012)
#   ALLOW_KILL_PORT_PROCESSES — set to "true" to kill processes on ports used
#                               by the E2E stack (default: disabled)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

E2E_DIR=".internal-e2e"
COMPOSE_PROJECT="ci-hub-e2e"
COMPOSE_CMD=(docker compose -p "$COMPOSE_PROJECT"
  -f docker-compose.local.yml
  -f e2e/cross-domain/docker-compose.cross-domain.yml)

# Verify Docker is available
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is not running. Start Docker Desktop or the Docker daemon." >&2
  exit 1
fi

# Clean up previous E2E run
"${COMPOSE_CMD[@]}" down -v 2>/dev/null || true

# Optionally stop processes bound to ports used by the E2E stack.
# Disabled by default — set ALLOW_KILL_PORT_PROCESSES=true to enable.
if [ "${ALLOW_KILL_PORT_PROCESSES:-}" = "true" ]; then
  if command -v lsof >/dev/null 2>&1; then
    for port in 3000 9091 6543 5672; do
      pid=$(lsof -ti :"$port" 2>/dev/null || true)
      if [ -n "$pid" ]; then
        echo "Killing process on port $port (pid $pid)..."
        kill "$pid" 2>/dev/null || true
      fi
    done
  else
    echo "WARNING: lsof not found — skipping port cleanup" >&2
  fi
fi

cleanup() {
  "${COMPOSE_CMD[@]}" down -v 2>/dev/null || true
  # Remove .internal symlink if we created it
  if [ -L ".internal" ] && [ "$(readlink .internal)" = ".internal-e2e" ]; then
    rm .internal
  fi
}
trap cleanup EXIT

# Create isolated data directories
for d in state logs apps app-data repos repos/migrated backups user-config media cache; do
  mkdir -p "$E2E_DIR/$d"
done
mkdir -p "$E2E_DIR/state/traefik"/{config,dynamic,tls}
touch "$E2E_DIR/state/traefik/acme_storage.json"

# Write minimal .env — compose environment section overrides critical vars
export PORTAL_PORT="${PORTAL_PORT:-8012}"

cat > "$E2E_DIR/.env" <<EOF
NODE_ENV=development
ROOT_FOLDER_HOST=${PWD}/.internal-e2e
JWT_SECRET=e2e-cross-domain-jwt-secret
LOCAL_DOMAIN=ci.lan
TZ=UTC
THEME_BASE=gray
THEME_COLOR=blue
ALLOW_AUTO_THEMES=true
ALLOW_ERROR_MONITORING=false
PERSIST_TRAEFIK_CONFIG=false
ADVANCED_SETTINGS=false
DISABLE_PASSWORD_RESET=true
DNS_IP=9.9.9.9
DEMO_MODE=false
GUEST_DASHBOARD=false
CI_HUB_FORWARD_AUTH_URL=http://localhost:3000/api/auth/traefik
CI_CLOUD_URL=http://host.docker.internal:${PORTAL_PORT}
DOMAIN=ci.localhost
INTERNAL_IP=0.0.0.0
CI_HUB_VERSION=e2e-cross-domain
DEVICE_ID=e2e-cross-domain-device
POSTGRES_PASSWORD=postgres
POSTGRES_HOST=ci-hub-db
POSTGRES_PORT=5432
POSTGRES_USERNAME=companion
POSTGRES_DBNAME=ci-hub
RABBITMQ_HOST=ci-os-hub-queue
RABBITMQ_PORT=5672
RABBITMQ_USERNAME=companion
RABBITMQ_PASSWORD=admin
EOF

# Symlink .internal -> .internal-e2e so base compose volume mounts
# (which reference .internal/*) transparently use E2E data.
# Docker Compose merges volume lists across -f files (appends, doesn't
# replace), so we can't override individual mounts in the override file.
if [ -e ".internal" ] && [ ! -L ".internal" ]; then
  echo "WARNING: .internal/ exists and is not a symlink — backing up to .internal.bak" >&2
  mv .internal .internal.bak
fi
ln -sfn .internal-e2e .internal

echo "Starting Hub in Docker (project=$COMPOSE_PROJECT, portal=localhost:$PORTAL_PORT)..."

# Start the full stack — Playwright manages the lifecycle
# Start stack in detached mode — the Hub container may restart once if
# RabbitMQ isn't ready fast enough (restart: unless-stopped handles it).
# We poll the health endpoint below instead of using --abort-on-container-exit
# which kills everything on the first transient restart.
"${COMPOSE_CMD[@]}" up --build -d

# Wait for Hub backend health — the backend may restart once if RabbitMQ
# isn't ready fast enough (restart: unless-stopped handles this).
# Allow up to 120s to account for: Docker restart + TypeScript compilation + DB migration.
echo "Waiting for Hub backend to become healthy..."
for i in $(seq 1 120); do
  if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "Hub backend healthy after ${i}s"
    break
  fi
  if [ "$i" -eq 120 ]; then
    echo "ERROR: Hub backend did not become healthy within 120s" >&2
    docker logs ci-hub-e2e-hub 2>&1 | tail -30
    "${COMPOSE_CMD[@]}" down -v
    exit 1
  fi
  sleep 1
done

# Keep running — Playwright manages the lifecycle via the webServer config.
# The trap handler runs 'docker compose down -v' on exit.
echo "Hub stack running. Tailing logs (Ctrl+C to stop)..."
exec "${COMPOSE_CMD[@]}" logs -f
