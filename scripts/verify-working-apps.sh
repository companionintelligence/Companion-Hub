#!/bin/bash

# Configuration
MD_FILE="../ALTERNATIVE_APPS.md"
APP_STORE_DIR="../CI-App-Store/apps"
VERIFY_SCRIPT="scripts/verify-app.ts"

# Check dependencies
if ! command -v grep &> /dev/null; then
    echo "Error: grep is required."
    exit 1
fi

if [ ! -f "$MD_FILE" ]; then
    echo "Error: Markdown file not found at $MD_FILE"
    exit 1
fi

if [ ! -f "$VERIFY_SCRIPT" ]; then
    echo "Error: verify-app.ts not found at $VERIFY_SCRIPT"
    exit 1
fi

echo "Reading working apps from $MD_FILE..."

# Extract slugs: - [x] Name (`slug`)
# We extract the content between (` and `)
SLUGS=$(grep "\- \[x\]" "$MD_FILE" | sed -n 's/.*(`\(.*\)`).*/\1/p')

COUNT=$(echo "$SLUGS" | wc -l | xargs)

echo "Found $COUNT working apps."
echo "-----------------------------------"

FAILED_APPS=()
SUCCESS_APPS=()

for slug in $SLUGS; do
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
        echo "⚠️  Skipping $slug (not found in App Store at $APP_PATH)"
    fi
done

echo "-----------------------------------"
echo "SUMMARY"
echo "-----------------------------------"
echo "✅ Passed (${#SUCCESS_APPS[@]}): ${SUCCESS_APPS[*]}"
echo "❌ Failed (${#FAILED_APPS[@]}): ${FAILED_APPS[*]}"

if [ ${#FAILED_APPS[@]} -ne 0 ]; then
    exit 1
else
    echo "All working apps verified!"
    exit 0
fi
