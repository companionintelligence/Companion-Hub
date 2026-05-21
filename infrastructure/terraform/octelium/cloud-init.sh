#!/bin/bash
# cloud-init.sh - Cloud-init script for Octelium nodes
#
# This script is executed on each DigitalOcean droplet during first boot.
# It installs Docker, Octelium, and configures the cluster.

set -e

# Template variables (replaced by Terraform)
CLUSTER_NAME="${cluster_name}"
ADMIN_EMAIL="${admin_email}"
IS_FIRST_NODE="${is_first_node}"
CLUSTER_URL="${cluster_url}"
BOOTSTRAP_NODE="${bootstrap_node}"

echo "=== Octelium Node Setup ==="
echo "Cluster: $CLUSTER_NAME"
echo "First node: $IS_FIRST_NODE"

# Update system
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# Install Octelium
echo "Installing Octelium..."
curl -fsSL https://octelium.dev/install.sh | bash

# Wait for Octelium to be available
sleep 5

if [ "$IS_FIRST_NODE" = "true" ]; then
  echo "Initializing Octelium cluster (first node)..."

  # Initialize cluster
  octelium cluster init \
    --cluster-name "$CLUSTER_NAME" \
    --admin-email "$ADMIN_EMAIL" \
    --listen-address "0.0.0.0:443" \
    --wireguard-port 51820 \
    --output /root/octelium-bootstrap.txt

  echo "=== Cluster initialized ==="
  echo "Bootstrap token saved to: /root/octelium-bootstrap.txt"

  # Display bootstrap info
  cat /root/octelium-bootstrap.txt

else
  echo "Joining existing Octelium cluster..."

  # Wait for first node to be ready
  echo "Waiting for bootstrap node to be ready..."
  for i in {1..30}; do
    if nc -z "$BOOTSTRAP_NODE" 443 2>/dev/null; then
      echo "Bootstrap node is ready"
      break
    fi
    echo "Attempt $i/30: Bootstrap node not ready yet..."
    sleep 10
  done

  # Get bootstrap token from first node (via Terraform later)
  # For now, mark this for manual configuration
  echo "Node ready to join cluster"
  echo "Manual step required: Get bootstrap token from first node and run:"
  echo "  octelium cluster join --token <TOKEN> --cluster-url $CLUSTER_URL"
fi

# Enable Octelium service
systemctl enable octelium
systemctl start octelium

# Configure firewall
ufw --force enable
ufw allow 22/tcp
ufw allow 443/tcp
ufw allow 51820/udp

echo "=== Octelium node setup complete ==="
