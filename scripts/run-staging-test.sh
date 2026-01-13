#!/bin/bash
set -e

# Define root and hub dirs
# Assumes this script is in CI-OS-Hub/scripts/ or similar, but let's be safe
# If run from root, HUB_DIR is CI-OS-Hub. If run from CI-OS-Hub, it's .
if [[ "$PWD" == *"CI-OS-Hub" ]]; then
  HUB_DIR="."
else
  HUB_DIR="CI-OS-Hub"
fi

echo "Current Working Directory: $(pwd)"
echo "Hub Directory: $HUB_DIR"

# Navigate to Hub Directory if needed
cd "$HUB_DIR"

echo "Running Unified Staging E2E Tests..."
echo "API URL: https://app-staging.ci.computer/api"
echo "Org ID: test-org-e2e"

# Export Environment Variables from .env.staging
if [ -f .env.staging ]; then
  echo "Loading .env.staging..."
  set -a
  source .env.staging
  set +a
else
  echo "Error: .env.staging not found in $HUB_DIR"
  exit 1
fi

# Overrides for Test Execution
export ENV_FILE=.env.staging
# Generate unique IDs for this run to avoid Cloudflare tunnel conflicts
TIMESTAMP=$(node -e 'console.log(Date.now())')
export TEST_ID="${TIMESTAMP}"
export CI_HUB_ORGANIZATION_ID="e2e-org-test-${TIMESTAMP}"
export DEVICE_ID="e2e-device-test-${TIMESTAMP}"
export CI_HUB_API_KEY="e2e-api-key-${TIMESTAMP}"
export REG_ID="reg-${TIMESTAMP}"

# ISOLATION: Use unique Project Name and Data Directory
export COMPOSE_PROJECT_NAME="e2e-${TEST_ID}"
export DATA_DIR_NAME=".internal-${TEST_ID}"
export DATA_DIR="./${DATA_DIR_NAME}"
export ABS_DATA_DIR="$(pwd)/${DATA_DIR_NAME}"

# Container & Volume Isolation
export DB_CONTAINER_NAME="${COMPOSE_PROJECT_NAME}-ci-hub-db"
export QUEUE_CONTAINER_NAME="${COMPOSE_PROJECT_NAME}-ci-os-hub-queue"
export HUB_CONTAINER_NAME="${COMPOSE_PROJECT_NAME}-ci-os-hub"
export CLOUDFLARED_CONTAINER_NAME="${COMPOSE_PROJECT_NAME}-cloudflared"
export DB_VOLUME_NAME="${COMPOSE_PROJECT_NAME}_ci_hub_pgdata"
export NETWORK_NAME="${HUB_CONTAINER_NAME}_network"

# Update .env.staging to ensure container sees the new IDs (avoid stale config)
# This is critical because the container mounts .env.staging as .env, 
# and Runtipi backend might prioritize .env file over OS env vars.
if [ -f .env.staging ]; then
  # Remove lines if they exist to avoid duplication/sed complexity
  sed -i.bak '/^CI_HUB_ORGANIZATION_ID=/d' .env.staging
  sed -i.bak '/^DEVICE_ID=/d' .env.staging
  sed -i.bak '/^CI_HUB_API_KEY=/d' .env.staging
  
  # Append new values
  echo "CI_HUB_ORGANIZATION_ID=${CI_HUB_ORGANIZATION_ID}" >> .env.staging
  echo "DEVICE_ID=${DEVICE_ID}" >> .env.staging
  echo "CI_HUB_API_KEY=${CI_HUB_API_KEY}" >> .env.staging
fi

echo "running test with ID: ${TEST_ID}"
echo "Data Directory: ${DATA_DIR}"
echo "Compose Project: ${COMPOSE_PROJECT_NAME}"

# Override ALL storage paths to use unique directory
export RUNTIPI_MEDIA_PATH="${DATA_DIR}/media"
export RUNTIPI_STATE_PATH="${DATA_DIR}/state"
export RUNTIPI_REPOS_PATH="${DATA_DIR}/repos"
export RUNTIPI_APPS_PATH="${DATA_DIR}/apps"
export RUNTIPI_LOGS_PATH="${DATA_DIR}/logs"
export RUNTIPI_USER_CONFIG_PATH="${DATA_DIR}/user-config"
export RUNTIPI_APP_DATA_PATH="${DATA_DIR}/app-data"
export RUNTIPI_BACKUPS_PATH="${DATA_DIR}/backups"
export ROOT_FOLDER_HOST="${ABS_DATA_DIR}"

