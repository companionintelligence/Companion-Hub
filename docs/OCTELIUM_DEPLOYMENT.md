# Octelium Deployment Guide for Cloudflare Infrastructure

This guide explains how to deploy Octelium cluster infrastructure on cloud VMs behind Cloudflare's CDN/DNS for use with CI-Hub.

## Architecture Overview

```
┌──────────────┐         ┌──────────────────┐         ┌──────────────────┐
│  End Users   │         │  Cloudflare      │         │  Octelium        │
│  (Browser)   │────────▶│  DNS + CDN       │────────▶│  Cluster (VMs)   │
└──────────────┘         │  DDoS Protection │         │  on Cloud        │
                         └──────────────────┘         └────────┬─────────┘
                                                               │
                                                               │
                                                    ┌──────────▼─────────┐
                                                    │  CI-Hub Clients    │
                                                    │  (octelium-client) │
                                                    └────────────────────┘
```

## Prerequisites

1. **Cloud Account**: AWS, GCP, DigitalOcean, Hetzner, or Linode account
2. **Cloudflare Account**: Free or paid tier with DNS management
3. **Domain**: A domain managed by Cloudflare DNS
4. **SSH Access**: SSH key for VM access

## Step 1: Provision Octelium Cluster VMs

### Recommended Specifications

**For Production (10-100 devices):**
- 2-4 VMs
- 2 vCPU, 4GB RAM per VM
- 50GB SSD storage
- Ubuntu 22.04 LTS or Debian 12
- Public IP addresses
- UDP port 51820 (WireGuard) and 443 (HTTPS) open

**For Small Deployment (<10 devices):**
- 1-2 VMs
- 1 vCPU, 2GB RAM per VM
- 20GB SSD storage

### Example: DigitalOcean Droplets

```bash
# Install doctl (DigitalOcean CLI)
brew install doctl  # macOS
# or: sudo snap install doctl  # Linux

# Authenticate
doctl auth init

# Create droplets
doctl compute droplet create octelium-1 \
  --region nyc3 \
  --size s-2vcpu-4gb \
  --image ubuntu-22-04-x64 \
  --ssh-keys YOUR_SSH_KEY_ID

doctl compute droplet create octelium-2 \
  --region nyc3 \
  --size s-2vcpu-4gb \
  --image ubuntu-22-04-x64 \
  --ssh-keys YOUR_SSH_KEY_ID
```

### Example: AWS EC2 Instances

```bash
# Using AWS CLI
aws ec2 run-instances \
  --image-id ami-0c55b159cbfafe1f0 \
  --instance-type t3.medium \
  --key-name your-key-pair \
  --security-group-ids sg-XXXXXXXX \
  --subnet-id subnet-XXXXXXXX \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=octelium-1}]' \
  --count 2
```

## Step 2: Install Octelium on VMs

SSH into each VM and run:

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker

# Install Octelium
curl -fsSL https://octelium.dev/install.sh | bash

# Initialize cluster (on first node only)
sudo octelium cluster init \
  --cluster-name ci-hub-octelium \
  --admin-email admin@yourdomain.com
```

The installer will output:
- Admin bootstrap token
- Cluster ID
- Management API endpoint

**Save these credentials securely!**

## Step 3: Configure Cloudflare DNS

### Option A: Using Cloudflare Dashboard

1. Log into Cloudflare dashboard
2. Select your domain
3. Go to DNS → Records
4. Add A records for Octelium cluster:

```
Type: A
Name: octelium
Content: <OCTELIUM_VM_1_IP>
Proxy status: Proxied (orange cloud)
TTL: Auto

Type: A
Name: octelium
Content: <OCTELIUM_VM_2_IP>
Proxy status: Proxied (orange cloud)
TTL: Auto
```

Cloudflare will automatically load balance between IPs.

### Option B: Using Cloudflare API

```bash
# Set your Cloudflare credentials
export CF_API_TOKEN="your-api-token"
export CF_ZONE_ID="your-zone-id"

# Add DNS records
curl -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "A",
    "name": "octelium",
    "content": "OCTELIUM_VM_1_IP",
    "proxied": true,
    "ttl": 1
  }'

curl -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "A",
    "name": "octelium",
    "content": "OCTELIUM_VM_2_IP",
    "proxied": true,
    "ttl": 1
  }'
```

## Step 4: Configure Cloudflare Firewall Rules

To protect the Octelium cluster:

```bash
# Allow only WireGuard UDP traffic to origin
curl -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/firewall/rules" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "filter": {
      "expression": "ip.dst in {OCTELIUM_VM_1_IP OCTELIUM_VM_2_IP} and not udp.dstport eq 51820"
    },
    "action": "block",
    "description": "Block non-WireGuard traffic to Octelium"
  }'
```

## Step 5: Join Additional Nodes to Cluster

On additional VMs (octelium-2, octelium-3, etc.):

```bash
# Use the join token from cluster init
sudo octelium cluster join \
  --token <BOOTSTRAP_TOKEN_FROM_STEP_2> \
  --cluster-url https://octelium.yourdomain.com
```

## Step 6: Configure CI-Portal for Octelium

Update your CI-Portal (Cloudflare Workers) to manage Octelium credentials.

### Add Environment Variables to CI-Portal Worker

```bash
# In your CI-Portal wrangler.toml or .dev.vars
OCTELIUM_CLUSTER_URL=https://octelium.yourdomain.com
OCTELIUM_ADMIN_TOKEN=<BOOTSTRAP_TOKEN_FROM_STEP_2>
```

### Create Octelium Manager in CI-Portal

Add to `packages/ci-portal/src/services/octelium-manager.ts`:

```typescript
export class OcteliumManager {
  constructor(
    private clusterUrl: string,
    private adminToken: string,
  ) {}

