#!/bin/bash

# Configuration
ALTS_FILE="packages/frontend/src/lib/data/alts.json"
APP_STORE_DIR="../CI-App-Store/apps"
VERIFY_SCRIPT="scripts/verify-app.ts"

# Check dependencies
if ! command -v jq &> /dev/null; then
    echo "Error: jq is required but not installed."
    exit 1
fi

if [ ! -f "$ALTS_FILE" ]; then
    echo "Error: alts.json not found at $ALTS_FILE"
    exit 1
fi

if [ ! -f "$VERIFY_SCRIPT" ]; then
    echo "Error: verify-app.ts not found at $VERIFY_SCRIPT"
    exit 1
fi

# Extract slugs
echo "Reading app configuration from $ALTS_FILE..."
# jq command finds all 'appSlug' values recursively
SLUGS=$(jq -r '.. | .appSlug? | select(. != null)' "$ALTS_FILE" | sort | uniq)
COUNT=$(echo "$SLUGS" | wc -l | xargs)

echo "Found $COUNT unique app slugs in alts.json."
echo "Checking against App Store at $APP_STORE_DIR..."
echo "-----------------------------------"

FAILED_APPS=()
SUCCESS_APPS=()
SKIPPED_APPS=()

for slug in $SLUGS; do
    # Trim whitespace just in case
    slug=$(echo "$slug" | xargs)
    APP_PATH="$APP_STORE_DIR/$slug"
    
    if [ -d "$APP_PATH" ]; then
        echo -e "\n🔍 \033[1mVerifying $slug...\033[0m"
        
        # Run the verification script
        if bun "$VERIFY_SCRIPT" "$APP_PATH"; then
            echo "✅ $slug passed"
            SUCCESS_APPS+=("$slug")
        else
            echo "❌ $slug failed"
            FAILED_APPS+=("$slug")
        fi
    else
        echo "⚠️  Skipping $slug (not found in App Store)"
        SKIPPED_APPS+=("$slug")
    fi
done

echo "-----------------------------------"
echo "SUMMARY"
echo "-----------------------------------"
echo "✅ Passed (${#SUCCESS_APPS[@]}): ${SUCCESS_APPS[*]}"
echo "⚠️  Skipped (${#SKIPPED_APPS[@]}): ${SKIPPED_APPS[*]}"
echo "❌ Failed (${#FAILED_APPS[@]}): ${FAILED_APPS[*]}"

if [ ${#FAILED_APPS[@]} -ne 0 ]; then
    exit 1
else
    echo "All tested apps passed!"
    exit 0
fi