echo "Generated CI_HUB_ORGANIZATION_ID: $CI_HUB_ORGANIZATION_ID"
echo "Generated DEVICE_ID: $DEVICE_ID"
echo "Generated CI_HUB_API_KEY: $CI_HUB_API_KEY"

# Seeding Cloud Staging DB with the new Organization, Device, and Registration
echo "Seeding Cloud Staging DB (D1)..."
pushd ../CI-Cloud/apps/hono-app
# Ensure Organization Exists
echo "Creating Remote Organization: $CI_HUB_ORGANIZATION_ID"
pnpm wrangler d1 execute ci-cloud-db-staging --remote --command "INSERT INTO organization (id, slug, name, created_at) VALUES ('${CI_HUB_ORGANIZATION_ID}', '${CI_HUB_ORGANIZATION_ID}', 'Auto E2E Org ${TIMESTAMP}', ${TIMESTAMP});" || true
# Ensure Device Exists
echo "Creating Remote Device: $DEVICE_ID"
pnpm wrangler d1 execute ci-cloud-db-staging --remote --command "INSERT INTO device (device_id, api_key, status, created_at) VALUES ('${DEVICE_ID}', '${CI_HUB_API_KEY}', 'active', ${TIMESTAMP});" || true
# Ensure Registration Exists
echo "Creating Remote Registration"
pnpm wrangler d1 execute ci-cloud-db-staging --remote --command "INSERT INTO device_registration (id, device_id, organization_id) VALUES ('${REG_ID}', '${DEVICE_ID}', '${CI_HUB_ORGANIZATION_ID}');" || true
popd


# Ensure these are set if not in .env.staging
export CI_CLOUD_API_URL="${CI_CLOUD_API_URL:-https://app-staging.ci.computer/api}"
export CI_CLOUD_FRONTEND_URL="${CI_CLOUD_FRONTEND_URL:-https://app-staging.ci.computer}"

export POSTGRES_PASSWORD=postgres
export JWT_SECRET=secret
export RUNTIPI_FORWARD_AUTH_URL=http://localhost
export LOCAL_DOMAIN=localhost 
export DOMAIN=localhost

# Set Platform for Docker
if [[ $(uname -m) == 'arm64' ]]; then
  export DOCKER_PLATFORM=linux/arm64
else
  export DOCKER_PLATFORM=linux/amd64
fi
echo "Using Docker Platform: $DOCKER_PLATFORM"

# Cleanup any existing containers and volumes
echo "Cleaning up..."
docker compose --project-name runtipi -f docker-compose.prod.yml -f docker-compose.staging.yml down -v || true
rm -rf ./tunnel
rm -rf ./.internal
rm -rf ./app-data

# Aggressive cleanup
echo "Killing lingering containers..."
docker ps -a --format "{{.ID}} {{.Names}}" | grep -E "${COMPOSE_PROJECT_NAME}|runtipi|ci-cloud|ci-os-hub|cloudflared|ci-hub-db|ci-os-hub-queue" | awk '{print $1}' | xargs -r docker rm -f

# Cleanup compose services and volumes
echo "Cleaning up compose..."
docker compose --project-name "${COMPOSE_PROJECT_NAME}" -f docker-compose.prod.yml -f docker-compose.staging.yml down -v || true

# Clean up shared tunnel (hardcoded mount)
rm -rf ./tunnel
mkdir -p ./tunnel
touch ./tunnel/config.yml


# Clean up data dir
rm -rf "${DATA_DIR}"

# Explicitly remove volumes just in case (using project name prefix)
echo "Explicitly removing volumes..."
docker volume rm -f "${COMPOSE_PROJECT_NAME}_ci_hub_pgdata" || true
docker volume prune -f

echo "Verifying cleanup..."
ls -la "${DATA_DIR}" || echo "${DATA_DIR} is gone"

# --- TEST: Full End-to-End User Flow ---
echo "---------------------------------------------------"
echo "Running FULL E2E Test: Boot -> Register -> Install -> Tunnel"
echo "---------------------------------------------------"
# Restore Org ID for Test 2 behavior (reusing existing staging org)
# export CI_HUB_ORGANIZATION_ID="test-org-e2e"

