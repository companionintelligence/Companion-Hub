# CI Ingress Provider Deployment Guide

This guide explains how to deploy the CI Ingress Provider - a custom tunnel solution using WireGuard + Caddy on a VPS as an alternative to Cloudflare Tunnel.

## Architecture Overview

```
┌──────────────┐         ┌──────────────────┐         ┌──────────────────┐
│  End Users   │         │  Cloudflare      │         │  CI Ingress VPS  │
│  (Browser)   │────────▶│  DNS + CDN       │────────▶│  Caddy Proxy     │
└──────────────┘         │  DDoS Protection │         │  + WireGuard     │
                         └──────────────────┘         └────────┬─────────┘
                                                               │ WireGuard
                                                               │  Tunnel
                                                    ┌──────────▼─────────┐
                                                    │  CI-Hub Devices    │
                                                    │  (local apps)      │
                                                    └────────────────────┘
```

## Why CI Ingress?

- **No tunnel limits**: Unlike Cloudflare Tunnel, you control the infrastructure
- **Custom domains**: Full control over subdomain management
- **Cost-effective**: ~$24/month for unlimited devices
- **Privacy**: Traffic flows through your own VPS
- **Flexibility**: Customize proxy behavior, add features as needed

## Prerequisites

1. **Cloud Account**: DigitalOcean, AWS, GCP, Hetzner, or Linode
2. **Cloudflare Account**: For DNS management and CDN
3. **Domain**: A domain managed by Cloudflare DNS
4. **Terraform**: Install from https://terraform.io
5. **SSH Access**: SSH key for VPS access

## Quick Start (15 minutes)

### Step 1: Get API Tokens

**Cloudflare API Token:**
1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Use "Edit Zone DNS" template
4. Select your domain
5. Copy the token

**Cloudflare Zone ID:**
1. Go to your domain in Cloudflare dashboard
2. Scroll down on Overview page
3. Copy the "Zone ID" from right sidebar

**DigitalOcean API Token:**
1. Go to https://cloud.digitalocean.com/account/api/tokens
2. Click "Generate New Token"
3. Name it "CI Ingress Terraform"
4. Select "Write" access
5. Copy the token

**SSH Key ID:**
```bash
# Install doctl
brew install doctl  # macOS
# or: snap install doctl  # Linux

# Authenticate
doctl auth init  # Paste your DO token

# List SSH keys
doctl compute ssh-key list

# Note the ID column
```

### Step 2: Configure Terraform

```bash
# Navigate to terraform directory
cd infrastructure/terraform/ci-ingress

# Copy example config
cp terraform.tfvars.example terraform.tfvars

# Edit with your values
nano terraform.tfvars
```

Fill in:
```hcl
do_token = "dop_v1_your_token_here"
cloudflare_api_token = "your_cloudflare_token"
cloudflare_zone_id = "your_zone_id"
domain = "ci.computer"
ingress_subdomain = "ingress-us-west"
wireguard_subdomain = "wg-us-west"
admin_email = "admin@ci.computer"
ssh_key_ids = [12345678]
```

### Step 3: Deploy CI Ingress VPS

```bash
# Initialize Terraform
terraform init

# Review the plan
terraform plan

# Deploy (takes 3-5 minutes)
terraform apply

# Type 'yes' when prompted
```

Terraform will create:
- 1 VPS on DigitalOcean ($24/month)
- Firewall rules
- 3 DNS records in Cloudflare:
  - `ingress-us-west.ci.computer` (HTTPS endpoint, proxied)
  - `*.users.ci.computer` (wildcard for apps, proxied)
  - `wg-us-west.ci.computer` (WireGuard endpoint, DNS only)

### Step 4: Get WireGuard Public Key

```bash
# SSH into VPS (IP shown in terraform output)
ssh root@<VPS_IP>

# Get WireGuard public key
cat /etc/wireguard/publickey
```

Save this public key! CI-Portal will need it for device registration.

### Step 5: Test the Deployment

```bash
# Test DNS resolution
dig ingress-us-west.ci.computer

# Should return your VPS IP

# Test HTTPS endpoint (may take 1-2 min for SSL cert)
curl -I https://ingress-us-west.ci.computer/health

# Should return: 200 OK

# Test API status
curl https://ingress-us-west.ci.computer/api/v1/status

# Should return: {"status":"online","deviceCount":0,"routeCount":0}
```

### Step 6: Enable on CI-Hub Devices

On a CI-Hub device:

```bash
# Add to .env
echo "TUNNEL_PROVIDER=ci-ingress" >> .env
echo "CI_INGRESS_API_URL=https://ingress-us-west.ci.computer" >> .env

# Start with CI Ingress profile
docker compose --profile ci-ingress up -d

# Check logs
docker logs ci-ingress-wireguard

# Should see WireGuard connection established
```

## Done! 🎉

Your CI Ingress provider is now:
- ✅ Running on DigitalOcean VPS
- ✅ Protected by Cloudflare CDN/DDoS
- ✅ Accessible at your custom domain
- ✅ Ready to accept CI-Hub connections

## DNS Configuration Explained

### Three DNS Records Created

1. **HTTPS Ingress Endpoint** (`ingress-us-west.ci.computer`)
   - Type: A record
   - Proxied: Yes (orange cloud)
   - Purpose: API and management endpoint
   - Benefits: Cloudflare CDN, DDoS protection, automatic HTTPS

2. **Wildcard for User Apps** (`*.users.ci.computer`)
   - Type: CNAME → ingress-us-west.ci.computer
   - Proxied: Yes (orange cloud)
   - Purpose: Routes all user app subdomains through Caddy
   - Example: `homeassistant-liam.users.ci.computer`
   - Benefits: Cloudflare CDN, DDoS protection, automatic HTTPS

3. **WireGuard Endpoint** (`wg-us-west.ci.computer`)
   - Type: A record
   - Proxied: No (gray cloud - DNS only)
   - Purpose: WireGuard UDP endpoint for tunnel connections
   - Why not proxied: Cloudflare only proxies HTTP/HTTPS, not UDP

## How It Works

### 1. Device Registration Flow

```
CI-Hub → POST /api/v1/devices/register
  {
    deviceId: "device-123",
    publicKey: "wg_public_key_here",
    wireguardIP: "10.44.0.12"
  }

CI Ingress API:
  1. Adds WireGuard peer to wg0.conf
  2. Reloads WireGuard configuration
  3. Returns success
```

### 2. App Exposure Flow

```
CI-Hub → PUT /api/v1/devices/device-123/routes
  {
    routes: [
      {
        hostname: "homeassistant-liam.users.ci.computer",
        wireguardIP: "10.44.0.12",
        localPort: 8123,
        originServerName: "homeassistant.ci.lan"
      }
    ]
  }

CI Ingress API:
  1. Creates Caddy configuration file
  2. Reloads Caddy to apply routes
  3. Returns success
```

### 3. Request Routing Flow

```
Browser
  ↓
https://homeassistant-liam.users.ci.computer
  ↓
Cloudflare DNS resolves to ingress-us-west.ci.computer
  ↓
Cloudflare CDN proxies to VPS IP
  ↓
Caddy on VPS
  ↓
Matches hostname → reverse proxy to 10.44.0.12:8123
  ↓
WireGuard tunnel
  ↓
CI-Hub device at 10.44.0.12
  ↓
Traefik routes to Home Assistant container
```

## Monitoring and Maintenance

### View System Status

```bash
# SSH into VPS
ssh root@<VPS_IP>

# Check WireGuard status
wg show

# Should show connected peers with recent handshakes

# Check Caddy logs
journalctl -u caddy -f

# Check CI Ingress API logs
journalctl -u ci-ingress-api -f

# Check system resources
htop
```

### View Registered Devices

```bash
# On VPS
cat /var/lib/ci-ingress/devices.json

# Example output:
# {
#   "device-123": {
#     "publicKey": "wg_public_key",
#     "wireguardIP": "10.44.0.12",
#     "registeredAt": "2024-01-15T10:30:00Z"
#   }
# }
```

### View Active Routes

```bash
# On VPS
cat /var/lib/ci-ingress/routes.json

# View Caddy configurations
ls -la /etc/caddy/conf.d/

# View specific device routes
cat /etc/caddy/conf.d/device-123.caddy
```

## Scaling

### Add More Ingress VPS (Multi-Region)

Deploy in multiple regions for lower latency:

```bash
# US West
cd infrastructure/terraform/ci-ingress
terraform workspace new us-west
terraform apply -var="region=sfo3" -var="ingress_subdomain=ingress-us-west"

# US East
terraform workspace new us-east
terraform apply -var="region=nyc3" -var="ingress_subdomain=ingress-us-east"

# Europe
terraform workspace new eu
terraform apply -var="region=lon1" -var="ingress_subdomain=ingress-eu"
```

### Load Balancing (Multiple VPS per Region)

For high availability, deploy multiple VPS in same region:

```hcl
# In terraform.tfvars
ingress_count = 2

# Terraform will create 2 VPS and Cloudflare will load balance
```

