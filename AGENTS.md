# AGENTS.md — CI-Hub

## Platform context

CI-Hub is the **Appliance** layer component of the Companion Intelligence platform — a private, local-first digital memory system.

Full architecture: `CI-Engineering/architecture/architecture.md`

## Repo summary

Local app runtime. Installs and supervises marketplace apps as Docker Compose deployments. Includes a Tauri desktop app, React frontend, and NestJS backend.

## Stack

- NestJS + Drizzle ORM + PostgreSQL + RabbitMQ (backend)
- React 19 + React Router 7 + TanStack Query + Tailwind (frontend)
- Tauri 2 / Rust (desktop)
- Docker Compose + Traefik v3 (app runtime)
- pnpm workspaces + Turborepo + Biome

## Setup & commands

```bash
pnpm install   # install
pnpm run local   # source-based local dev
pnpm run dev   # dev appliance stack (.env.dev)
pnpm test   # test
pnpm build   # build
```

## Desktop app

Tauri 2 in `packages/desktop/`. Run `pnpm run local:desktop` to launch against the local source-dev stack, or `pnpm run dev:desktop` for the `.env.dev` appliance stack. macOS signing identity set in tauri.conf.json — other devs without the cert will see TCC prompts.

## Packages layout

`packages/backend/` · `packages/frontend/` · `packages/desktop/` · `packages/common/`

## Dev-only tooling

`agent/` at the repo root is a local dev helper (separate npm lockfile). It is not part of the pnpm workspace or CI — do not import it from Hub packages.

## Git discipline

- Never `git reset --hard` or `git clean -f` without user confirmation.
- Commit messages: imperative mood, ≤ 72 chars.
- Reference CI-Engineering issues in PRs (e.g. `Closes companionintelligence/CI-Engineering#32`).

## Confidentiality

Private & Confidential — Property of Lifescope Inc. Do not distribute.
