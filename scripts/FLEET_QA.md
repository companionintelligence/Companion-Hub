# Fleet QA Testing Infrastructure

This document describes the QA testing infrastructure for the CI App Store.

## Overview

We use a fleet of servers to parallelize App Store QA testing:
- **7 core servers** (core-1, core-2, core-6, core-8, core-9, core-10, core-13) - Primary testing fleet
- **2 beta servers** (beta-1, beta-5) - Extended fleet
- **Excluded:** core-3 (100.126.23.45, first-boot pairing), core-5 (100.73.255.24, SSH blocked), beta-red/100.86.79.25 (repurposed as beta-3-glass hub-node, key expired), core-4 / core-4-kvm (offline/stale — prune)

## Quick Start

### Live Dashboard Runner

Use this for manual release QA when you want to watch app testing in real time:

```bash
# From CI-Hub on the control machine
./node_modules/.bin/tsx scripts/fleet-qa-server.ts --port=4244
```

Open <http://127.0.0.1:4244/> locally or the printed LAN/Tailscale URL from another device.

Recommended flow:

1. Click **Preflight**. Every selected node must pass SSH, Docker, `tsx`/`pnpm`, and CI-Marketplace checks.
2. Select one node and run **Quick** to confirm the stream path and screenshots.
3. Select all ready nodes, switch to **Full** for the current generated catalog, then click **Start**.

The dashboard automatically runs preflight before starting a run and skips nodes that fail. Hover a node badge to see the exact failure.

If all nodes report `tailscale: tailnet policy does not permit you to SSH to this node`, fix the Tailscale SSH ACL for the fleet before testing. The control machine/user needs SSH permission to `tag:tagged-devices` as `ci` (or set `FLEET_SSH_USER` to the allowed user).

### Run QA on Single Server
```bash
# Test a single app
pnpm exec tsx scripts/qa-app.ts <app-id>

# Test a batch (for parallel fleet testing)
BATCH=0 TOTAL_BATCHES=11 pnpm exec tsx scripts/qa-batch.ts
```

### Run QA on Full Fleet
```bash
# From control machine (liam-mbp) — requires FLEET_CONFIG_JSON set:
export FLEET_CONFIG_JSON='[
  {"name":"core-1",  "ip":"100.108.17.53",  "batch":0},
  {"name":"core-2",  "ip":"100.101.156.33", "batch":1},
  {"name":"core-6",  "ip":"100.95.23.128",  "batch":2},
  {"name":"core-8",  "ip":"100.98.33.44",   "batch":3},
  {"name":"core-9",  "ip":"100.113.188.103","batch":4},
  {"name":"core-10", "ip":"100.87.68.116",  "batch":5},
  {"name":"core-13", "ip":"100.76.114.122", "batch":6},
  {"name":"beta-1",  "ip":"100.124.211.75", "batch":7},
  {"name":"beta-5",  "ip":"100.118.195.108","batch":8}
]'
pnpm exec tsx scripts/run-fleet-tests.ts --execute
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/qa-app.ts` | Test single app (pull, run, screenshot, benchmark) |
| `scripts/qa-batch.ts` | Test batch of apps (for parallel testing) |
| `scripts/qa-aggregate.ts` | Aggregate results from all servers |
| `scripts/run-fleet-tests.ts` | Orchestrate full fleet via SSH |
| `scripts/generate-catalog-tests.ts` | Regenerate Playwright batch spec files from CI-Marketplace |
| `scripts/prepull-images.ts` | Pre-pull Docker images overnight |
| `scripts/setup-docker-auth.sh` | Configure Docker Hub auth on fleet |

## Docker Caching

To avoid rate limits and speed up testing, we use a local registry cache.

### Registry Cache Server
- **Location:** core-1:5050 (100.108.17.53:5050)
- **Type:** Pull-through proxy to Docker Hub
- **Speed:** 10Gb LAN vs 600Mb internet = ~17x faster

### Configure a Server to Use Cache

```bash
sudo bash -c 'cat > /etc/docker/daemon.json << EOF
{
  "registry-mirrors": ["http://100.108.17.53:5050"],
  "insecure-registries": ["100.108.17.53:5050"]
}
EOF'
sudo systemctl restart docker
```

### Docker Hub Authentication

```bash
# Login to avoid rate limits (100 → 200 pulls/6hr)
DOCKER_USER=xxx DOCKER_TOKEN=xxx ./scripts/setup-docker-auth.sh
```

