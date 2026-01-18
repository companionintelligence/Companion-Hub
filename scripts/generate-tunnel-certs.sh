#!/bin/bash
set -e

# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Go to the root of CI-OS-Hub
cd "$SCRIPT_DIR/.."

# Directory for generated certs
CERT_DIR="tunnel/certs"
mkdir -p "$CERT_DIR"

echo "Generating Custom CA Certificate in $CERT_DIR..."

# 1. Generate Private Key
openssl genrsa -out "$CERT_DIR/custom-ca.key" 2048

# 2. Generate Root CA Certificate (Self-Signed)
openssl req -x509 -new -nodes -key "$CERT_DIR/custom-ca.key" \
  -sha256 -days 3650 -out "$CERT_DIR/custom-ca.pem" \
  -subj "/C=US/ST=State/L=City/O=CompanionIntelligence/OU=LocalDev/CN=CI-Local-Root-CA"

echo "✅ Generated $CERT_DIR/custom-ca.pem"
chmod 644 "$CERT_DIR/custom-ca.pem"
chmod 600 "$CERT_DIR/custom-ca.key"
