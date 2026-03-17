#!/usr/bin/env bash
# Wipe all Hub containers, volumes, and state for a clean fresh start.
# Usage: ./scripts/dev-wipe.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Stopping all Hub containers..."
docker compose --project-name ci-hub -f docker-compose.prod.yml down --remove-orphans 2>/dev/null || true
docker compose --project-name ci-hub -f docker-compose.local.yml down --remove-orphans 2>/dev/null || true
# Legacy project name (pre-rename)
docker compose --project-name runtipi -f docker-compose.prod.yml down --remove-orphans 2>/dev/null || true

echo "Removing any leftover containers..."
docker rm -f ci-os-hub ci-os-hub-queue ci-hub-db headscale cloudflared traefik hub-tailscale 2>/dev/null || true

echo "Removing .internal state..."
sudo rm -rf .internal

echo "Pruning unused Docker images..."
docker image prune -af --filter 'label=ci-os-hub.managed=true' 2>/dev/null || true

echo "Done. Run ./scripts/dev-start.sh [env] to start fresh."
