#!/usr/bin/env bash
# e2e/start-backend.sh — Start backend for E2E tests
# Creates required directories/files, writes .env for backend, builds, then starts

set -euo pipefail

DATA_DIR="${CI_HUB_DATA_DIR:-/tmp/ci-hub-e2e}"
TUNNEL_DIR="${CI_HUB_TUNNEL_DIR:-$DATA_DIR/tunnel}"


# Fail fast with a clear message if Postgres / RabbitMQ are unavailable.
pnpm exec tsx ./e2e/helpers/require-infra-ready.ts

# Create required directory structure
mkdir -p "$DATA_DIR"/{state,logs,apps,app-data,repos,backups,user-config,media}
mkdir -p "$DATA_DIR/state/traefik"/{config,dynamic,tls}
touch "$DATA_DIR/state/traefik/acme_storage.json"

# Link CI-Marketplace so app-store tests find apps in E2E
# The backend resolves apps at $DATA_DIR/repos/<store-slug>/apps/
MARKETPLACE_SRC="${CI_MARKETPLACE_DIR:-$(pwd)/../CI-Marketplace}"
MARKETPLACE_LINK="$DATA_DIR/repos/ci-marketplace"
mkdir -p "$MARKETPLACE_LINK"
rm -rf "$MARKETPLACE_LINK/apps"          # Remove any stale dir or nested symlink
if [ -d "$MARKETPLACE_SRC/apps" ]; then
  ln -s "$(realpath "$MARKETPLACE_SRC/apps")" "$MARKETPLACE_LINK/apps"
  echo "CI-Marketplace: linked $(ls "$MARKETPLACE_LINK/apps" | wc -l | tr -d ' ') apps from $MARKETPLACE_SRC"
else
  mkdir -p "$MARKETPLACE_LINK/apps"
  echo "Warning: CI-Marketplace not found at $MARKETPLACE_SRC — app store will be empty"
fi

# Create dummy tunnel token so isRegistered() returns true in E2E
# Without this, the frontend gates all pages behind device-registration
mkdir -p "$TUNNEL_DIR"
echo "e2e-mock-tunnel-token" > "$TUNNEL_DIR/token"

# Build workspace dependencies (common package must be compiled before backend can start)
echo "Building @ci-hub/common..."
(cd packages/common && pnpm run build)

# Build backend (compile.ts copies the migration SQL but not drizzle's meta/ journal)
echo "Building backend..."
(cd packages/backend && pnpm run compile)

# Add the journal next to the SQL compile.ts copied
mkdir -p packages/backend/dist/assets/migrations/meta
cp packages/backend/src/core/database/drizzle/meta/* packages/backend/dist/assets/migrations/meta/ || true

# Write .env file with all required vars (backend reads this on startup)
BACKEND_DIST="$(pwd)/packages/backend/dist"
cat > "$DATA_DIR/.env" << EOF
NODE_ENV=${NODE_ENV:-development}
POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-6543}
POSTGRES_USERNAME=${POSTGRES_USERNAME:-companion}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-postgres}
POSTGRES_DBNAME=${POSTGRES_DBNAME:-companiondb}
RABBITMQ_HOST=${RABBITMQ_HOST:-localhost}
RABBITMQ_PORT=${RABBITMQ_PORT:-5672}
RABBITMQ_USERNAME=${RABBITMQ_USERNAME:-companion}
RABBITMQ_PASSWORD=${RABBITMQ_PASSWORD:-admin}
JWT_SECRET=${JWT_SECRET:-e2e-test-secret}
CI_CLOUD_URL=${CI_CLOUD_URL:-https://app.companionintelligence.com}
DOMAIN=${DOMAIN:-ci.computer}
LOCAL_DOMAIN=${LOCAL_DOMAIN:-ci.lan}
DEMO_MODE=${DEMO_MODE:-false}
GUEST_DASHBOARD=${GUEST_DASHBOARD:-false}
TZ=${TZ:-UTC}
THEME_BASE=${THEME_BASE:-gray}
THEME_COLOR=${THEME_COLOR:-blue}
EXPERIMENTAL_INSECURE_COOKIE=${EXPERIMENTAL_INSECURE_COOKIE:-true}
CI_HUB_VERSION=${CI_HUB_VERSION:-e2e}
INTERNAL_IP=${INTERNAL_IP:-0.0.0.0}
ROOT_FOLDER_HOST=${ROOT_FOLDER_HOST:-/tmp/ci-hub-e2e}
CI_HUB_APP_DATA_PATH=${CI_HUB_APP_DATA_PATH:-/tmp/ci-hub-e2e}
CI_HUB_FORWARD_AUTH_URL=${CI_HUB_FORWARD_AUTH_URL:-http://localhost:3000/api/auth/traefik}
ALLOW_AUTO_THEMES=${ALLOW_AUTO_THEMES:-true}
ALLOW_ERROR_MONITORING=${ALLOW_ERROR_MONITORING:-false}
PERSIST_TRAEFIK_CONFIG=${PERSIST_TRAEFIK_CONFIG:-false}
PRIVATE_VPN_USER_DISABLED=true
ADVANCED_SETTINGS=${ADVANCED_SETTINGS:-false}
DISABLE_PASSWORD_RESET=${DISABLE_PASSWORD_RESET:-true}
DNS_IP=${DNS_IP:-9.9.9.9}
ARCHITECTURE=${ARCHITECTURE:-amd64}
DEVICE_ID=${DEVICE_ID:-test-device-e2e}
CI_HUB_DATA_DIR=$DATA_DIR
CI_HUB_APP_DATA_DIR=$DATA_DIR/app-data
CI_HUB_APP_DIR=$(pwd)
CI_HUB_TUNNEL_DIR=$TUNNEL_DIR
E2E_TEST=${E2E_TEST:-true}
EOF

echo "E2E backend starting with DATA_DIR=$DATA_DIR"

# Run the compiled backend directly
cd packages/backend
exec node dist/src/main.js
