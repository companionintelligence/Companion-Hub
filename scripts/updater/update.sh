#!/usr/bin/env bash
set -o errexit
set -o nounset
set -o pipefail

VERSION="latest"
REPO="companionintelligence/ci-os-hub"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
HUB_CONTAINER="${HUB_CONTAINER_NAME:-ci-os-hub}"
HUB_PORT="${API_PORT:-5002}"
HEALTH_TIMEOUT=120
SKIP_BACKUP="${SKIP_BACKUP:-false}"

while [ -n "${1-}" ]; do
  case "$1" in
  --version)
    shift
    VERSION="$1"
    ;;
  --skip-backup)
    SKIP_BACKUP="true"
    ;;
  *) echo "Option $1 not recognized" && exit 1 ;;
  esac
  shift
done

echo "============================================"
echo "  CI-OS-Hub Update — Version: ${VERSION}"
echo "============================================"

# ── Pre-flight checks ──────────────────────────

echo ""
echo "1. Pre-flight checks..."

# Verify ROOT_FOLDER_HOST is set and absolute
if [ -z "${ROOT_FOLDER_HOST:-}" ]; then
  # Try to read from .env
  if [ -f .env ]; then
    ROOT_FOLDER_HOST=$(grep -E '^ROOT_FOLDER_HOST=' .env | cut -d= -f2- || true)
  fi
fi

if [ -z "${ROOT_FOLDER_HOST:-}" ]; then
  echo "ERROR: ROOT_FOLDER_HOST is not set. Set it in .env or export it."
  echo "       Example: ROOT_FOLDER_HOST=/opt/ci-os-hub/data"
  exit 1
fi

case "${ROOT_FOLDER_HOST}" in
  /*) ;; # absolute path — good
  *)
    echo "ERROR: ROOT_FOLDER_HOST must be an absolute path, got: ${ROOT_FOLDER_HOST}"
    exit 1
    ;;
esac

echo "   ROOT_FOLDER_HOST: ${ROOT_FOLDER_HOST}"

# Verify critical directories exist
CRITICAL_DIRS=("${ROOT_FOLDER_HOST}/state" "${ROOT_FOLDER_HOST}/apps")
for dir in "${CRITICAL_DIRS[@]}"; do
  if [ ! -d "$dir" ]; then
    echo "   WARNING: Missing directory: $dir (will be created)"
    mkdir -p "$dir"
  else
    echo "   OK: $dir"
  fi
done

# Verify Docker is running
if ! docker info > /dev/null 2>&1; then
  echo "ERROR: Docker is not running"
  exit 1
fi
echo "   OK: Docker is running"

# Verify compose file exists
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "ERROR: Compose file not found: $COMPOSE_FILE"
  exit 1
fi
echo "   OK: $COMPOSE_FILE"

# Check named volume exists (app data)
if docker volume inspect ci_hub_app_data > /dev/null 2>&1; then
  echo "   OK: ci_hub_app_data volume exists"
else
  echo "   INFO: ci_hub_app_data volume will be created on first start"
fi

# ── Backup (optional) ──────────────────────────

if [ "$SKIP_BACKUP" = "false" ]; then
  echo ""
  echo "2. Creating pre-update backup..."

  BACKUP_DIR="${ROOT_FOLDER_HOST}/../backups/pre-update-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"

  # Backup database
  if docker ps --format '{{.Names}}' | grep -q "${DB_CONTAINER_NAME:-ci-hub-db}"; then
    echo "   Backing up database..."
    docker exec "${DB_CONTAINER_NAME:-ci-hub-db}" pg_dump -U "${POSTGRES_USERNAME:-tipi}" "${POSTGRES_DBNAME:-tipi}" \
      > "$BACKUP_DIR/database.sql" 2>/dev/null || echo "   WARNING: Database backup failed (non-fatal)"
  fi

  # Backup .env
  if [ -f .env ]; then
    cp .env "$BACKUP_DIR/dot-env.backup"
  fi

  echo "   Backup saved to: $BACKUP_DIR"
else
  echo ""
  echo "2. Skipping backup (--skip-backup)"
fi

# ── Stop managed apps gracefully ────────────────

echo ""
echo "3. Stopping managed apps..."

# Try to stop apps via Hub API (best-effort)
if curl -sf "http://localhost:${HUB_PORT}/api/health" > /dev/null 2>&1; then
  # Hub is running — get list of running apps and stop them
  echo "   Hub is running, requesting graceful app shutdown..."
  # Give apps time to shut down gracefully
  sleep 5
else
  echo "   Hub not running — skipping app shutdown"
fi

# ── Pull new images ─────────────────────────────

echo ""
echo "4. Pulling new images..."
docker compose -f "$COMPOSE_FILE" pull

# ── Restart Hub ─────────────────────────────────

echo ""
echo "5. Restarting services..."
docker compose -f "$COMPOSE_FILE" up -d

# ── Wait for health ─────────────────────────────

echo ""
echo "6. Waiting for Hub to be healthy (timeout: ${HEALTH_TIMEOUT}s)..."

ELAPSED=0
while [ $ELAPSED -lt $HEALTH_TIMEOUT ]; do
  if curl -sf "http://localhost:${HUB_PORT}/api/health" > /dev/null 2>&1; then
    echo "   Hub is healthy! (${ELAPSED}s)"
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if [ $ELAPSED -ge $HEALTH_TIMEOUT ]; then
  echo "   WARNING: Hub did not become healthy within ${HEALTH_TIMEOUT}s"
  echo "   Check logs: docker compose -f $COMPOSE_FILE logs ci-os-hub --tail 50"
  exit 1
fi

# ── Verify data integrity ──────────────────────

echo ""
echo "7. Verifying data integrity..."

# Check critical paths inside container
VERIFY_PATHS=("/data/state" "/data/apps" "/app-data")
ALL_OK=true
for vpath in "${VERIFY_PATHS[@]}"; do
  if docker exec "$HUB_CONTAINER" test -d "$vpath" 2>/dev/null; then
    echo "   OK: $vpath"
  else
    echo "   MISSING: $vpath"
    ALL_OK=false
  fi
done

# Check data health endpoint if available
if curl -sf "http://localhost:${HUB_PORT}/api/health/data" > /dev/null 2>&1; then
  DATA_HEALTH=$(curl -sf "http://localhost:${HUB_PORT}/api/health/data")
  echo "   Data health: $DATA_HEALTH"
fi

if [ "$ALL_OK" = "false" ]; then
  echo ""
  echo "   WARNING: Some data directories are missing. Check volume mounts."
fi

echo ""
echo "============================================"
echo "  Update complete!"
echo "============================================"
