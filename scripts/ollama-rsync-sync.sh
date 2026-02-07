#!/bin/bash
# Ollama Rsync Sync - Direct LAN model transfer
# Syncs model blobs directly over LAN using rsync (~10Gb/s)
#
# Usage:
#   ./ollama-rsync-sync.sh status              # Show models on all servers
#   ./ollama-rsync-sync.sh sync <target>       # Sync to one server
#   ./ollama-rsync-sync.sh sync-all            # Sync to all servers
#   ./ollama-rsync-sync.sh diff <target>       # Show what would sync

set -e

# Configuration
SOURCE_IP="100.118.2.90"  # core-5 (has most models)
SOURCE_NAME="core-5"
OLLAMA_DIR="/usr/share/ollama/.ollama"
ROOT_PASS="foxtrot1234"

# All target servers
TARGETS=(
  "100.108.17.53:core-1"
  "100.101.156.33:core-2"
  "100.108.125.105:core-3"
  "100.76.114.122:core-4"
  "100.95.23.128:core-6"
  "100.74.95.94:core-7"
)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_header() {
  echo "╔════════════════════════════════════════════════════════════════════╗"
  echo "║  Ollama Rsync Sync - LAN Model Transfer                            ║"
  echo "╚════════════════════════════════════════════════════════════════════╝"
}

cmd_status() {
  print_header
  echo ""
  echo "Source: $SOURCE_NAME ($SOURCE_IP)"
  echo ""
  
  # Get source info
  echo "Source models:"
  ssh ci@$SOURCE_IP "ollama list 2>/dev/null" | head -10
  SOURCE_SIZE=$(ssh ci@$SOURCE_IP "du -sh $OLLAMA_DIR/models 2>/dev/null | cut -f1")
  echo ""
  echo "Total size: $SOURCE_SIZE"
  echo ""
  
  printf "%-10s %-10s %s\n" "SERVER" "SIZE" "MODELS"
  printf "%-10s %-10s %s\n" "------" "----" "------"
  
  for entry in "${TARGETS[@]}"; do
    ip=$(echo $entry | cut -d: -f1)
    name=$(echo $entry | cut -d: -f2)
    
    result=$(ssh -o ConnectTimeout=5 ci@$ip "
      size=\$(du -sh $OLLAMA_DIR/models 2>/dev/null | cut -f1 || echo '0')
      models=\$(ollama list 2>/dev/null | tail -n +2 | wc -l)
      echo \"\$size|\$models\"
    " 2>/dev/null || echo "error|0")
    
    size=$(echo $result | cut -d'|' -f1)
    models=$(echo $result | cut -d'|' -f2)
    
    printf "%-10s %-10s %s models\n" "$name" "$size" "$models"
  done
}

cmd_diff() {
  TARGET_IP="$1"
  if [ -z "$TARGET_IP" ]; then
    echo "Usage: $0 diff <target_ip>"
    exit 1
  fi
  
  print_header
  echo ""
  echo "Comparing $SOURCE_IP -> $TARGET_IP"
  echo ""
  
  # Dry-run rsync to show what would transfer
  ssh ci@$SOURCE_IP "rsync -avzn --stats $OLLAMA_DIR/models/ ci@$TARGET_IP:$OLLAMA_DIR/models/" 2>&1 | tail -20
}

sync_to_target() {
  local ip="$1"
  local name="$2"
  
  echo ""
  echo "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo "Syncing to ${YELLOW}$name${NC} ($ip)"
  echo "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  
  # Stop ollama on target
  echo "  Stopping Ollama on target..."
  sshpass -p "$ROOT_PASS" ssh -o StrictHostKeyChecking=no root@$ip "systemctl stop ollama" 2>/dev/null || true
  
  # Get initial size
  BEFORE=$(ssh ci@$ip "du -sb $OLLAMA_DIR/models 2>/dev/null | cut -f1 || echo 0" 2>/dev/null)
  
  # Rsync with progress
  echo "  Syncing models..."
  START=$(date +%s)
  
  ssh ci@$SOURCE_IP "rsync -avz --progress --stats $OLLAMA_DIR/models/ ci@$ip:$OLLAMA_DIR/models/" 2>&1 | grep -E "(sent|total size|speedup)"
  
  END=$(date +%s)
  ELAPSED=$((END - START))
  
  # Get final size
  AFTER=$(ssh ci@$ip "du -sb $OLLAMA_DIR/models 2>/dev/null | cut -f1 || echo 0" 2>/dev/null)
  TRANSFERRED=$(( (AFTER - BEFORE) / 1024 / 1024 ))
  
  # Fix permissions
  echo "  Fixing permissions..."
  sshpass -p "$ROOT_PASS" ssh root@$ip "chown -R ollama:ollama $OLLAMA_DIR" 2>/dev/null || true
  
  # Start ollama
  echo "  Starting Ollama..."
  sshpass -p "$ROOT_PASS" ssh root@$ip "systemctl start ollama" 2>/dev/null || true
  
  # Verify
  sleep 2
  MODELS=$(ssh ci@$ip "ollama list 2>/dev/null | tail -n +2 | wc -l" 2>/dev/null || echo "?")
  
  echo ""
  echo "  ${GREEN}✓${NC} Complete: $MODELS models, ${TRANSFERRED}MB transferred in ${ELAPSED}s"
}

cmd_sync() {
  TARGET_IP="$1"
  if [ -z "$TARGET_IP" ]; then
    echo "Usage: $0 sync <target_ip>"
    exit 1
  fi
  
  print_header
  
  # Find name for IP
  TARGET_NAME="$TARGET_IP"
  for entry in "${TARGETS[@]}"; do
    ip=$(echo $entry | cut -d: -f1)
    name=$(echo $entry | cut -d: -f2)
    if [ "$ip" = "$TARGET_IP" ]; then
      TARGET_NAME="$name"
      break
    fi
  done
  
  sync_to_target "$TARGET_IP" "$TARGET_NAME"
}

cmd_sync_all() {
  print_header
  echo ""
  echo "Source: $SOURCE_NAME ($SOURCE_IP)"
  
  # Show source models
  echo "Source models:"
  ssh ci@$SOURCE_IP "ollama list" 2>/dev/null
  echo ""
  
  # Sync to each target
  for entry in "${TARGETS[@]}"; do
    ip=$(echo $entry | cut -d: -f1)
    name=$(echo $entry | cut -d: -f2)
    sync_to_target "$ip" "$name"
  done
  
  echo ""
  echo "${GREEN}All servers synced!${NC}"
}

# Main
case "${1:-help}" in
  status) cmd_status ;;
  diff) cmd_diff "$2" ;;
  sync) cmd_sync "$2" ;;
  sync-all) cmd_sync_all ;;
  *)
    echo "Ollama Rsync Sync - Direct LAN Model Transfer"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  status              Show models on all servers"
    echo "  diff <target_ip>    Show what would sync to target"
    echo "  sync <target_ip>    Sync to one server"
    echo "  sync-all            Sync to all servers"
    echo ""
    echo "Source: $SOURCE_NAME ($SOURCE_IP)"
    echo ""
    echo "Example:"
    echo "  $0 sync 100.108.17.53    # Sync to core-1"
    echo "  $0 sync-all               # Sync to all servers"
    ;;
esac