  async provisionClient(deviceId: string, orgId: string): Promise<{
    clusterId: string;
    token: string;
    clusterUrl: string;
  }> {
    const response = await fetch(`${this.clusterUrl}/api/v1/clients`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `hub-${deviceId}`,
        organization: orgId,
        permissions: ['tunnel', 'routing'],
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to provision Octelium client: ${response.statusText}`);
    }

    const data = await response.json();
    return {
      clusterId: data.id,
      token: data.token,
      clusterUrl: this.clusterUrl,
    };
  }

  async updateRouting(deviceId: string, apps: AppInfo[]): Promise<boolean> {
    // Update Octelium routing configuration
    const response = await fetch(`${this.clusterUrl}/api/v1/clients/${deviceId}/routes`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ routes: apps }),
    });

    return response.ok;
  }
}
```

## Step 7: Update CI-Hub Configuration

### Add to .env

```bash
# Octelium configuration
TUNNEL_PROVIDER=octelium
OCTELIUM_CLUSTER_URL=https://octelium.yourdomain.com
```

### Enable Octelium Profile

```bash
# Start CI-Hub with Octelium profile
docker compose --profile octelium up -d
```

## Step 8: Test the Setup

### 1. Verify Cluster Status

```bash
ssh user@octelium-vm-1
sudo octelium cluster status
```

Should show all nodes connected.

### 2. Test Client Connection

On the CI-Hub machine:

```bash
# Check if octelium-client container is running
docker ps | grep octelium-client

# Check logs
docker logs octelium-client

# Should see: "Connected to Octelium cluster"
```

### 3. Test DNS Resolution

```bash
dig octelium.yourdomain.com

# Should return your VM IPs via Cloudflare
```

### 4. Test Tunnel Connectivity

```bash
# From CI-Hub, test connection to cluster
curl -I https://octelium.yourdomain.com/health

# Should return 200 OK
```

## Monitoring and Maintenance

### Octelium Cluster Monitoring

```bash
# View cluster metrics
ssh user@octelium-vm-1
sudo octelium metrics

# View connected clients
sudo octelium clients list

# View routing table
sudo octelium routes list
```

### Cloudflare Analytics

Monitor traffic in Cloudflare dashboard:
- Analytics → Traffic
- Security → Events
- Performance → Speed

### Backup Octelium Configuration

```bash
# Backup cluster config
ssh user@octelium-vm-1
sudo octelium backup create --output /tmp/octelium-backup.tar.gz

# Download backup
scp user@octelium-vm-1:/tmp/octelium-backup.tar.gz ./
```

## Scaling

### Adding More Cluster Nodes

```bash
# Provision new VM
# SSH into new VM
# Join cluster
sudo octelium cluster join \
  --token <BOOTSTRAP_TOKEN> \
  --cluster-url https://octelium.yourdomain.com

# Update Cloudflare DNS with new IP
# (Add another A record for octelium.yourdomain.com)
```

### Load Balancer (Optional)

For production, consider adding a dedicated load balancer:

```
User → Cloudflare → Load Balancer → Octelium Nodes
```

This provides:
- Health checks
- Automatic failover
- Better traffic distribution

## Troubleshooting

### Client Can't Connect

1. Check firewall rules on VMs:
```bash
sudo ufw status
# Ensure port 51820 (UDP) and 443 (TCP) are open
```

2. Verify Cloudflare DNS:
```bash
dig octelium.yourdomain.com
```

3. Check Octelium logs:
```bash
docker logs octelium-client
```

### DNS Not Resolving

- Wait 5-10 minutes for DNS propagation
- Clear DNS cache: `sudo systemd-resolve --flush-caches`
- Test with `dig @1.1.1.1 octelium.yourdomain.com`

### High Latency

- Add Octelium nodes in regions closer to your users
- Enable Argo Smart Routing in Cloudflare (paid feature)
- Check VM network performance

## Security Best Practices

1. **Firewall**: Only allow ports 51820 (UDP) and 443 (TCP)
2. **SSH**: Use SSH keys, disable password authentication
3. **Updates**: Keep VMs and Octelium updated
4. **Monitoring**: Set up alerts for anomalies
5. **Backups**: Regular automated backups of cluster config
6. **Access Control**: Use strong tokens, rotate regularly

## Cost Estimation

### Infrastructure Costs (Monthly)

**Small Deployment (2 VMs, 2 vCPU, 4GB each):**
- DigitalOcean: ~$40/month
- AWS: ~$60/month
- Hetzner: ~$20/month

**Medium Deployment (4 VMs, 2 vCPU, 4GB each):**
- DigitalOcean: ~$80/month
- AWS: ~$120/month
- Hetzner: ~$40/month

**Cloudflare:**
- Free tier: $0/month (DNS + basic DDoS)
- Pro tier: $20/month (enhanced DDoS + analytics)

## Next Steps

1. ✅ Cluster deployed and accessible
2. ✅ Cloudflare DNS configured
3. ✅ CI-Portal integration ready
4. ✅ CI-Hub configured for Octelium

Now you can:
- Migrate existing devices from Cloudflare Tunnel to Octelium
- Register new devices with Octelium as default provider
- Monitor and scale as needed

## Support

- Octelium Documentation: https://octelium.com/docs
- Octelium GitHub: https://github.com/octelium/octelium
- CI-Hub Issues: https://github.com/companionintelligence/CI-Hub/issues
