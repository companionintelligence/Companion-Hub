# Quick Start: Deploy Octelium on Cloudflare Infrastructure

This guide will get you up and running with Octelium in 15 minutes.

## What You're Building

```
Internet → Cloudflare DNS/CDN → Octelium Cluster (VMs) → CI-Hub Devices
```

## Prerequisites

- Cloudflare account with a domain
- DigitalOcean account (or AWS/GCP)
- Terraform installed: `brew install terraform` or https://terraform.io

## Step 1: Get Your API Tokens

### Cloudflare API Token
1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Use "Edit Zone DNS" template
4. Select your domain
5. Copy the token

### Cloudflare Zone ID
1. Go to your domain in Cloudflare dashboard
2. Scroll down on Overview page
3. Copy the "Zone ID" on the right sidebar

### DigitalOcean API Token
1. Go to https://cloud.digitalocean.com/account/api/tokens
2. Click "Generate New Token"
3. Give it a name: "Octelium Terraform"
4. Select "Write" access
5. Copy the token

### SSH Key ID
```bash
# Install doctl if you haven't
brew install doctl  # macOS
# or: snap install doctl  # Linux

# Authenticate
doctl auth init  # Paste your DO token

# List SSH keys
doctl compute ssh-key list

# Note the ID column
```

## Step 2: Configure Terraform

```bash
# Navigate to terraform directory
cd infrastructure/terraform/octelium

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
domain = "octelium.yourdomain.com"
admin_email = "admin@yourdomain.com"
ssh_key_ids = [12345678]  # Your SSH key ID from step 1
```

## Step 3: Deploy Octelium Cluster

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
- 2 VMs on DigitalOcean ($24/month each)
- Firewall rules
- DNS records in Cloudflare

## Step 4: Get Bootstrap Token

```bash
# SSH into first node (IP shown in terraform output)
ssh root@<NODE_1_IP>

# Get bootstrap token
cat /root/octelium-bootstrap.txt
```

Save this token! You'll need it for CI-Portal.

## Step 5: Configure CI-Portal

Add these to your CI-Portal environment variables:

```bash
# In your CI-Portal .env or wrangler.toml
OCTELIUM_CLUSTER_URL=https://octelium.yourdomain.com
OCTELIUM_ADMIN_TOKEN=<token-from-step-4>
```

Redeploy CI-Portal:
```bash
cd packages/ci-portal
npm run deploy
```

## Step 6: Test Octelium Cluster

```bash
# Test DNS resolution
dig octelium.yourdomain.com

# Should show your VM IPs

# Test HTTPS (may take 1-2 min for cert provisioning)
curl -I https://octelium.yourdomain.com/health

# Should return: 200 OK
```

## Step 7: Enable Octelium on CI-Hub

On a CI-Hub device:

```bash
# Add to .env
echo "TUNNEL_PROVIDER=octelium" >> .env
echo "OCTELIUM_CLUSTER_URL=https://octelium.yourdomain.com" >> .env

# Start with Octelium profile
docker compose --profile octelium up -d

# Check logs
docker logs octelium-client

# Should see: "Connected to Octelium cluster"
```

## Done! 🎉

Your Octelium cluster is now:
- ✅ Running on DigitalOcean VMs
- ✅ Protected by Cloudflare CDN
- ✅ Accessible at your custom domain
- ✅ Ready to accept CI-Hub connections

## What's Next?

- **Migrate existing devices**: Update their tunnel provider from Cloudflare to Octelium
- **Monitor**: Check Cloudflare Analytics for traffic
- **Scale**: Add more nodes with `terraform apply -var="node_count=4"`
- **Backup**: Run `ssh root@NODE_IP "octelium backup create"`

## Costs

- **DigitalOcean**: $48/month (2 nodes × $24/month)
- **Cloudflare**: $0/month (free tier) or $20/month (Pro)
- **Total**: ~$50/month for self-hosted tunnel infrastructure

vs. Cloudflare Tunnel limits.

## Troubleshooting

### DNS not resolving
```bash
# Check Cloudflare DNS
dig @1.1.1.1 octelium.yourdomain.com

# Wait 1-2 minutes for propagation
```

### Can't connect to cluster
```bash
# Check firewall
ssh root@NODE_IP
ufw status

# Should show: 443/tcp, 51820/udp ALLOW
```

### Certificate errors
```bash
# Cloudflare handles certs automatically
# Wait 1-2 minutes after DNS propagation
```

## Advanced

### Multi-region Deployment

Deploy in multiple regions for lower latency:

```hcl
# In terraform.tfvars
regions = ["nyc3", "lon1", "sfo3"]
```

### Monitoring

Add monitoring with Prometheus:
```bash
ssh root@NODE_IP
octelium monitoring enable --prometheus
```

### Backups

Automated backups:
```bash
# On first node
crontab -e

# Add: Daily backup at 2 AM
0 2 * * * octelium backup create --output /backups/octelium-$(date +\%Y\%m\%d).tar.gz
```

## Support

- 📖 Full docs: [OCTELIUM_DEPLOYMENT.md](../../../docs/OCTELIUM_DEPLOYMENT.md)
- 🐛 Issues: https://github.com/companionintelligence/CI-Hub/issues
- 💬 Octelium: https://github.com/octelium/octelium
