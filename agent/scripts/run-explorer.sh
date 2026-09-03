#!/usr/bin/env bash
# run-explorer.sh — Run app-explorer for a given app name and trigger fix agent if degraded
#
# Usage: ./agent/scripts/run-explorer.sh "Activepieces"
#        ./agent/scripts/run-explorer.sh "Activepieces" --dry-run

set -e

APP_NAME="${1:-}"
DRY_RUN="${2:-}"

if [ -z "$APP_NAME" ]; then
  echo "Usage: $0 <app-name> [--dry-run]"
  exit 1
fi

COMPANION_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HUB_DIR="$COMPANION_DIR/ci-hub"
DATE=$(date +%Y-%m-%d)

export APP_NAME
export REPORT_DIR="$COMPANION_DIR/reports"
export SCREENSHOT_DIR="$COMPANION_DIR/screenshots/$DATE"
export EXPLORE_MINUTES="${EXPLORE_MINUTES:-5}"

mkdir -p "$REPORT_DIR" "$SCREENSHOT_DIR"

echo "══════════════════════════════════════"
echo "  App Explorer: $APP_NAME"
echo "  Date: $DATE"
echo "══════════════════════════════════════"

# Run the Playwright test
cd "$HUB_DIR"
npx playwright test e2e/app-explorer.spec.ts \
  --reporter=list \
  --timeout=600000 \
  2>&1 | tee "$COMPANION_DIR/logs/explorer-$(echo "$APP_NAME" | tr ' ' '-' | tr '[:upper:]' '[:lower:]')-$DATE.log"

EXIT_CODE=$?

echo ""
echo "── Explorer complete (exit: $EXIT_CODE)"

# Check if a fix request was generated
FIX_REQUESTS=$(ls "$REPORT_DIR"/fix-request-*.json 2>/dev/null | wc -l)

if [ "$FIX_REQUESTS" -gt 0 ]; then
  echo "── $FIX_REQUESTS fix request(s) queued"
  if [ "$DRY_RUN" = "--dry-run" ]; then
    echo "── [DRY RUN] Skipping fix agent"
  else
    echo "── Running fix agent..."
    cd "$COMPANION_DIR"
    DRY_RUN=false OPENAI_API_KEY="$OPENAI_API_KEY" npx ts-node agent/fix-agent.ts
  fi
else
  echo "── No fix requests — app is healthy"
fi

echo ""
echo "Reports: $REPORT_DIR"
echo "Screenshots: $SCREENSHOT_DIR"
echo "Status dashboard: http://localhost:3099"