## Troubleshooting

### WireGuard Connection Fails

```bash
# On CI-Hub device
docker logs ci-ingress-wireguard

# Check WireGuard configuration
docker exec ci-ingress-wireguard cat /config/wg0.conf

# Test connectivity to WireGuard endpoint
ping wg-us-west.ci.computer

# Check UDP port
nc -u -zv wg-us-west.ci.computer 51820
```

### Apps Not Accessible

```bash
# On VPS, check Caddy configuration
systemctl status caddy
journalctl -u caddy --no-pager | tail -50

# Verify route is configured
cat /etc/caddy/conf.d/*.caddy

# Test local connectivity over WireGuard
# On VPS:
curl -v http://10.44.0.12:8123
```

### DNS Not Resolving

```bash
# Check Cloudflare DNS
dig @1.1.1.1 ingress-us-west.ci.computer
dig @1.1.1.1 homeassistant-liam.users.ci.computer

# Wait 1-2 minutes for propagation
```

### Certificate Errors

Caddy automatically provisions Let's Encrypt certificates. If you see errors:

```bash
# On VPS, check Caddy logs
journalctl -u caddy -f

# Common issues:
# - Port 80/443 blocked by firewall
# - DNS not pointing to VPS
# - Rate limit (wait 1 hour)

# Force certificate renewal
caddy reload --config /etc/caddy/Caddyfile
```

## Security Best Practices

1. **Firewall**: Only allow ports 22, 80, 443 (TCP) and 51820 (UDP)
2. **SSH**: Use SSH keys, disable password authentication
3. **Updates**: Keep VPS and packages updated
4. **Monitoring**: Set up alerts for anomalies
5. **Backups**: Regular automated backups of `/var/lib/ci-ingress`
6. **API Authentication**: Use strong API keys, rotate regularly
7. **WireGuard Keys**: Rotate WireGuard keys periodically

## Cost Estimation

### Infrastructure Costs (Monthly)

**Single Region Deployment:**
- DigitalOcean VPS (2 vCPU, 4GB): $24/month
- Cloudflare DNS: $0/month (free tier)
- **Total**: $24/month for unlimited devices

**Multi-Region Deployment (3 regions):**
- DigitalOcean VPS × 3: $72/month
- Cloudflare DNS: $0/month (free tier)
- **Total**: $72/month

**vs. Cloudflare Tunnel:**
- Limited to tunnel quota per account
- May require multiple accounts
- Complex management

## Advanced Configuration

### Custom Caddy Configuration

Add custom Caddy directives:

```bash
# On VPS
nano /etc/caddy/Caddyfile

# Add custom configuration, e.g.:
{
    servers {
        protocols h1 h2 h3
        timeouts {
            read_body   30s
            read_header 10s
        }
    }
}
```

### Rate Limiting

Add rate limiting to protect API:

```javascript
// In /opt/ci-ingress-api/server.js
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use('/api/', limiter);
```

### Monitoring with Prometheus

Export metrics from CI Ingress API:

```javascript
// Add to server.js
const promClient = require('prom-client');
const register = new promClient.Registry();

// Create metrics
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  registers: [register]
});

// Expose /metrics endpoint
app.get('/metrics', (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(register.metrics());
});
```

## Comparison: CI Ingress vs Alternatives

| Feature | CI Ingress | Cloudflare Tunnel | Wiredoor | Octelium |
|---------|------------|-------------------|----------|----------|
| **Cost** | $24/mo (unlimited) | Free (limited tunnels) | Self-hosted | Self-hosted |
| **Setup** | 15 minutes | 5 minutes | 20 minutes | 30 minutes |
| **Control** | Full | Limited | Full | Full |
| **Custom Domains** | Yes | Yes | Yes | Yes |
| **Cloudflare CDN** | Yes | Yes | Optional | Optional |
| **WireGuard** | Yes | No | Yes | Yes |
| **Zero Trust** | DIY | Built-in | OAuth2 | Built-in |
| **Maintenance** | Low | None | Medium | Medium |

## Next Steps

1. ✅ VPS deployed and accessible
2. ✅ DNS configured
3. ✅ WireGuard operational
4. ✅ Caddy serving requests

Now you can:
- Register CI-Hub devices with CI Ingress
- Expose apps through custom subdomains
- Monitor traffic and performance
- Scale to multiple regions

## Support

- 📖 Documentation: This guide
- 🐛 Issues: https://github.com/companionintelligence/CI-Hub/issues
- 💬 Wiredoor Reference: https://github.com/wiredoor/wiredoor
