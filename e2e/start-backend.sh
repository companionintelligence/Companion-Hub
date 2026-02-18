#!/usr/bin/env bash
# e2e/start-backend.sh — Start backend for E2E tests
# Creates required directories/files, writes .env for backend, then starts

set -euo pipefail

DATA_DIR="${TIPI_DATA_DIR:-/tmp/runtipi-e2e}"

# Create required directory structure
mkdir -p "$DATA_DIR"/{state,logs,apps,app-data,repos,backups,user-config,media}
mkdir -p "$DATA_DIR/state/traefik"/{config,dynamic,tls}
touch "$DATA_DIR/state/traefik/acme_storage.json"

# Write .env file with all required vars (backend reads this on startup)
cat > "$DATA_DIR/.env" << EOF
NODE_ENV=${NODE_ENV:-development}
POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-6543}
POSTGRES_USERNAME=${POSTGRES_USERNAME:-tipi}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-postgres}
POSTGRES_DBNAME=${POSTGRES_DBNAME:-tipi}
RABBITMQ_HOST=${RABBITMQ_HOST:-localhost}
RABBITMQ_PORT=${RABBITMQ_PORT:-5672}
RABBITMQ_USERNAME=${RABBITMQ_USERNAME:-tipi}
RABBITMQ_PASSWORD=${RABBITMQ_PASSWORD:-tipi}
JWT_SECRET=${JWT_SECRET:-e2e-test-secret}
CI_CLOUD_URL=${CI_CLOUD_URL:-https://app.companionintelligence.com}
CI_CLOUD_API_URL=${CI_CLOUD_API_URL:-https://app.companionintelligence.com/api}
CI_CLOUD_FRONTEND_URL=${CI_CLOUD_FRONTEND_URL:-https://app.companionintelligence.com}
DOMAIN=${DOMAIN:-ci.computer}
LOCAL_DOMAIN=${LOCAL_DOMAIN:-tipi.lan}
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
TIPI_DATA_DIR=$DATA_DIR
TIPI_APP_DATA_DIR=$DATA_DIR/app-data
TIPI_APP_DIR=$DATA_DIR/apps
EOF

echo "E2E backend starting with DATA_DIR=$DATA_DIR"

# Start backend from the backend package dir (needed for migration path resolution)
cd packages/backend
exec bun run nest start --watch --preserveWatchOutput
