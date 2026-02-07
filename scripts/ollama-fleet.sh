#!/bin/bash
# Ollama Fleet Manager
# Manages Ollama installation, updates, and model sync across server fleet
# Usage: ./ollama-fleet.sh <command> [options]
#
# Commands:
#   status    - Show Ollama version and models on all servers
#   update    - Update Ollama to latest version on all servers
#   sync      - Sync models from source server to all others
#   pull      - Pull a model on all servers
#   check     - Check for outdated Ollama or models

set -e

# Server fleet (Tailscale IPs)
SERVERS=(
  "100.108.17.53:core-1"
  "100.101.156.33:core-2"
  "100.108.125.105:core-3"
  "100.76.114.122:core-4"
  "100.118.2.90:core-5"
  "100.95.23.128:core-6"
  "100.74.95.94:core-7"
)

# Model source server (has most models)
MODEL_SOURCE="100.118.2.90"
MODEL_SOURCE_NAME="core-5"

# Standard models to ensure on all servers
STANDARD_MODELS=(
  "qwen3:32b"
  "gemma3:1b"
  "nomic-embed-text:latest"
)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_header() {
  echo "╔════════════════════════════════════════════════════════════════════╗"
  echo "║  Ollama Fleet Manager                                              ║"
  echo "╚════════════════════════════════════════════════════════════════════╝"
}

