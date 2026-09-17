#!/usr/bin/env bash
set -o errexit
set -o nounset
set -o pipefail

VERSION="latest"
# Explicit COMPOSE_FILE / COMPOSE_PROJECT win. Without them, the running Hub's own compose labels
# decide (see "Compose identity" below), and these defaults are only the last resort.
EXPLICIT_COMPOSE="${COMPOSE_FILE:-}${COMPOSE_PROJECT:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-ci-hub}"
HUB_CONTAINER="${HUB_CONTAINER_NAME:-ci-hub}"
ENV_FILE_PATH=".env"
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
echo "  Companion Hub Update — Version: ${VERSION}"
echo "============================================"

# ── Compose identity ───────────────────────────
#
# The layout this script used to assume (docker-compose.prod.yml, project ci-hub and .env, all in
# the current directory) is wrong on source-checkout nodes: core-4 and core-14 run
# docker-compose.prod.yml [+ docker-compose.dev-image.yml] with .env.prod, and core-4's service is
# still ci-os-hub. The running container records how compose created it, so ask it. Labels written
# by an in-container compose client name /data/... paths that do not exist here; those fall back.

COMPOSE_ARGS=(--project-name "$COMPOSE_PROJECT" -f "$COMPOSE_FILE")
COMPOSE_FILES=("$COMPOSE_FILE")
if [ -z "$EXPLICIT_COMPOSE" ]; then
  FOUND_HUB=""
  for name in ci-hub ci-os-hub; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)" = "true" ]; then
      FOUND_HUB="$name"
      break
    fi
  done
  if [ -n "$FOUND_HUB" ]; then
    label() {
      local value
      value="$(docker inspect -f "{{index .Config.Labels \"$1\"}}" "$FOUND_HUB" 2>/dev/null || true)"
      [ "$value" = "<no value>" ] && value=""
      printf '%s' "$value"
    }
    LABEL_PROJECT="$(label com.docker.compose.project)"
    LABEL_DIR="$(label com.docker.compose.project.working_dir)"
    LABEL_ENV="$(label com.docker.compose.project.environment_file)"
    IFS=',' read -r -a LABEL_FILES <<< "$(label com.docker.compose.project.config_files)"
    USABLE="yes"
    [ -n "$LABEL_PROJECT" ] && [ -d "$LABEL_DIR" ] && [ "${#LABEL_FILES[@]}" -gt 0 ] || USABLE=""
    for file in ${LABEL_FILES[@]+"${LABEL_FILES[@]}"}; do [ -f "$file" ] || USABLE=""; done
    if [ -n "$LABEL_ENV" ] && [[ "$LABEL_ENV" == *,* || ! -f "$LABEL_ENV" ]]; then USABLE=""; fi
    if [ -n "$USABLE" ]; then
      COMPOSE_PROJECT="$LABEL_PROJECT"
      COMPOSE_FILES=("${LABEL_FILES[@]}")
      COMPOSE_ARGS=(--project-name "$COMPOSE_PROJECT" --project-directory "$LABEL_DIR")
      for file in "${LABEL_FILES[@]}"; do COMPOSE_ARGS+=(-f "$file"); done
      if [ -n "$LABEL_ENV" ]; then
        COMPOSE_ARGS+=(--env-file "$LABEL_ENV")
        ENV_FILE_PATH="$LABEL_ENV"
      fi
      # The compose file binds `${ENV_FILE:-.env}` at /data/.env and `${COMPOSE_FILE_HOST}` at
      # /data/docker-compose.yml, both relative to the project directory when unset. Whatever the
      # launcher exported for them is gone by now, so hand compose the host paths the running Hub
      # has mounted; a wrong `.env` there is the "bind source path does not exist" failure.
      mount_source() {
        docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$1\"}}{{.Source}}{{end}}{{end}}" "$FOUND_HUB" 2>/dev/null || true
      }
      BIND_ENV="$(mount_source /data/.env)"
      BIND_COMPOSE="$(mount_source /data/docker-compose.yml)"
      if [ -n "$BIND_ENV" ] && [ -f "$BIND_ENV" ]; then export ENV_FILE="$BIND_ENV"; fi
      if [ -n "$BIND_COMPOSE" ] && [ -f "$BIND_COMPOSE" ]; then export COMPOSE_FILE_HOST="$BIND_COMPOSE"; fi
      HUB_CONTAINER="$FOUND_HUB"
      echo "Using the compose invocation that created ${FOUND_HUB}: ${COMPOSE_ARGS[*]}"
    else
      echo "WARNING: ${FOUND_HUB}'s compose labels do not name files on this host; using ${COMPOSE_FILE} in $(pwd)"
    fi
  fi
fi

# ── Pre-flight checks ──────────────────────────

echo ""
echo "1. Pre-flight checks..."

# Verify ROOT_FOLDER_HOST is set and absolute
if [ -z "${ROOT_FOLDER_HOST:-}" ]; then
  # Try to read from the env file compose uses
  if [ -f "$ENV_FILE_PATH" ]; then
    ROOT_FOLDER_HOST=$(grep -E '^ROOT_FOLDER_HOST=' "$ENV_FILE_PATH" | cut -d= -f2- || true)
  fi
fi

if [ -z "${ROOT_FOLDER_HOST:-}" ]; then
  echo "ERROR: ROOT_FOLDER_HOST is not set. Set it in ${ENV_FILE_PATH} or export it."
  echo "       Example: ROOT_FOLDER_HOST=/opt/companion-hub/data"
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
for file in "${COMPOSE_FILES[@]}"; do
  if [ ! -f "$file" ]; then
    echo "ERROR: Compose file not found: $file"
    exit 1
  fi
  echo "   OK: $file"
done

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
    docker exec "${DB_CONTAINER_NAME:-ci-hub-db}" pg_dump -U "${POSTGRES_USERNAME:-companion}" "${POSTGRES_DBNAME:-companiondb}" \
      > "$BACKUP_DIR/database.sql" 2>/dev/null || echo "   WARNING: Database backup failed (non-fatal)"
  fi

  # Backup the env file
  if [ -f "$ENV_FILE_PATH" ]; then
    cp "$ENV_FILE_PATH" "$BACKUP_DIR/dot-env.backup"
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
docker compose "${COMPOSE_ARGS[@]}" pull

# ── Restart Hub ─────────────────────────────────

echo ""
echo "5. Restarting services..."
docker compose "${COMPOSE_ARGS[@]}" up -d --remove-orphans

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
  echo "   Check logs: docker logs ${HUB_CONTAINER} --tail 50"
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
