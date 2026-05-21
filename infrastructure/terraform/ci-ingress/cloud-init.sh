#!/bin/bash
# cloud-init.sh - Cloud-init script for CI Ingress VPS
#
# This script sets up:
# - WireGuard server for secure connectivity with CI-Hub devices
# - Caddy reverse proxy for HTTP/HTTPS routing
# - CI Ingress API for device registration and route management

set -e

# Template variables (replaced by Terraform)
INGRESS_DOMAIN="${ingress_domain}"
ADMIN_EMAIL="${admin_email}"
WIREGUARD_NETWORK="${wireguard_network}"
WIREGUARD_SERVER_IP="${wireguard_server_ip}"

echo "=== CI Ingress VPS Setup ==="
echo "Domain: $INGRESS_DOMAIN"
echo "WireGuard Network: $WIREGUARD_NETWORK"
echo "WireGuard Server IP: $WIREGUARD_SERVER_IP"

# Update system
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

# Install dependencies
apt-get install -y curl wget git jq wireguard wireguard-tools

# ============================================================================
# Configure WireGuard Server
# ============================================================================

echo "Configuring WireGuard server..."

# Generate WireGuard keypair
wg genkey | tee /etc/wireguard/privatekey | wg pubkey > /etc/wireguard/publickey
chmod 600 /etc/wireguard/privatekey

PRIVATE_KEY=$(cat /etc/wireguard/privatekey)
PUBLIC_KEY=$(cat /etc/wireguard/publickey)

# Create WireGuard configuration
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = $WIREGUARD_SERVER_IP/24
ListenPort = 51820
PrivateKey = $PRIVATE_KEY

# Enable IP forwarding
PostUp = sysctl -w net.ipv4.ip_forward=1
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT
PostUp = iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE

PostDown = iptables -D FORWARD -i wg0 -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

# Peers will be added dynamically via API
EOF

chmod 600 /etc/wireguard/wg0.conf

# Enable IP forwarding permanently
echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
sysctl -p

# Start and enable WireGuard
systemctl enable wg-quick@wg0
systemctl start wg-quick@wg0

echo "WireGuard server configured and started"
echo "Public Key: $PUBLIC_KEY"

# ============================================================================
# Install Caddy
# ============================================================================

echo "Installing Caddy..."

# Install Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# Create Caddy configuration
mkdir -p /etc/caddy/conf.d

cat > /etc/caddy/Caddyfile <<EOF
{
    email $ADMIN_EMAIL
    admin off
}