cmd_status() {
  print_header
  echo ""
  echo "Checking Ollama status across fleet..."
  echo ""
  
  # Get latest version
  LATEST=$(curl -s https://api.github.com/repos/ollama/ollama/releases/latest | grep '"tag_name"' | sed 's/.*"v\(.*\)".*/\1/')
  echo "Latest Ollama version: $LATEST"
  echo ""
  
  printf "%-10s %-12s %-8s %s\n" "SERVER" "VERSION" "STATUS" "MODELS"
  printf "%-10s %-12s %-8s %s\n" "------" "-------" "------" "------"
  
  for entry in "${SERVERS[@]}"; do
    ip=$(echo $entry | cut -d: -f1)
    name=$(echo $entry | cut -d: -f2)
    
    result=$(ssh -o ConnectTimeout=5 ci@$ip "
      ver=\$(ollama --version 2>/dev/null | awk '{print \$NF}')
      models=\$(ollama list 2>/dev/null | tail -n +2 | awk '{print \$1}' | tr '\n' ' ')
      echo \"\$ver|\$models\"
    " 2>/dev/null || echo "error|")
    
    ver=$(echo $result | cut -d'|' -f1)
    models=$(echo $result | cut -d'|' -f2)
    
    if [ "$ver" = "$LATEST" ]; then
      status="${GREEN}✓${NC}"
    elif [ "$ver" = "error" ]; then
      status="${RED}✗${NC}"
    else
      status="${YELLOW}↑${NC}"
    fi
    
    printf "%-10s %-12s %-8b %s\n" "$name" "$ver" "$status" "$models"
  done
  
  echo ""
  echo "Legend: ${GREEN}✓${NC} = Current  ${YELLOW}↑${NC} = Update available  ${RED}✗${NC} = Error"
}

cmd_update() {
  print_header
  echo ""
  echo "Updating Ollama on all servers..."
  echo ""
  
  for entry in "${SERVERS[@]}"; do
    ip=$(echo $entry | cut -d: -f1)
    name=$(echo $entry | cut -d: -f2)
    
    echo "[$name] Updating..."
    
    # Use root to update (ollama install requires sudo)
    sshpass -p "foxtrot1234" ssh -o StrictHostKeyChecking=no root@$ip "
      curl -fsSL https://ollama.com/install.sh | sh
    " 2>&1 | tail -3 &
  done
  
  wait
  echo ""
  echo "Update complete. Run 'status' to verify."
}

cmd_sync() {
  print_header
  echo ""
  echo "Syncing models from $MODEL_SOURCE_NAME ($MODEL_SOURCE)..."
  echo ""
  
  # Get models from source
  SOURCE_MODELS=$(ssh ci@$MODEL_SOURCE "ollama list 2>/dev/null | tail -n +2 | awk '{print \$1}'" 2>/dev/null)
  echo "Source models: $SOURCE_MODELS"
  echo ""
  
  for entry in "${SERVERS[@]}"; do
    ip=$(echo $entry | cut -d: -f1)
    name=$(echo $entry | cut -d: -f2)
    
    # Skip source server
    if [ "$ip" = "$MODEL_SOURCE" ]; then
      echo "[$name] Skipping (source server)"
      continue
    fi
    
    echo "[$name] Checking models..."
    
    # Get target's current models
    TARGET_MODELS=$(ssh ci@$ip "ollama list 2>/dev/null | tail -n +2 | awk '{print \$1}'" 2>/dev/null)
    
    for model in $SOURCE_MODELS; do
      if echo "$TARGET_MODELS" | grep -q "^$model$"; then
        echo "  ✓ $model (exists)"
      else
        echo "  ↓ $model (pulling in background...)"
        ssh ci@$ip "nohup ollama pull $model > /tmp/ollama-pull-$model.log 2>&1 &" &
      fi
    done
  done
  
  wait
  echo ""
  echo "Model sync initiated. Large models may take 10-30 minutes."
}

cmd_pull() {
  MODEL="$1"
  if [ -z "$MODEL" ]; then
    echo "Usage: $0 pull <model>"
    echo "Example: $0 pull qwen3:32b"
    exit 1
  fi
  
  print_header
  echo ""
  echo "Pulling $MODEL on all servers..."
  echo ""
  
  for entry in "${SERVERS[@]}"; do
    ip=$(echo $entry | cut -d: -f1)
    name=$(echo $entry | cut -d: -f2)
    
    echo "[$name] Pulling $MODEL..."
    ssh ci@$ip "nohup ollama pull $MODEL > /tmp/ollama-pull.log 2>&1 &" &
  done
  
  wait
  echo ""
  echo "Pull initiated on all servers. Check progress with:"
  echo "  ssh ci@<server> 'tail -f /tmp/ollama-pull.log'"
}

cmd_check() {
  print_header
  echo ""
  
  # Check Ollama version
  LATEST=$(curl -s https://api.github.com/repos/ollama/ollama/releases/latest | grep '"tag_name"' | sed 's/.*"v\(.*\)".*/\1/')
  echo "Latest Ollama version: $LATEST"
  echo ""
  
  OUTDATED_OLLAMA=0
  MISSING_MODELS=0
  
  for entry in "${SERVERS[@]}"; do
    ip=$(echo $entry | cut -d: -f1)
    name=$(echo $entry | cut -d: -f2)
    
    ver=$(ssh -o ConnectTimeout=5 ci@$ip "ollama --version 2>/dev/null | awk '{print \$NF}'" 2>/dev/null)
    
    if [ "$ver" != "$LATEST" ]; then
      echo "${YELLOW}⚠${NC} $name: Ollama $ver (latest: $LATEST)"
      OUTDATED_OLLAMA=$((OUTDATED_OLLAMA + 1))
    fi
    
    # Check standard models
    for model in "${STANDARD_MODELS[@]}"; do
      has_model=$(ssh ci@$ip "ollama list 2>/dev/null | grep -c '^$model'" 2>/dev/null || echo "0")
      if [ "$has_model" = "0" ]; then
        echo "${YELLOW}⚠${NC} $name: Missing model $model"
        MISSING_MODELS=$((MISSING_MODELS + 1))
      fi
    done
  done
  
  echo ""
  if [ $OUTDATED_OLLAMA -eq 0 ] && [ $MISSING_MODELS -eq 0 ]; then
    echo "${GREEN}✓${NC} All servers up to date with standard models"
  else
    echo "Summary: $OUTDATED_OLLAMA outdated Ollama, $MISSING_MODELS missing models"
    echo ""
    echo "Run './ollama-fleet.sh update' to update Ollama"
    echo "Run './ollama-fleet.sh sync' to sync models"
  fi
}

# Main
case "${1:-status}" in
  status) cmd_status ;;
  update) cmd_update ;;
  sync) cmd_sync ;;
  pull) cmd_pull "$2" ;;
  check) cmd_check ;;
  *)
    echo "Ollama Fleet Manager"
    echo ""
    echo "Usage: $0 <command>"
    echo ""
    echo "Commands:"
    echo "  status  - Show Ollama version and models on all servers"
    echo "  update  - Update Ollama to latest version on all servers"
    echo "  sync    - Sync models from source server to all others"
    echo "  pull    - Pull a model on all servers"
    echo "  check   - Check for outdated Ollama or models"
    ;;
esac
