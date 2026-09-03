# CI/CD pipeline setup

Historical notes for Companion Hub multi-environment container and desktop releases. For day-to-day workflow dispatch, see [`CI.md`](CI.md) and [`.github/workflows/README.md`](../.github/workflows/README.md).

## Overview

Companion Hub deploys from branch activity into three environments:

- **Development (`dev`)**: pushes to `dev`
- **Staging**: pushes to `staging`
- **Production**: pushes to `main`

## Branch strategy

```
dev      →  dev environment
staging  →  staging environment
main     →  production environment
```

## Docker image tags

- `dev` branch → `ghcr.io/companionintelligence/ci-hub:dev`
- `staging` branch → `ghcr.io/companionintelligence/ci-hub:staging`
- `main` branch → `ghcr.io/companionintelligence/ci-hub:latest`
- Desktop release (production only) → `ghcr.io/companionintelligence/ci-hub:<version>`, unprefixed
  (e.g. `0.2.45`) — the exact reference a shipped desktop bundle pins

Keep the package **public** because the desktop runs `docker compose` without registry
credentials. Before building a desktop bundle, the `verify-anonymous-pull` job in
`build-container.yml` verifies anonymous access. If that job fails, restore public package
visibility or push the missing versioned tag before you ship the bundle.

## Configure GitHub environments

### Required environments

Create three GitHub environments in the repository settings:

1. **dev**
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
   - Protection: None (automatic deployment)

2. **staging**
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
   - Protection: Optional manual approval

3. **production**
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
   - Protection: Required manual approval

### Set up the environments

1. Go to **Settings** → **Environments** → **New environment**
2. Create `dev`, `staging`, and `production` environments
3. Add required secrets to each environment:
   - `CLOUDFLARE_API_TOKEN`: Create a token in the [Cloudflare dashboard](https://dash.cloudflare.com/profile/api-tokens).
   - `CLOUDFLARE_ACCOUNT_ID`: Copy the account ID from the Cloudflare dashboard sidebar.
4. Configure the protection rules. Require manual approval for production.

## Deployments

### Automatic deployments

- Push to `main` → production (requires approval)
- Push to `staging` → staging
- Push to `dev` → development

### Manual deployments

1. Go to **Actions** → **Build and Push Container**
2. Select **Run workflow**.
3. Select an environment: `dev`, `staging`, or `production`.
4. Select **Run workflow**.

## Files

- `.github/workflows/build-container.yml` — Main CI/CD workflow
- `wrangler.toml` — Cloudflare Workers configuration
- `worker.ts` — Durable Object implementation

## Local development

```bash
# Install Wrangler.
npm install -g wrangler

# Log in to Cloudflare.
wrangler login

# Run locally.
wrangler dev --env dev

# Deploy manually.
wrangler deploy --env dev
```

## Troubleshooting

- **"Secret not found" error:** Verify that the GitHub environment contains the required secrets.
- **Deployment requires approval:** Configure reviewers in the environment protection rules.
- **Build failure:** Check the Dockerfile and workflow logs for errors.

For more information, see [`.github/workflows/build-container.yml`](../.github/workflows/build-container.yml).
