# CI/CD Pipeline Setup

This document describes the multi-environment CI/CD pipeline for CI-OS-Hub.

## Overview

The CI-OS-Hub project has a multi-environment deployment pipeline that automatically deploys to three environments based on branch activity:

- **Development (dev)**: Triggered by pushes to `dev` branch
- **Staging**: Triggered by pushes to `staging` branch  
- **Production**: Triggered by pushes to `main` branch

## Branch Strategy

```
dev      →  dev environment (ci-os-hub-dev)
staging  →  staging environment (ci-os-hub-staging)
main     →  production environment (ci-os-hub-production)
```

## Docker Image Tags

- `dev` branch → `ghcr.io/companionintelligence/ci-os-hub:dev`
- `staging` branch → `ghcr.io/companionintelligence/ci-os-hub:staging`
- `main` branch → `ghcr.io/companionintelligence/ci-os-hub:latest`

## GitHub Environments Setup

### Required Environments

Create three GitHub Environments in repository settings:

1. **dev**
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
   - Protection: None (auto-deploy)

2. **staging**
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
   - Protection: Optional manual approval

3. **production**
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
   - Protection: Required manual approval

### Setup Steps

1. Go to **Settings** → **Environments** → **New environment**
2. Create `dev`, `staging`, and `production` environments
3. Add required secrets to each environment:
   - `CLOUDFLARE_API_TOKEN`: Create at https://dash.cloudflare.com/profile/api-tokens
   - `CLOUDFLARE_ACCOUNT_ID`: Find at https://dash.cloudflare.com/ sidebar
4. Configure protection rules (especially for production)

## Workflow Features

### Automatic Deployments

- Push to `main` → Production (requires approval)
- Push to `staging` → Staging
- Push to `dev` → Dev

### Manual Deployments

1. Go to **Actions** → **Build and Push Container**
2. Click **Run workflow**
3. Select environment (dev, staging, production)
4. Click **Run workflow**

## Files

- `.github/workflows/build-container.yml` - Main CI/CD workflow
- `wrangler.toml` - Cloudflare Workers configuration
- `worker.ts` - Durable Object implementation

## Local Development

```bash
# Install Wrangler
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Run locally
wrangler dev --env dev

# Deploy manually
wrangler deploy --env dev
```

## Troubleshooting

**"Secret not found" error**: Ensure GitHub Environment is created with required secrets

**Deployment requires approval**: Configure reviewers in environment protection rules

**Build fails**: Check Dockerfile and workflow logs for errors

For more details, see the workflow file at `.github/workflows/build-container.yml`.