# Main ingress endpoint
$INGRESS_DOMAIN {
    # Health check
    handle /health {
        respond "OK" 200
    }

    # API endpoints
    handle /api/* {
        reverse_proxy localhost:8080
    }

    # Default: API documentation
    handle {
        respond "CI Ingress API" 200
    }
}

# Dynamic app routes (loaded from /etc/caddy/conf.d/*.caddy)
import /etc/caddy/conf.d/*.caddy
EOF

# Start and enable Caddy
systemctl enable caddy
systemctl restart caddy

echo "Caddy installed and configured"

# ============================================================================
# Install CI Ingress API
# ============================================================================

echo "Installing CI Ingress API..."

# Install Node.js (for API server)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Create CI Ingress API directory
mkdir -p /opt/ci-ingress-api
cd /opt/ci-ingress-api

# Create simple API server
cat > /opt/ci-ingress-api/server.js <<'EOFJS'
const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

const PORT = 8080;
const DEVICES_FILE = '/var/lib/ci-ingress/devices.json';
const ROUTES_FILE = '/var/lib/ci-ingress/routes.json';
const WG_CONFIG = '/etc/wireguard/wg0.conf';
const CADDY_CONF_DIR = '/etc/caddy/conf.d';

// Ensure data directories exist
fs.mkdirSync('/var/lib/ci-ingress', { recursive: true });

// Initialize data files
if (!fs.existsSync(DEVICES_FILE)) {
  fs.writeFileSync(DEVICES_FILE, JSON.stringify({}));
}
if (!fs.existsSync(ROUTES_FILE)) {
  fs.writeFileSync(ROUTES_FILE, JSON.stringify({}));
}

// Helper functions
function loadJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function addWireGuardPeer(deviceId, publicKey, allowedIP) {
  const peerConfig = `\n[Peer]\n# Device: ${deviceId}\nPublicKey = ${publicKey}\nAllowedIPs = ${allowedIP}/32\n`;
  fs.appendFileSync(WG_CONFIG, peerConfig);
  execSync('wg syncconf wg0 <(wg-quick strip wg0)', { shell: '/bin/bash' });
  console.log(`Added WireGuard peer: ${deviceId}`);
}

function removeWireGuardPeer(publicKey) {
  const config = fs.readFileSync(WG_CONFIG, 'utf-8');
  const lines = config.split('\n');
  const filtered = [];
  let skipUntilNextSection = false;

  for (const line of lines) {
    if (line.includes(`PublicKey = ${publicKey}`)) {
      skipUntilNextSection = true;
      continue;
    }
    if (skipUntilNextSection && line.startsWith('[')) {
      skipUntilNextSection = false;
    }
    if (!skipUntilNextSection) {
      filtered.push(line);
    }
  }

  fs.writeFileSync(WG_CONFIG, filtered.join('\n'));
  execSync('wg syncconf wg0 <(wg-quick strip wg0)', { shell: '/bin/bash' });
  console.log(`Removed WireGuard peer: ${publicKey}`);
}

function updateCaddyRoutes(deviceId, routes) {
  const caddyConfig = routes.map(route => `
${route.hostname} {
    reverse_proxy ${route.wireguardIP}:${route.localPort} {
        header_up Host ${route.originServerName}
    }
}
`).join('\n');

  fs.writeFileSync(`${CADDY_CONF_DIR}/${deviceId}.caddy`, caddyConfig);
  execSync('systemctl reload caddy');
  console.log(`Updated Caddy routes for device: ${deviceId}`);
}

function removeCaddyRoutes(deviceId) {
  const configFile = `${CADDY_CONF_DIR}/${deviceId}.caddy`;
  if (fs.existsSync(configFile)) {
    fs.unlinkSync(configFile);
    execSync('systemctl reload caddy');
    console.log(`Removed Caddy routes for device: ${deviceId}`);
  }
}

// HTTP server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Routes
  if (url.pathname === '/api/v1/devices/register' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const { deviceId, publicKey, wireguardIP } = JSON.parse(body);
      const devices = loadJSON(DEVICES_FILE);

      devices[deviceId] = { publicKey, wireguardIP, registeredAt: new Date().toISOString() };
      saveJSON(DEVICES_FILE, devices);

      addWireGuardPeer(deviceId, publicKey, wireguardIP);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, deviceId }));
    });
  }
  else if (url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/routes$/) && req.method === 'PUT') {
    const deviceId = url.pathname.split('/')[4];
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const { routes } = JSON.parse(body);
      const allRoutes = loadJSON(ROUTES_FILE);

      allRoutes[deviceId] = routes;
      saveJSON(ROUTES_FILE, allRoutes);

      updateCaddyRoutes(deviceId, routes);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, deviceId, routeCount: routes.length }));
    });
  }
  else if (url.pathname.match(/^\/api\/v1\/devices\/([^/]+)$/) && req.method === 'DELETE') {
    const deviceId = url.pathname.split('/')[4];
    const devices = loadJSON(DEVICES_FILE);
    const allRoutes = loadJSON(ROUTES_FILE);

    if (devices[deviceId]) {
      removeWireGuardPeer(devices[deviceId].publicKey);
      delete devices[deviceId];
      saveJSON(DEVICES_FILE, devices);
    }

    if (allRoutes[deviceId]) {
      removeCaddyRoutes(deviceId);
      delete allRoutes[deviceId];
      saveJSON(ROUTES_FILE, allRoutes);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, deviceId }));
  }
  else if (url.pathname === '/api/v1/status' && req.method === 'GET') {
    const devices = loadJSON(DEVICES_FILE);
    const routes = loadJSON(ROUTES_FILE);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      deviceCount: Object.keys(devices).length,
      routeCount: Object.values(routes).reduce((sum, r) => sum + r.length, 0),
    }));
  }
  else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`CI Ingress API listening on port ${PORT}`);
});
EOFJS

# Create systemd service
cat > /etc/systemd/system/ci-ingress-api.service <<EOF
[Unit]
Description=CI Ingress API
After=network.target wg-quick@wg0.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/ci-ingress-api
ExecStart=/usr/bin/node /opt/ci-ingress-api/server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Start and enable CI Ingress API
systemctl daemon-reload
systemctl enable ci-ingress-api
systemctl start ci-ingress-api

echo "CI Ingress API installed and started"

# ============================================================================
# Configure firewall
# ============================================================================

ufw --force enable
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 51820/udp

echo "=== CI Ingress VPS setup complete ==="
echo ""
echo "WireGuard Public Key: $PUBLIC_KEY"
echo "Ingress Domain: $INGRESS_DOMAIN"
echo ""
echo "Test the API: curl https://$INGRESS_DOMAIN/api/v1/status"