## Server Requirements

Each server needs:
- Docker (28.x or 29.x)
- Node.js 22 + pnpm
- Playwright Chromium (`pnpm exec playwright install chromium`)
- CI-Hub and CI-Marketplace repos cloned to `~/devel/`

### Setup New Server

```bash
# Install pnpm
npm install -g pnpm

# Install Playwright
pnpm exec playwright install chromium

# Clone repos
mkdir -p ~/devel && cd ~/devel
git clone https://github.com/companionintelligence/CI-Hub.git
git clone https://github.com/companionintelligence/CI-Marketplace.git

# Configure Docker cache (optional, needs sudo)
sudo bash -c 'cat > /etc/docker/daemon.json << EOF
{
  "registry-mirrors": ["http://100.108.17.53:5050"],
  "insecure-registries": ["100.108.17.53:5050"]
}
EOF'
sudo systemctl restart docker
```

## Results

Results are saved to `~/qa-results/` on each server:
- `results.json` - Full test results
- `screenshots/` - App screenshots
- `batch-N-report.md` - Human-readable report

### Aggregate Results

```bash
# Run from control machine after all batches complete
pnpm exec tsx scripts/qa-aggregate.ts
```

## Regenerating Catalog Batch Tests

The Playwright batch specs in `e2e/generated/` are generated from CI-Marketplace. Regenerate after
any CI-Marketplace app changes:

```bash
# From CI-Hub root (requires CI-Marketplace cloned at ../CI-Marketplace)
pnpm exec tsx scripts/generate-catalog-tests.ts

# Or specify a custom path:
APP_STORE_PATH=/path/to/CI-Marketplace/apps pnpm exec tsx scripts/generate-catalog-tests.ts
```

This creates 10 batch files (`catalog-batch-0.spec.ts` ... `catalog-batch-9.spec.ts`), one per server.

## Server Fleet

| Server | Tailscale IP | Batch | Status |
|--------|-------------|-------|--------|
| core-1   | 100.108.17.53  | 0 | Ready (registry cache host) |
| core-2   | 100.101.156.33 | 1 | Ready |
| core-6   | 100.95.23.128  | 2 | Ready |
| core-8   | 100.98.33.44   | 3 | Ready |
| core-9   | 100.113.188.103| 4 | Ready |
| core-10  | 100.87.68.116  | 5 | Ready |
| core-13  | 100.76.114.122 | 6 | Ready |
| beta-1   | 100.124.211.75 | 7 | Ready |
| beta-5   | 100.118.195.108| 8 | Ready |
| core-3   | 100.126.23.45  | — | Excluded (first-boot pairing) |
| core-5   | 100.73.255.24  | — | Excluded (SSH blocked) |
| beta-red | 100.86.79.25   | — | Repurposed as beta-3-glass (hub-node, key expired) |
| core-4 / core-4-kvm | 100.121.17.113 / 100.79.195.54 | — | Offline / stale — prune |

## GitHub Actions Secrets Required

Add under Settings > Secrets and variables > Actions:

| Secret | Value |
|--------|-------|
| `FLEET_CORE_1_IP` | Tailscale IP for core-1 |
| `FLEET_CORE_2_IP` | Tailscale IP for core-2 |
| `FLEET_CORE_5_IP` | Tailscale IP for core-5 |
| `FLEET_CORE_6_IP` | Tailscale IP for core-6 |
| `FLEET_CORE_8_IP` | Tailscale IP for core-8 |
| `FLEET_CORE_9_IP` | Tailscale IP for core-9 |
| `FLEET_CORE_10_IP` | Tailscale IP for core-10 |
| `FLEET_CORE_13_IP` | Tailscale IP for core-13 |
| `FLEET_BETA_1_IP` | Tailscale IP for beta-1 |
| `FLEET_BETA_RED_IP` | Tailscale IP for beta-red |
| `FLEET_SSH_USER` | SSH user on fleet nodes (e.g. `ci`) |
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID for CI |
| `TS_OAUTH_SECRET` | Tailscale OAuth secret for CI |
| `E2E_TEST_PASSWORD` | Password for the e2e-test account |
| `CF_API_TOKEN` | Cloudflare API token (for cloudflare suite) |
| `CF_ZONE_ID` | Cloudflare zone ID (for cloudflare suite) |
| `TS_AUTH_KEY` | Tailscale auth key (for tailscale suite) |
| `DISCORD_WEBHOOK_URL` | Discord webhook for test result notifications |
