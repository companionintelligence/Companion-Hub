#!/usr/bin/env bash
# e2e/start-backend.sh — Start backend for E2E tests
# Creates required directories/files, writes .env for backend, builds, then starts

set -euo pipefail

DATA_DIR="${TIPI_DATA_DIR:-/tmp/runtipi-e2e}"

# Create required directory structure
mkdir -p "$DATA_DIR"/{state,logs,apps,app-data,repos,backups,user-config,media}
mkdir -p "$DATA_DIR/state/traefik"/{config,dynamic,tls}
touch "$DATA_DIR/state/traefik/acme_storage.json"

# Create dummy tunnel token so isRegistered() returns true in E2E
# Without this, the frontend gates all pages behind device-registration
mkdir -p "$(pwd)/tunnel"
echo "e2e-mock-tunnel-token" > "$(pwd)/tunnel/token"

# Build workspace dependencies (common package must be compiled before backend can start)
echo "Building @runtipi/common..."
(cd packages/common && bun run build)

# Build backend (nest build uses swc, doesn't reliably copy all assets)
echo "Building backend..."
(cd packages/backend && bun run nest build)

# Copy migration assets that nest build may not handle
mkdir -p packages/backend/dist/assets/migrations/meta
cp packages/backend/src/core/database/drizzle/*.sql packages/backend/dist/assets/migrations/
cp packages/backend/src/core/database/drizzle/meta/* packages/backend/dist/assets/migrations/meta/

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
CI_CLOUD_API_URL=${CI_CLOUD_API_URL:-https://app.companionintelligence.com/api}
CI_CLOUD_FRONTEND_URL=${CI_CLOUD_FRONTEND_URL:-https://app.companionintelligence.com}
DOMAIN=${DOMAIN:-ci.computer}
LOCAL_DOMAIN=${LOCAL_DOMAIN:-ci.lan}
DEMO_MODE=${DEMO_MODE:-false}
GUEST_DASHBOARD=${GUEST_DASHBOARD:-false}
TZ=${TZ:-UTC}
THEME_BASE=${THEME_BASE:-gray}
THEME_COLOR=${THEME_COLOR:-blue}
EXPERIMENTAL_INSECURE_COOKIE=${EXPERIMENTAL_INSECURE_COOKIE:-true}
TIPI_VERSION=${TIPI_VERSION:-e2e}
INTERNAL_IP=${INTERNAL_IP:-0.0.0.0}
ROOT_FOLDER_HOST=${ROOT_FOLDER_HOST:-/tmp/runtipi-e2e}
RUNTIPI_APP_DATA_PATH=${RUNTIPI_APP_DATA_PATH:-/tmp/runtipi-e2e}
RUNTIPI_FORWARD_AUTH_URL=http://localhost:3000/api/auth/traefik
ALLOW_AUTO_THEMES=${ALLOW_AUTO_THEMES:-true}
ALLOW_ERROR_MONITORING=${ALLOW_ERROR_MONITORING:-false}
PERSIST_TRAEFIK_CONFIG=${PERSIST_TRAEFIK_CONFIG:-false}
ADVANCED_SETTINGS=${ADVANCED_SETTINGS:-false}
DISABLE_PASSWORD_RESET=${DISABLE_PASSWORD_RESET:-true}
DNS_IP=${DNS_IP:-9.9.9.9}
ARCHITECTURE=${ARCHITECTURE:-amd64}
DEVICE_ID=${DEVICE_ID:-test-device-e2e}
TIPI_DATA_DIR=$DATA_DIR
TIPI_APP_DATA_DIR=$DATA_DIR/app-data
TIPI_APP_DIR=$(pwd)
EOF

echo "E2E backend starting with DATA_DIR=$DATA_DIR"

# Run the compiled backend directly
cd packages/backend
exec node dist/src/main.js
