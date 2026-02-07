#!/bin/bash
# Setup Docker Hub authentication on fleet servers
# 
# Prerequisites: 
#   1. Create a Docker Hub account (free tier: 200 pulls/6hr)
#   2. Generate an access token at https://hub.docker.com/settings/security
#   3. Run: DOCKER_USER=xxx DOCKER_TOKEN=xxx ./setup-docker-auth.sh
#
# For CI servers, store creds in GitHub Secrets:
#   DOCKER_USERNAME, DOCKER_TOKEN

set -e

if [ -z "$DOCKER_USER" ] || [ -z "$DOCKER_TOKEN" ]; then
    echo "Usage: DOCKER_USER=xxx DOCKER_TOKEN=xxx $0"
    echo ""
    echo "To get a token:"
    echo "  1. Go to https://hub.docker.com/settings/security"
    echo "  2. Click 'New Access Token'"
    echo "  3. Name it 'CI Fleet' with Read-only permissions"
    exit 1
fi

SERVERS=(
    "100.108.17.53"   # core-1
    "100.101.156.33"  # core-2
    "100.108.125.105" # core-3
    "100.76.114.122"  # core-4
    "100.118.2.90"    # core-5
    "100.95.23.128"   # core-6
    "100.74.95.94"    # core-7
)

echo "Setting up Docker Hub auth on ${#SERVERS[@]} servers..."
echo ""

for i in "${!SERVERS[@]}"; do
    ip="${SERVERS[$i]}"
    name="core-$((i+1))"
    
    echo -n "$name ($ip): "
    
    ssh ci@$ip "echo '$DOCKER_TOKEN' | docker login -u '$DOCKER_USER' --password-stdin 2>&1" | tail -1
done

echo ""
echo "Done! Docker Hub auth configured on all servers."
echo "Rate limit increased to 200 pulls / 6 hours per authenticated user."
