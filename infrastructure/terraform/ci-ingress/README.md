# Quick Start: Deploy CI Ingress Provider

Deploy your own tunnel ingress infrastructure in 15 minutes using WireGuard + Caddy on a VPS.

## What You're Building

```
Internet → Cloudflare DNS/CDN → CI Ingress VPS (Caddy + WireGuard) → CI-Hub Devices → Apps
```

## Why CI Ingress?

- **No Tunnel Limits**: Unlike Cloudflare Tunnel, you control everything
- **$24/month**: For unlimited devices and apps
- **Custom Domains**: Full control via Cloudflare DNS
- **Privacy**: Traffic through your VPS, not third-party services

## Prerequisites

- Cloudflare account with a domain
- DigitalOcean account (or AWS/GCP)
- Terraform installed: `brew install terraform`
- 15 minutes

## Deploy Now

### 1. Get Your API Tokens (5 min)

**Cloudflare:**
```bash
# Go to: https://dash.cloudflare.com/profile/api-tokens
# Create Token → "Edit Zone DNS" template
# Copy the token + Zone ID from domain dashboard
```

**DigitalOcean:**
```bash
# Go to: https://cloud.digitalocean.com/account/api/tokens
# Generate New Token → Name: "CI Ingress" → Write access
# Copy the token

# Install doctl CLI
brew install doctl  # macOS

# Authenticate and get SSH key ID
doctl auth init
doctl compute ssh-key list  # Note the ID
```

### 2. Configure (2 min)

```bash
cd infrastructure/terraform/ci-ingress

# Copy example config
cp terraform.tfvars.example terraform.tfvars

# Edit with your values
nano terraform.tfvars
```

Required values:
- `do_token` - Your DigitalOcean API token
- `cloudflare_api_token` - Your Cloudflare API token
- `cloudflare_zone_id` - Your Cloudflare Zone ID
- `domain` - Your domain (e.g., "ci.computer")
- `admin_email` - Your email for SSL certs
- `ssh_key_ids` - Your SSH key ID from doctl

### 3. Deploy (5 min)

```bash
# Initialize
terraform init

# Deploy
terraform apply

# Type 'yes' when prompted
# Wait 3-5 minutes for VPS setup
```

### 4. Get WireGuard Key (1 min)

```bash
# SSH into VPS (IP from terraform output)
ssh root@<VPS_IP>

# Get public key
cat /etc/wireguard/publickey
```

### 5. Test (2 min)

```bash
# Test API
curl https://ingress-us-west.ci.computer/api/v1/status

# Should return: {"status":"online","deviceCount":0,"routeCount":0}
```

## Enable on CI-Hub

```bash
# On your CI-Hub device
echo "TUNNEL_PROVIDER=ci-ingress" >> .env
echo "CI_INGRESS_API_URL=https://ingress-us-west.ci.computer" >> .env

# Start with CI Ingress
docker compose --profile ci-ingress up -d

# Verify connection
docker logs ci-ingress-wireguard
```

## What Gets Created

### DigitalOcean
- 1 VPS (Ubuntu 22.04, 2 vCPU, 4GB RAM)
- WireGuard server
- Caddy reverse proxy
- CI Ingress API

### Cloudflare DNS
- `ingress-us-west.ci.computer` → VPS IP (proxied)
- `*.users.ci.computer` → ingress endpoint (proxied)
- `wg-us-west.ci.computer` → VPS IP (DNS only, for WireGuard UDP)

### Cost
- **$24/month** for unlimited devices
- vs. Cloudflare Tunnel account limits

## Architecture

```
Browser Request:
  https://homeassistant-liam.users.ci.computer
    ↓
  Cloudflare DNS → ingress-us-west.ci.computer
    ↓
  Cloudflare CDN (DDoS protection, TLS termination)
    ↓
  VPS: Caddy reverse proxy
    ↓
  WireGuard tunnel to 10.44.0.12:8123
    ↓
  CI-Hub device
    ↓
  Home Assistant container
```

## DNS Configuration

| Record | Type | Value | Proxied | Purpose |
|--------|------|-------|---------|---------|
| `ingress-us-west` | A | VPS IP | Yes ☁️ | HTTPS endpoint with CDN |
| `*.users` | CNAME | `ingress-us-west` | Yes ☁️ | Wildcard for all apps |
| `wg-us-west` | A | VPS IP | No | WireGuard UDP endpoint |

**Why different proxy settings?**
- **HTTPS endpoints** (ingress, *.users): Proxied through Cloudflare for CDN, DDoS protection, automatic HTTPS
- **WireGuard endpoint**: DNS only because Cloudflare doesn't proxy UDP traffic

## Monitoring

```bash
# SSH into VPS
ssh root@<VPS_IP>

# View WireGuard connections
wg show

# View Caddy logs
journalctl -u caddy -f

# View API logs
journalctl -u ci-ingress-api -f

# View registered devices
cat /var/lib/ci-ingress/devices.json

# View active routes
cat /var/lib/ci-ingress/routes.json
```

## Multi-Region Deployment

Deploy in multiple regions for global coverage:

```bash
# US West (already deployed above)

# US East
terraform apply -var="region=nyc3" -var="ingress_subdomain=ingress-us-east"

# Europe
terraform apply -var="region=lon1" -var="ingress_subdomain=ingress-eu"
```

## Troubleshooting

### Can't connect to WireGuard
```bash
# Check WireGuard is running on VPS
ssh root@<VPS_IP>
systemctl status wg-quick@wg0

# Check firewall allows UDP 51820
ufw status
```

### Apps not accessible
```bash
# Check Caddy configuration
ssh root@<VPS_IP>
systemctl status caddy
cat /etc/caddy/conf.d/*.caddy

# Test direct connection over WireGuard
curl -v http://10.44.0.12:8123
```

### DNS not resolving
```bash
# Check Cloudflare DNS
dig ingress-us-west.ci.computer

# Wait 1-2 minutes for propagation
```

## Comparison

| Feature | CI Ingress | Cloudflare Tunnel | Octelium |
|---------|------------|-------------------|----------|
| Cost | $24/mo | Free (limited) | DIY |
| Setup Time | 15 min | 5 min | 30 min |
| Tunnel Limits | None | Yes | None |
| Custom Control | Full | Limited | Full |
| Cloudflare CDN | Yes | Yes | Optional |
| Protocol | WireGuard | QUIC/HTTP2 | WireGuard |

## Next Steps

1. ✅ CI Ingress VPS deployed
2. ✅ DNS configured
3. ✅ WireGuard running
4. ✅ Caddy serving requests

Now:
- Connect CI-Hub devices
- Expose apps with custom subdomains
- Scale to more regions
- Monitor and maintain

## Full Documentation

- 📖 Complete Guide: [CI_INGRESS_DEPLOYMENT.md](../../../docs/CI_INGRESS_DEPLOYMENT.md)
- 🏗️ Architecture Details: [TUNNEL_ALTERNATIVES.md](../../../docs/TUNNEL_ALTERNATIVES.md)
- 🐛 Issues: https://github.com/companionintelligence/CI-Hub/issues

## Inspired By

- **Wiredoor**: Self-hosted ingress-as-a-service (https://github.com/wiredoor/wiredoor)
- **frp**: Fast reverse proxy (https://github.com/fatedier/frp)
- **Pangolin**: Identity-aware VPN (https://github.com/fosrl/pangolin)

CI Ingress takes the best ideas from these projects and integrates them into CI-Hub's architecture.
