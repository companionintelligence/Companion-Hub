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
export CI_HUB_ORGANIZATION_ID="e2e-org-test-${TIMESTAMP}"
export DEVICE_ID="e2e-device-test-${TIMESTAMP}"

echo "Generated CI_HUB_ORGANIZATION_ID: $CI_HUB_ORGANIZATION_ID"
echo "Generated DEVICE_ID: $DEVICE_ID"

# Seeding Cloud Staging DB with the new Organization
echo "Seeding Cloud Staging DB (D1)..."
pushd ../CI-Cloud/apps/hono-app
# Ensure Organization Exists
echo "Creating Remote Organization: $CI_HUB_ORGANIZATION_ID"
pnpm wrangler d1 execute ci-cloud-db-staging --remote --command "INSERT INTO organization (id, slug, name, created_at) VALUES ('${CI_HUB_ORGANIZATION_ID}', '${CI_HUB_ORGANIZATION_ID}', 'Auto E2E Org ${TIMESTAMP}', ${TIMESTAMP});" || true
popd


# Ensure these are set if not in .env.staging
export CI_CLOUD_API_URL="${CI_CLOUD_API_URL:-https://app-staging.ci.computer/api}"
export CI_CLOUD_FRONTEND_URL="${CI_CLOUD_FRONTEND_URL:-https://app-staging.ci.computer}"

export POSTGRES_PASSWORD=postgres
export JWT_SECRET=secret
export RUNTIPI_APP_DATA_PATH=./app-data
export RUNTIPI_FORWARD_AUTH_URL=http://localhost
export LOCAL_DOMAIN=localhost 
export DOMAIN=localhost
export ROOT_FOLDER_HOST="$(pwd)"

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
docker compose --project-name runtipi -f docker-compose.prod.yml -f docker-compose.staging.yml config
docker compose --project-name runtipi -f docker-compose.prod.yml -f docker-compose.staging.yml build --build-arg CACHE_BUST="${TIMESTAMP}"
docker compose --project-name runtipi -f docker-compose.prod.yml -f docker-compose.staging.yml up -d

# Wait for Health
echo "Waiting for DB and Backend to initialize..."
MAX_RETRIES=60 # 5 minutes
COUNT=0
# Note: docker-compose.staging.yml maps 3000:3000
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
  docker logs ci-os-hub
  echo "--- CLOUDFLARED LOGS ---"
  docker logs cloudflared_ci-cloud-cloudflared-1 || echo "Cloudflared container not found or named differently"
  echo "---------------------------------------------------"
  # Check if we can reach Google (DNS check)
  echo "Checking DNS..."
  docker exec ci-os-hub ping -c 1 8.8.8.8
  # Check if we can reach Cloud API
  echo "Checking Connectivity to Staging API..."
  docker exec ci-os-hub curl -I https://app-staging.ci.computer/api/health
  exit 1
fi

echo "All Tests Completed Successfully."
