# Fleet QA Testing Infrastructure

This document describes the QA testing infrastructure for the CI App Store.

## Overview

We use a fleet of servers to parallelize App Store QA testing:
- **7 core servers** (core-1 through core-7) - Primary testing fleet
- **4 beta servers** (beta-1, beta-5, beta-nas, beta-red) - Extended fleet

## Quick Start

### Run QA on Single Server
```bash
# Test a single app
bun run scripts/qa-app.ts <app-id>

# Test a batch (for parallel fleet testing)
BATCH=0 TOTAL_BATCHES=7 bun run scripts/qa-batch.ts
```

### Run QA on Full Fleet
```bash
# From control machine (liam-mbp):
for i in 0 1 2 3 4 5 6; do
  ssh ci@core-$((i+1)) "cd ~/devel/CI-OS-Hub && BATCH=$i bun run scripts/qa-batch.ts" &
done
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/qa-app.ts` | Test single app (pull, run, screenshot, benchmark) |
| `scripts/qa-batch.ts` | Test batch of apps (for parallel testing) |
| `scripts/qa-aggregate.ts` | Aggregate results from all servers |
| `scripts/prepull-images.ts` | Pre-pull Docker images overnight |
| `scripts/setup-docker-auth.sh` | Configure Docker Hub auth on fleet |

## Docker Caching

To avoid rate limits and speed up testing, we use a local registry cache.

### Registry Cache Server
- **Location:** core-1:5050
- **Type:** Pull-through proxy to Docker Hub
- **Speed:** 10Gb LAN vs 600Mb internet = ~17x faster

### Configure a Server to Use Cache

```bash
# Add registry mirror to Docker daemon
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
- Bun (1.3.x)
- Playwright Chromium (`bun x playwright install chromium`)
- CI-OS-Hub and CI-App-Store repos cloned to `~/devel/`

### Setup New Server

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install Playwright
~/.bun/bin/bun x playwright install chromium

# Clone repos
mkdir -p ~/devel && cd ~/devel
git clone https://github.com/companionintelligence/CI-OS-Hub.git
git clone https://github.com/companionintelligence/CI-App-Store.git

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
bun run scripts/qa-aggregate.ts
```

## Server Fleet

| Server | IP | Batch | Status |
|--------|----|----|--------|
| core-1 | 100.108.17.53 | 0 | ✅ Ready |
| core-2 | 100.101.156.33 | 1 | ✅ Ready |
| core-3 | 100.108.125.105 | 2 | ✅ Ready |
| core-4 | 100.76.114.122 | 3 | ✅ Ready |
| core-5 | 100.118.2.90 | 4 | ✅ Ready |
| core-6 | 100.95.23.128 | 5 | ✅ Ready |
| core-7 | 100.74.95.94 | 6 | ✅ Ready |
| beta-1 | 100.91.243.67 | 7 | ✅ Ready |
| beta-5 | 100.118.195.108 | 8 | ✅ Ready |
| beta-nas | 100.80.253.38 | 9 | ✅ Ready |
| beta-red | 100.86.79.25 | 10 | ✅ Ready |
