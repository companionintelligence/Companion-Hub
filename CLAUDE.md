# CLAUDE.md — Companion Hub

Doc map, tip scrub policy, and writing style: [`docs/README.md`](docs/README.md), [`docs/writing-style.md`](docs/writing-style.md).

## Platform role

**Companion Hub** sits in the **Appliance** layer of the Companion Intelligence platform.

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

- Pulls app manifests from CI-Marketplace through the Portal distribution edge
- Routes installed apps through CI-Gateway (Traefik) on *.ci.localhost
- Checks entitlements with Portal before installs: companionintelligence/CI-Hub#722
- Installs Memory alongside marketplace apps

## Desktop app

Tauri 2 in `packages/desktop/`. Run `pnpm run local:desktop` to launch against the local source-dev stack, or `pnpm run dev:desktop` for the `.env.dev` appliance stack. macOS signing identity set in tauri.conf.json — other devs without the cert will see TCC prompts.

## Releases

A Hub release is one Desktop Release run (`.github/workflows/desktop-release.yml`) from `dev` with `environment=production`, `prerelease=false` and `platforms=all`. It builds the `ci-hub` image, the installers for six desktop platforms and the `cihub` CLI, uploads them to dl.ci.computer (which moves the auto-update feed) and updates Homebrew and Scoop. Its last job runs `scripts/release-check.mjs` and writes a table to the run page of every place the release should be and what each one has.

Run the same check any time with `node scripts/release-check.mjs`. Add `--version 0.3.14` for another release and `PLAY_KEY_FILE=<key.json>` for the Google Play rows. The download page, the CI-OS pin and the phone stores are updated outside Desktop Release, so the table shows them behind until someone does.

The phone apps build in `mobile-build.yml`. Its signed release jobs show as skipped until their signing secrets are in the production Environment.

## Packages layout

`packages/backend/` · `packages/frontend/` · `packages/desktop/` · `packages/common/`

## Multi-agent safety

Multiple AI agents work these repos in parallel. Never use `git reset --hard`, `git clean -f`, or any destructive git command without explicit confirmation from the user.

