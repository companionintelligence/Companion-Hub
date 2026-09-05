#!/usr/bin/env bash
# Run the full-stack FTUE lane with the smallest safe infrastructure lifecycle.

set -euo pipefail

COMPOSE_FILE="e2e/docker-compose.e2e.yml"
STARTED_INFRA="false"
DB_CONTAINER_BEFORE=""
DB_RUNNING_BEFORE=""
QUEUE_CONTAINER_BEFORE=""
QUEUE_RUNNING_BEFORE=""

export BACKEND_PORT="${BACKEND_PORT:-13000}"
export FRONTEND_PORT="${FRONTEND_PORT:-19091}"
export MOCK_PORTAL_PORT="${MOCK_PORTAL_PORT:-16444}"
export FTUE_INFERENCE_FIXTURE_PORT="${FTUE_INFERENCE_FIXTURE_PORT:-18090}"
export POSTGRES_DBNAME="${POSTGRES_DBNAME:-companion_ftue_e2e}"
export CI_HUB_DATA_DIR="${CI_HUB_DATA_DIR:-/tmp/ci-hub-ftue-e2e}"
export ROOT_FOLDER_HOST="${ROOT_FOLDER_HOST:-$CI_HUB_DATA_DIR}"
export CI_HUB_APP_DATA_PATH="${CI_HUB_APP_DATA_PATH:-$CI_HUB_DATA_DIR}"
export CI_HUB_APP_DATA_DIR="${CI_HUB_APP_DATA_DIR:-$CI_HUB_DATA_DIR/app-data}"
export CI_HUB_TUNNEL_DIR="${CI_HUB_TUNNEL_DIR:-$CI_HUB_DATA_DIR/tunnel}"
export CI_HUB_FORWARD_AUTH_URL="${CI_HUB_FORWARD_AUTH_URL:-http://localhost:$BACKEND_PORT/api/auth/traefik}"

cleanup() {
  if [ "$STARTED_INFRA" != "true" ]; then
    return
  fi

  echo "[future-onboarding] Restoring test infrastructure to its prior state..."
  if [ -z "$DB_CONTAINER_BEFORE" ] && [ -z "$QUEUE_CONTAINER_BEFORE" ]; then
    docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
    return
  fi

  if [ -z "$DB_RUNNING_BEFORE" ]; then
    docker compose -f "$COMPOSE_FILE" stop db >/dev/null 2>&1 || true
    if [ -z "$DB_CONTAINER_BEFORE" ]; then
      docker compose -f "$COMPOSE_FILE" rm -f -v db >/dev/null 2>&1 || true
    fi
  fi

  if [ -z "$QUEUE_RUNNING_BEFORE" ]; then
    docker compose -f "$COMPOSE_FILE" stop queue >/dev/null 2>&1 || true
    if [ -z "$QUEUE_CONTAINER_BEFORE" ]; then
      docker compose -f "$COMPOSE_FILE" rm -f -v queue >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

E2E_SUITE=future-onboarding bash e2e/pre-test-cleanup.sh

if ! E2E_INFRA_RETRIES=1 E2E_INFRA_INTERVAL_MS=100 \
  pnpm exec tsx e2e/helpers/require-infra-ready.ts >/dev/null 2>&1; then
  DB_CONTAINER_BEFORE="$(docker compose -f "$COMPOSE_FILE" ps -a -q db 2>/dev/null || true)"
  DB_RUNNING_BEFORE="$(docker compose -f "$COMPOSE_FILE" ps --status running -q db 2>/dev/null || true)"
  QUEUE_CONTAINER_BEFORE="$(docker compose -f "$COMPOSE_FILE" ps -a -q queue 2>/dev/null || true)"
  QUEUE_RUNNING_BEFORE="$(docker compose -f "$COMPOSE_FILE" ps --status running -q queue 2>/dev/null || true)"
  echo "[future-onboarding] Starting PostgreSQL and RabbitMQ test services..."
  STARTED_INFRA="true"
  docker compose -f "$COMPOSE_FILE" up -d db queue
fi

pnpm exec tsx e2e/helpers/require-infra-ready.ts
pnpm exec tsx e2e/helpers/ensure-test-database.ts
E2E_SUITE=future-onboarding pnpm exec playwright test --config playwright.future-onboarding.config.ts "$@"
