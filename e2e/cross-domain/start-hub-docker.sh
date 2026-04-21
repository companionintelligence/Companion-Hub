#!/usr/bin/env bash
# e2e/cross-domain/start-hub-docker.sh
#
# Starts the full Hub stack (postgres, rabbitmq, backend, frontend) inside
# Docker for cross-domain E2E tests. Data is isolated under .internal-e2e/.
#
# Environment variables:
#   PORTAL_PORT — port the Portal is listening on (default: 8012)

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

# Stop dev containers on same ports if running (different compose project)
for port in 3000 9091 6543 5672; do
  pid=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo "Killing process on port $port (pid $pid)..."
    kill $pid 2>/dev/null || true
  fi
done

cleanup() {
  "${COMPOSE_CMD[@]}" down -v 2>/dev/null || true
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
EOF

echo "Starting Hub in Docker (project=$COMPOSE_PROJECT, portal=localhost:$PORTAL_PORT)..."

# Start the full stack — Playwright manages the lifecycle
"${COMPOSE_CMD[@]}" up --build --abort-on-container-exit
