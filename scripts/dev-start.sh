#!/usr/bin/env bash
# Start Hub fresh. Wipes state first, then starts with the given env.
# Usage: ./scripts/dev-start.sh [env]   (env: dev|local|staging|prod, default: dev)
set -euo pipefail
cd "$(dirname "$0")/.."

ENV="${1:-dev}"

echo "Wiping previous state..."
./scripts/dev-wipe.sh

echo "Starting Hub with env: $ENV"
export PATH="$HOME/.bun/bin:$PATH"
bun start start "$ENV"