# Use KNOWN Device ID that is already registered in Cloud Staging for Stability
# But verify the "New Device" UI flow by clearing local DB (handled in spec)
# export DEVICE_ID="test-device-id"
echo "Using Device ID: $DEVICE_ID"

echo "Starting CI-OS-Hub containers..."
docker compose --project-name "${COMPOSE_PROJECT_NAME}" -f docker-compose.prod.yml -f docker-compose.staging.yml config
docker compose --project-name "${COMPOSE_PROJECT_NAME}" -f docker-compose.prod.yml -f docker-compose.staging.yml build --build-arg CACHE_BUST="${TIMESTAMP}"
docker compose --project-name "${COMPOSE_PROJECT_NAME}" -f docker-compose.prod.yml -f docker-compose.staging.yml up -d

# Wait for Health
echo "Waiting for DB and Backend to initialize..."
MAX_RETRIES=60 # 5 minutes
COUNT=0
# Note: docker-compose.staging.yml maps 3000:3000
# With unique project name, ports might conflict if running parallel? 
# But we map 3000:3000 on Host. So we can't run parallel.
until curl -s http://localhost:3000/api/health > /dev/null; do
  echo "Waiting for backend to be healthy... ($COUNT/$MAX_RETRIES)"
  sleep 5
  COUNT=$((COUNT+1))
  if [ $COUNT -ge $MAX_RETRIES ]; then
    echo "Timeout waiting for backend to be healthy."
    exit 1
  fi
done
echo "Backend is healthy."

# Run the FULL E2E Test
export STAGING_TUNNEL_ID=$CF_TUNNEL_ID
export STAGING_ORG_SLUG=$CI_HUB_ORGANIZATION_ID
export SERVER_IP=localhost
export SERVER_PORT=3000

set +e
# Use local binary to bypass package manager checks if bun is missing/enforced
./node_modules/.bin/playwright test e2e/full-e2e.spec.ts
TEST_EXIT_CODE=$?
set -e

if [ $TEST_EXIT_CODE -ne 0 ]; then
  echo "Test Failed. Capturing Logs..."
  # Get container ID dynamically
  HUB_CONTAINER_ID=$(docker compose --project-name "${COMPOSE_PROJECT_NAME}" -f docker-compose.prod.yml -f docker-compose.staging.yml ps -q ci-os-hub)
  if [ -n "$HUB_CONTAINER_ID" ]; then
    docker logs "$HUB_CONTAINER_ID"
  else
    echo "Could not find ci-os-hub container."
  fi

  echo "--- CLOUDFLARED LOGS ---"
  # Try to find cloudflared container dynamically
  CLOUDFLARED_ID=$(docker ps -a --format "{{.ID}}" --filter "name=${COMPOSE_PROJECT_NAME}.*cloudflared" | head -n 1)
  if [ -n "$CLOUDFLARED_ID" ]; then
      docker logs "$CLOUDFLARED_ID"
  else
      # Fallback 
      docker logs "${COMPOSE_PROJECT_NAME}-cloudflared-1" || echo "Cloudflared container not found"
  fi
  
  echo "---------------------------------------------------"
  # Check if we can reach Google (DNS check)
  echo "Checking DNS..."
  if [ -n "$HUB_CONTAINER_ID" ]; then
    docker exec "$HUB_CONTAINER_ID" ping -c 1 8.8.8.8
    # Check if we can reach Cloud API
    echo "Checking Connectivity to Staging API..."
    docker exec "$HUB_CONTAINER_ID" curl -I https://app-staging.ci.computer/api/health
  fi
  # Teardown (commented out to allow debugging)
  # docker compose --project-name "${COMPOSE_PROJECT_NAME}" -f docker-compose.prod.yml -f docker-compose.staging.yml down -v
  exit 1
fi

echo "All Tests Completed Successfully."
# Success Teardown
echo "Tearing down..."
docker compose --project-name "${COMPOSE_PROJECT_NAME}" -f docker-compose.prod.yml -f docker-compose.staging.yml down -v
# Clean up tunnel
rm -rf ./tunnel
# Clean up data dir
rm -rf "${DATA_DIR}"

