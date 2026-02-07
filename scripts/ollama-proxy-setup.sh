#!/bin/bash
# Configure Ollama to use Squid Proxy Cache
# This makes model downloads go through the cache on core-1
#
# Usage:
#   ./ollama-proxy-setup.sh status      # Check proxy status
#   ./ollama-proxy-setup.sh enable      # Enable proxy on all servers
#   ./ollama-proxy-setup.sh disable     # Disable proxy on all servers
#   ./ollama-proxy-setup.sh test        # Test proxy connectivity

set -e

# Proxy server
PROXY_HOST="100.108.17.53"
PROXY_PORT="3128"
PROXY_URL="http://$PROXY_HOST:$PROXY_PORT"

# Root password for systemd changes
ROOT_PASS="foxtrot1234"

# All servers (including proxy host for completeness)
SERVERS=(
  "100.108.17.53:core-1"
  "100.101.156.33:core-2"
  "100.108.125.105:core-3"
  "100.76.114.122:core-4"
  "100.118.2.90:core-5"
  "100.95.23.128:core-6"
  "100.74.95.94:core-7"
)

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_header() {
  echo "╔════════════════════════════════════════════════════════════════════╗"
  echo "║  Ollama Proxy Configuration                                        ║"
  echo "╚════════════════════════════════════════════════════════════════════╝"
}

cmd_status() {
  print_header
  echo ""
  echo "Proxy: $PROXY_URL"
  echo ""
  
  # Check if squid is running on proxy host
  SQUID_STATUS=$(ssh ci@$PROXY_HOST "systemctl is-active squid 2>/dev/null || echo 'inactive'" 2>/dev/null)
  if [ "$SQUID_STATUS" = "active" ]; then
    echo "Squid proxy: ${GREEN}Running${NC}"
    CACHE_SIZE=$(ssh ci@$PROXY_HOST "du -sh /var/spool/squid 2>/dev/null | cut -f1 || echo 'unknown'" 2>/dev/null)
    echo "Cache size: $CACHE_SIZE"
  else
    echo "Squid proxy: ${RED}Not running${NC}"
  fi
  echo ""
  
  printf "%-10s %-15s %s\n" "SERVER" "PROXY STATUS" "OLLAMA"
  printf "%-10s %-15s %s\n" "------" "------------" "------"
  
  for entry in "${SERVERS[@]}"; do
    ip=$(echo $entry | cut -d: -f1)
    name=$(echo $entry | cut -d: -f2)
    
    result=$(ssh -o ConnectTimeout=5 ci@$ip "
      # Check if proxy is configured in ollama service
      proxy=\$(grep -q 'HTTP_PROXY' /etc/systemd/system/ollama.service.d/proxy.conf 2>/dev/null && echo 'enabled' || echo 'disabled')
      ollama_status=\$(systemctl is-active ollama 2>/dev/null || echo 'unknown')
      echo \"\$proxy|\$ollama_status\"
    " 2>/dev/null || echo "error|error")
    
    proxy_status=$(echo $result | cut -d'|' -f1)
    ollama_status=$(echo $result | cut -d'|' -f2)
    
    if [ "$proxy_status" = "enabled" ]; then
      proxy_display="${GREEN}Enabled${NC}"
    else
      proxy_display="${YELLOW}Disabled${NC}"
    fi
    
    printf "%-10s %-15b %s\n" "$name" "$proxy_display" "$ollama_status"
  done
}

cmd_enable() {
  print_header
  echo ""
  echo "Enabling proxy on all servers..."
  echo ""
  
  for entry in "${SERVERS[@]}"; do
    ip=$(echo $entry | cut -d: -f1)
    name=$(echo $entry | cut -d: -f2)
    
    # Skip proxy host - it doesn't need proxy to itself
    if [ "$ip" = "$PROXY_HOST" ]; then
      echo "[$name] Skipping (proxy host)"
      continue
    fi
    
    echo "[$name] Configuring proxy..."
    
    sshpass -p "$ROOT_PASS" ssh -o StrictHostKeyChecking=no root@$ip "
      # Create systemd override directory
      mkdir -p /etc/systemd/system/ollama.service.d
      
      # Create proxy configuration
      cat > /etc/systemd/system/ollama.service.d/proxy.conf << EOF
[Service]
Environment=\"HTTP_PROXY=$PROXY_URL\"
Environment=\"HTTPS_PROXY=$PROXY_URL\"
Environment=\"NO_PROXY=localhost,127.0.0.1\"
EOF
      
      # Reload and restart
      systemctl daemon-reload
      systemctl restart ollama
      
      echo '  ✓ Proxy enabled'
    " 2>/dev/null || echo "  ✗ Failed"
  done
  
  echo ""
  echo "Done. Use 'status' to verify."
}

cmd_disable() {
  print_header
  echo ""
  echo "Disabling proxy on all servers..."
  echo ""
  
  for entry in "${SERVERS[@]}"; do
    ip=$(echo $entry | cut -d: -f1)
    name=$(echo $entry | cut -d: -f2)
    
    echo "[$name] Removing proxy config..."
    
    sshpass -p "$ROOT_PASS" ssh -o StrictHostKeyChecking=no root@$ip "
      # Remove proxy configuration
      rm -f /etc/systemd/system/ollama.service.d/proxy.conf
      
      # Reload and restart
      systemctl daemon-reload
      systemctl restart ollama
      
      echo '  ✓ Proxy disabled'
    " 2>/dev/null || echo "  ✗ Failed"
  done
  
  echo ""
  echo "Done."
}

cmd_test() {
  print_header
  echo ""
  echo "Testing proxy connectivity..."
  echo ""
  
  # Test from each server
  for entry in "${SERVERS[@]}"; do
    ip=$(echo $entry | cut -d: -f1)
    name=$(echo $entry | cut -d: -f2)
    
    result=$(ssh -o ConnectTimeout=5 ci@$ip "
      # Test proxy connection
      curl -s -o /dev/null -w '%{http_code}' --proxy $PROXY_URL http://ollama.ai --connect-timeout 5 2>/dev/null || echo 'failed'
    " 2>/dev/null || echo "ssh_failed")
    
    if [ "$result" = "200" ] || [ "$result" = "301" ] || [ "$result" = "302" ]; then
      echo "[$name] ${GREEN}✓${NC} Proxy reachable (HTTP $result)"
    elif [ "$result" = "failed" ]; then
      echo "[$name] ${RED}✗${NC} Proxy unreachable"
    else
      echo "[$name] ${YELLOW}?${NC} Unexpected response: $result"
    fi
  done
  
  echo ""
  echo "Cache stats:"
  ssh ci@$PROXY_HOST "squidclient -h localhost mgr:info 2>/dev/null | grep -E '(Request|Hit|Byte)' | head -10" 2>/dev/null || echo "Could not get cache stats"
}

# Main
case "${1:-help}" in
  status) cmd_status ;;
  enable) cmd_enable ;;
  disable) cmd_disable ;;
  test) cmd_test ;;
  *)
    echo "Ollama Proxy Configuration"
    echo ""
    echo "Usage: $0 <command>"
    echo ""
    echo "Commands:"
    echo "  status      Check proxy status on all servers"
    echo "  enable      Enable proxy on all servers"
    echo "  disable     Disable proxy on all servers"
    echo "  test        Test proxy connectivity"
    echo ""
    echo "Proxy: $PROXY_URL"
    echo ""
    echo "Benefits:"
    echo "  - First download goes to internet, gets cached"
    echo "  - Subsequent downloads served from LAN cache (10Gb/s)"
    echo "  - 200GB cache on core-1"
    ;;
esac
