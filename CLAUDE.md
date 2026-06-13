# CLAUDE.md — CI-Hub

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

## Platform role

**CI-Hub** sits in the **Appliance** layer of the Companion Intelligence platform.

Architecture: `CI-Engineering/architecture/architecture.md`
Roadmap: `CI-Engineering/architecture/roadmap.md`
Issues: <https://github.com/companionintelligence/CI-Engineering/issues>

## What this repo does

Local app runtime. Installs and supervises marketplace apps as Docker Compose deployments. Includes a Tauri desktop app, React frontend, and NestJS backend.

## Stack

- NestJS + Drizzle ORM + PostgreSQL + RabbitMQ (backend)
- React 19 + React Router 7 + TanStack Query + Tailwind (frontend)
- Tauri 2 / Rust (desktop)
- Docker Compose + Traefik v3 (app runtime)
- pnpm workspaces + Turborepo + Biome

## Key commands

```bash
# Install dependencies
pnpm install

# Start source-based local development
pnpm run local

# Start the dev appliance stack
pnpm run dev

# Run tests
pnpm test

# Build for production
pnpm build
```

## Package manager

**pnpm** — use exclusively; do not mix with npm/yarn/pnpm/bun unless the repo explicitly requires it.

## Cross-repo connections

- Pulls app manifests from CI-Marketplace (via CI-Portal distribution edge)
- Routes installed apps through CI-Gateway (Traefik) on *.ci.localhost
- Will add entitlement pre-flight against CI-Portal before installs (issue #32)
- Installs CI-Server alongside marketplace apps

## Desktop app

Tauri 2 in `packages/desktop/`. Run `pnpm run local:desktop` to launch against the local source-dev stack, or `pnpm run dev:desktop` for the `.env.dev` appliance stack. macOS signing identity set in tauri.conf.json — other devs without the cert will see TCC prompts.

## Packages layout

`packages/backend/` · `packages/frontend/` · `packages/desktop/` · `packages/common/`

## Multi-agent safety

Multiple AI agents work these repos in parallel. Never use `git reset --hard`, `git clean -f`, or any destructive git command without explicit confirmation from the user.

## Confidentiality

Private & Confidential — Property of Lifescope Inc. Do not distribute.
