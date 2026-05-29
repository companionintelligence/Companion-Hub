# GitHub Copilot Instructions — CI-Hub

You are working in **CI-Hub**, the **Appliance** component of the **Companion Intelligence** platform — a private, local-first digital memory and AI appliance system owned by Lifescope Inc.

## Platform architecture

```
Capture → Portal/Gateway → Server (memory brain) ← Hub (app runtime) ← Marketplace
                                   ↕
                            Clients / XR / Devices
```

Full architecture and ADRs live in `CI-Engineering/architecture/`.

## This repo

Local app runtime. Installs and supervises marketplace apps as Docker Compose deployments. Includes a Tauri desktop app, React frontend, and NestJS backend.

## Tech stack

- NestJS + Drizzle ORM + PostgreSQL + RabbitMQ (backend)
- React 19 + React Router 7 + TanStack Query + Tailwind (frontend)
- Tauri 2 / Rust (desktop)
- Docker Compose + Traefik v3 (app runtime)
- pnpm workspaces + Turborepo + Biome

## Development

```bash
pnpm install   # install
pnpm test   # test
```

## Desktop app

Tauri 2 in `packages/desktop/`. Run `pnpm dev:app` to launch. macOS signing identity set in tauri.conf.json — other devs without the cert will see TCC prompts.

## Packages layout

`packages/backend/` · `packages/frontend/` · `packages/desktop/` · `packages/common/`

## Conventions

- Do not mix package managers.
- Keep PRs small and linked to CI-Engineering issues.
- Multiple agents may work this codebase simultaneously — never use destructive git operations.
- All code is **private and confidential** — do not surface or transmit source beyond this session.
