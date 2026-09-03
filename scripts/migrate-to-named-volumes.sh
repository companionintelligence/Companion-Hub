#!/usr/bin/env bash
#
# Migrate CI-OS-Hub from bind mounts to named Docker volumes for app-data.
#
# This script copies data from the existing bind-mounted .internal/app-data
# directory into a named Docker volume (ci_hub_app_data), which survives
# container recreation and updates.
#
# Usage:
#   ./scripts/migrate-to-named-volumes.sh [--dry-run]
#
# The script is idempotent — safe to run multiple times.
# Original data in .internal/app-data is preserved as a backup.

set -o errexit
set -o nounset
set -o pipefail

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
  echo "=== DRY RUN MODE — no changes will be made ==="
  echo ""
fi

# Resolve ROOT_FOLDER_HOST
if [ -z "${ROOT_FOLDER_HOST:-}" ]; then
  if [ -f .env ]; then
    ROOT_FOLDER_HOST=$(grep -E '^ROOT_FOLDER_HOST=' .env | cut -d= -f2- || true)
  fi
fi

if [ -z "${ROOT_FOLDER_HOST:-}" ]; then
  # Fall back to .internal relative to CWD
  ROOT_FOLDER_HOST="$(pwd)/.internal"
  echo "WARNING: ROOT_FOLDER_HOST not set, using: $ROOT_FOLDER_HOST"
fi

SOURCE_APP_DATA="${ROOT_FOLDER_HOST}/app-data"

echo "============================================"
echo "  CI-OS-Hub: Migrate to Named Volumes"
echo "============================================"
echo ""
echo "Source: $SOURCE_APP_DATA"
echo "Target: Docker volume ci_hub_app_data"
echo ""

# Check if source exists and has data
if [ ! -d "$SOURCE_APP_DATA" ]; then
  echo "No existing app-data directory found at: $SOURCE_APP_DATA"
  echo "Nothing to migrate. If this is a fresh install, named volumes"
  echo "will be created automatically on first start."
  exit 0
fi

SOURCE_SIZE=$(du -sh "$SOURCE_APP_DATA" 2>/dev/null | cut -f1 || echo "unknown")
echo "Source size: $SOURCE_SIZE"

# Check if volume already exists and has data
VOLUME_EXISTS=false
VOLUME_HAS_DATA=false

if docker volume inspect ci_hub_app_data > /dev/null 2>&1; then
  VOLUME_EXISTS=true
  # Check if the volume has data (look for sentinel file)
  HAS_SENTINEL=$(docker run --rm -v ci_hub_app_data:/data alpine test -f /data/.ci-hub-initialized && echo "yes" || echo "no")
  if [ "$HAS_SENTINEL" = "yes" ]; then
    VOLUME_HAS_DATA=true
    echo ""
    echo "WARNING: ci_hub_app_data volume already exists and appears to have data."
    echo "         This migration will MERGE data into the existing volume."
    echo "         Existing files in the volume will NOT be overwritten."
    echo ""
    read -rp "Continue? [y/N] " confirm
    if [ "${confirm,,}" != "y" ]; then
      echo "Aborted."
      exit 0
    fi
  fi
fi

if [ "$DRY_RUN" = "true" ]; then
  echo ""
  echo "DRY RUN — would perform the following:"
  echo "  1. Stop Hub services"
  if [ "$VOLUME_EXISTS" = "false" ]; then
    echo "  2. Create Docker volume: ci_hub_app_data"
  else
    echo "  2. Volume ci_hub_app_data already exists"
  fi
  echo "  3. Copy $SOURCE_APP_DATA/* into ci_hub_app_data"
  echo "  4. Start Hub services with named volume"
  echo ""
  echo "No changes made."
  exit 0
fi

# Stop services
echo ""
echo "1. Stopping Hub services..."
docker compose down 2>/dev/null || true

# Create volume if needed
if [ "$VOLUME_EXISTS" = "false" ]; then
  echo ""
  echo "2. Creating Docker volume: ci_hub_app_data"
  docker volume create ci_hub_app_data
else
  echo ""
  echo "2. Volume ci_hub_app_data already exists"
fi

# Copy data into volume
echo ""
echo "3. Copying data into volume..."
echo "   Source: $SOURCE_APP_DATA"

if [ "$VOLUME_HAS_DATA" = "true" ]; then
  # Merge mode — don't overwrite existing files
  docker run --rm \
    -v "$SOURCE_APP_DATA:/source:ro" \
    -v ci_hub_app_data:/dest \
    alpine sh -c 'cp -an /source/. /dest/ 2>/dev/null; echo "Merge complete"'
else
  # Fresh copy
  docker run --rm \
    -v "$SOURCE_APP_DATA:/source:ro" \
    -v ci_hub_app_data:/dest \
    alpine sh -c 'cp -a /source/. /dest/ && echo "Copy complete"'
fi

# Verify
echo ""
echo "4. Verifying..."
DEST_SIZE=$(docker run --rm -v ci_hub_app_data:/data alpine du -sh /data 2>/dev/null | cut -f1 || echo "unknown")
echo "   Volume size: $DEST_SIZE"

DEST_FILES=$(docker run --rm -v ci_hub_app_data:/data alpine find /data -type f 2>/dev/null | wc -l || echo "unknown")
echo "   Files in volume: $DEST_FILES"

echo ""
echo "============================================"
echo "  Migration complete!"
echo "============================================"
echo ""
echo "Original data preserved at: $SOURCE_APP_DATA"
echo "You can remove it once you've verified the Hub works correctly:"
echo "  rm -rf $SOURCE_APP_DATA"
echo ""
echo "Start the Hub with: docker compose up -d"
