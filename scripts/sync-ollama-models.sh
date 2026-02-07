#!/bin/bash
# Ollama Model Sync Script
# Syncs models from a source server to target servers
# Usage: ./sync-ollama-models.sh [source_ip] [target_ips...]

SOURCE_IP="${1:-100.118.2.90}"  # core-5 has most models
shift
TARGET_IPS="${@:-100.108.17.53 100.101.156.33 100.108.125.105 100.76.114.122 100.95.23.128 100.74.95.94}"

OLLAMA_DIR="/usr/share/ollama/.ollama"

echo "╔════════════════════════════════════════════════════════════════════╗"
echo "║             Ollama Model Sync                                      ║"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo "Source: $SOURCE_IP"
echo "Targets: $TARGET_IPS"
echo ""

# Get list of models from source
echo "Fetching model list from source..."
MODELS=$(ssh ci@$SOURCE_IP "ollama list 2>/dev/null | tail -n +2 | awk '{print \$1}'")
echo "Models available: $MODELS"
echo ""

for TARGET_IP in $TARGET_IPS; do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Syncing to $TARGET_IP..."
  
  # Check which models are missing on target
  TARGET_MODELS=$(ssh ci@$TARGET_IP "ollama list 2>/dev/null | tail -n +2 | awk '{print \$1}'" 2>/dev/null)
  
  for MODEL in $MODELS; do
    if echo "$TARGET_MODELS" | grep -q "^$MODEL$"; then
      echo "  ✅ $MODEL (already exists)"
    else
      echo "  📥 $MODEL (pulling...)"
      ssh ci@$TARGET_IP "ollama pull $MODEL" &
    fi
  done
done

wait
echo ""
echo "Done!"
