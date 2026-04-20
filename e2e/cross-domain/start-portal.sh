#!/usr/bin/env bash
# e2e/cross-domain/start-portal.sh
#
# Starts a local CI-Portal instance via miniflare (wrangler dev) for
# cross-domain E2E testing against the Hub.
#
# Prerequisites:
#   - CI-Portal repo cloned adjacent to CI-Hub (or set PORTAL_DIR)
#   - pnpm installed globally
#
# Environment variables:
#   PORTAL_DIR  — path to CI-Portal repo (default: ../../CI-Portal or ../CI-Portal)
#   PORTAL_PORT — port for wrangler dev (default: 8002)

set -euo pipefail

PORTAL_PORT="${PORTAL_PORT:-8002}"
PERSIST_DIR="db/e2e-cross-domain"

# Resolve Portal directory
if [ -n "${PORTAL_DIR:-}" ]; then
  PORTAL_ROOT="$PORTAL_DIR"
elif [ -d "../../CI-Portal" ]; then
  PORTAL_ROOT="../../CI-Portal"
elif [ -d "../CI-Portal" ]; then
  PORTAL_ROOT="../CI-Portal"
else
  echo "ERROR: CI-Portal directory not found."
  echo "Set PORTAL_DIR or clone CI-Portal adjacent to CI-Hub."
  exit 1
fi

PORTAL_ROOT="$(cd "$PORTAL_ROOT" && pwd)"
echo "Using Portal at: $PORTAL_ROOT"

cd "$PORTAL_ROOT"

# Install dependencies if needed (CI environments, first run)
if [ ! -d "node_modules" ] || [ ! -d "apps/hono-app/node_modules" ]; then
  echo "Installing Portal dependencies..."
  pnpm install --frozen-lockfile
fi

cd apps/hono-app

# Create E2E-specific secrets file (does NOT touch existing .dev.vars)
E2E_VARS_FILE="/tmp/portal-e2e-cross-domain.vars"
cat > "$E2E_VARS_FILE" << 'EOF'
BETTER_AUTH_SECRET=e2e-cross-domain-secret-key-that-is-at-least-32-characters-long
OAUTH_ENCRYPTION_KEY=e2e-cross-domain-oauth-encryption-key-32-chars-min
STORE_ADMIN_API_KEY=e2e-cross-domain-admin-api-key-value
REGISTRY_TOKEN_SECRET=e2e-cross-domain-registry-token-secret
REGISTRY_USERNAME=e2e
REGISTRY_PASSWORD=e2e
EOF

# Clean previous E2E data
rm -rf "$PERSIST_DIR"

# Apply D1 migrations
echo "Applying Portal D1 migrations..."
pnpm exec wrangler d1 migrations apply \
  --local \
  --env local \
  --persist-to "$PERSIST_DIR" \
  --env-file "$E2E_VARS_FILE" \
  ci-cloud-db-local

# Ensure web-app dist exists (wrangler ASSETS binding expects it)
mkdir -p ../web-app/dist

echo "Starting Portal on port $PORTAL_PORT..."

# Start wrangler dev — the exec replaces this shell so Playwright can manage the process
exec pnpm exec wrangler dev \
  --env local \
  --ip 0.0.0.0 \
  --port "$PORTAL_PORT" \
  --persist-to "$PERSIST_DIR" \
  --env-file "$E2E_VARS_FILE" \
  --var "REACT_APP_BASE_URL:http://localhost:$PORTAL_PORT" \
  --var "API_PUBLIC_ORIGIN:http://localhost:$PORTAL_PORT"
