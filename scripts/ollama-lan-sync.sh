#!/bin/bash
# Ollama Model LAN Sync
# Copies model blobs directly over LAN using rsync (much faster than re-downloading)
# Usage: ./ollama-lan-sync.sh [source_ip] [target_ip]

set -e

SOURCE_IP="${1:-100.118.2.90}"  # core-5 default
TARGET_IP="${2}"

# Ollama stores models in /usr/share/ollama/.ollama/models
OLLAMA_DIR="/usr/share/ollama/.ollama"

if [ -z "$TARGET_IP" ]; then
  echo "Ollama LAN Model Sync"
  echo ""
  echo "Usage: $0 <source_ip> <target_ip>"
  echo "       $0 <source_ip> all     # Sync to all servers"
  echo ""
  echo "Example: $0 100.118.2.90 100.108.17.53"
  echo ""
  echo "This copies model files directly over LAN (~10Gb/s) instead of"
  echo "re-downloading from the internet (~600Mb/s)."
  exit 1
fi

# All servers
ALL_SERVERS="100.108.17.53 100.101.156.33 100.108.125.105 100.76.114.122 100.95.23.128 100.74.95.94"

if [ "$TARGET_IP" = "all" ]; then
  TARGETS="$ALL_SERVERS"
else
  TARGETS="$TARGET_IP"
fi

echo "╔════════════════════════════════════════════════════════════════════╗"
echo "║  Ollama LAN Model Sync                                             ║"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo ""
echo "Source: $SOURCE_IP"
echo "Targets: $TARGETS"
echo ""

# Check source models
echo "Source models:"
ssh ci@$SOURCE_IP "ollama list" 2>/dev/null
echo ""

# Get source model directory size
SOURCE_SIZE=$(ssh ci@$SOURCE_IP "du -sh $OLLAMA_DIR/models 2>/dev/null | cut -f1" 2>/dev/null)
echo "Source model size: $SOURCE_SIZE"
echo ""

for TARGET in $TARGETS; do
  # Skip if target is source
  if [ "$TARGET" = "$SOURCE_IP" ]; then
    continue
  fi
  
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Syncing to $TARGET..."
  
  # Stop ollama on target to avoid file conflicts
  echo "  Stopping Ollama on target..."
  sshpass -p "foxtrot1234" ssh root@$TARGET "systemctl stop ollama" 2>/dev/null || true
  
  # Rsync models directory
  echo "  Syncing models (this may take a while for large models)..."
  ssh ci@$SOURCE_IP "rsync -avz --progress $OLLAMA_DIR/models/ ci@$TARGET:$OLLAMA_DIR/models/" 2>&1 | tail -5
  
  # Fix permissions
  echo "  Fixing permissions..."
  sshpass -p "foxtrot1234" ssh root@$TARGET "chown -R ollama:ollama $OLLAMA_DIR" 2>/dev/null || true
  
  # Restart ollama on target
  echo "  Starting Ollama on target..."
  sshpass -p "foxtrot1234" ssh root@$TARGET "systemctl start ollama" 2>/dev/null || true
  
  # Verify
  echo "  Verifying models..."
  ssh ci@$TARGET "ollama list" 2>/dev/null | head -5
  
  echo "  ✅ Done"
done

echo ""
echo "LAN sync complete!"
