<p align="center">
  <img src="docs/ftue.gif" alt="Companion Hub onboarding walkthrough" width="720" />
</p>

# [Companion Hub](https://ci.computer/hub)

**Self-hosted app platform.** Install and manage Docker apps from the Companion Intelligence marketplace with one click. Your machine, your data.

Part of the [CI OS](https://github.com/companionintelligence) ecosystem. Licensed under [GNU Affero General Public License](LICENSE).

---

## Features

- **One-click app installs** — Browse the app store, pick an app, configure it via a dynamic form, and it's running in seconds
- **Automatic reverse proxy** — Every app gets its own subdomain via Traefik with automatic TLS
- **Cloudflare Tunnel** — Optionally expose your hub and apps to the internet through CI Cloud
- **Private VPN** — Built-in Headscale/Tailscale support for encrypted peer-to-peer remote access
- **Desktop app** — Native Tauri app for macOS, Windows, and Linux with system tray, mDNS discovery, and deep linking
- **Real-time status** — Server-Sent Events stream app logs and status changes live to the dashboard
- **Backup & restore** — Per-app backup/restore via compressed archives with configurable retention
- **Custom apps** — Define your own Docker Compose apps directly in the Hub UI
- **Multi-language** — i18n support with community translations via Crowdin
- **Two-factor auth** — TOTP-based 2FA, Argon2 password hashing, JWT sessions

---

## CI-Portal — Cloud Control Plane

<p align="center">
  <img src="docs/ci-portal/ci-portal.gif" alt="CI-Portal app launcher walkthrough" width="720" />
</p>

[CI-Portal](https://github.com/companionintelligence/CI-Portal) is the cloud-hosted companion to CI-Hub — providing OIDC identity, device registry, marketplace distribution, and a unified app launcher so you can reach all your self-hosted apps from any browser.

---

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Backend** | NestJS 11, Drizzle ORM, PostgreSQL 14, RabbitMQ 4, Zod, Winston |
| **Frontend** | React 19, React Router 7, TanStack Query, Zustand, Tailwind CSS 4, Radix UI |
| **Desktop** | Tauri 2 (Rust), deep linking (`cihub://`), mDNS hub discovery |
| **Infrastructure** | Docker Compose, Traefik v3, Cloudflare Tunnel, Headscale, Tailscale |
| **Tooling** | TypeScript 5, pnpm workspaces, Turborepo, Biome, Playwright, Vitest |
| **CI/CD** | GitHub Actions, GHCR image registry, Cloudflare Workers (Durable Objects) |

---

## Project Structure

```
packages/
  backend/      NestJS API — app lifecycle, Docker management, auth, queue workers
  frontend/     React SPA — dashboard, app store, settings, real-time logs
  common/       Shared Zod schemas, TypeScript types, app URN utilities
  desktop/      Tauri native wrapper — system tray, Docker checks, hub discovery
scripts/        Dev tooling — start, cleanup, e2e runner, app scaffolding, fleet QA
e2e/            Playwright end-to-end tests (auth, apps, lifecycle, settings)
docs/           Supplementary documentation
tunnel/         Cloudflare tunnel token and certificates
```

> For a deep dive into how the Hub works internally, see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
> For how the Hub, Portal, and App Store work together as a platform, see **[docs/PLATFORM_ARCHITECTURE.md](docs/PLATFORM_ARCHITECTURE.md)**.

---

## Requirements

| Requirement | Purpose |
|-------------|---------|
| **Docker** (v28+) | Runs the hub and all installed apps |
| **Docker Compose** | Orchestrates services |
| **pnpm** (v10+) and **Node** (v22+) | Local development and scripts |

- [Install Docker Engine](https://docs.docker.com/engine/install/)
- [Install pnpm](https://pnpm.io/installation) and Node 22+

---

## Quick Start

### 1. Clone

```bash
git clone https://github.com/companionintelligence/CI-OS-Hub.git
cd CI-OS-Hub
```

### 2. Configure

```bash
cp .env.example .env.prod
```

Set at minimum:

- **`ROOT_FOLDER_HOST`** — Absolute path for persistent data (e.g. `/opt/ci-os-hub/data`)
- **`JWT_SECRET`** — Random secret (`openssl rand -hex 32`)

### 3. Run

```bash
pnpm start:prod
```

Open **http://localhost:5002**. Register your device with CI Cloud on first run, then install apps from the store.

---

## CLI / TUI

The packaged executable is **`cihub`**. It auto-detects first-time setup and shows a guided FTUE wizard.

```bash
cihub wizard              # guided first-time setup (FTUE) or action menu
cihub status              # show running containers + resolved config
cihub up                  # start the Hub stack
cihub app status          # color-coded container health
cihub app logs <name>     # stream container logs
cihub --help              # full command reference
```

Install:

```bash
npm install -g ci-hub
npx --package ci-hub cihub --help
```

Homebrew and other package managers expose the same `cihub` executable on `PATH`.

See **[docs/CLI.md](docs/CLI.md)** for the full reference.

---

## Development

```bash
pnpm install
cp .env.example .env.local
# Edit .env.local — set ROOT_FOLDER_HOST, JWT_SECRET
pnpm dev
```

- **Frontend:** http://localhost:5173
- **Backend API:** http://localhost:3000

Infrastructure (PostgreSQL, RabbitMQ) runs in Docker; backend and frontend run locally with hot reload.

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start infra + backend + frontend with hot reload |
| `pnpm start [env]` | Full stack in Docker (attached) |
| `pnpm start:detached [env]` | Full stack in Docker (background) |
| `pnpm run hub -- wizard [env]` | Guided first-time setup or action menu |
| `pnpm run hub -- status [env]` | Show running containers + resolved config |
| `pnpm run hub -- up [env]` | Start the hub stack |
| `pnpm run hub -- shutdown [env]` | Stop the hub stack |
| `pnpm run hub -- setup [env]` | Initialize Traefik and Docker auth config |
| `pnpm run hub -- register [env]` | Print cloud portal registration URL |
| `pnpm run hub -- purge [--yes]` | Full clean: Docker + XDG config/cache dirs |
| `pnpm run hub -- hot-reload [env]` | Infra up + backend/frontend from source |
| `pnpm run hub -- app status [name]` | Color-coded container health |
| `pnpm run hub -- app logs <name>` | Stream container logs |
| `pnpm run hub -- app inspect <name>` | Show container ports, env, mounts |
| `pnpm run hub -- app list\|add\|edit\|start\|stop\|restart\|delete` | Container lifecycle |
| `pnpm run hub -- mcp setup\|shutdown\|config [env]` | MCP lifecycle commands |
| `pnpm run hub -- man` | Manual-style CLI reference |
| `pnpm run hub -- --help` | Full command reference |
| `pnpm run test:cli` | CLI/TUI presentation tests (25 cases) |
| `pnpm run build` | Build all packages via Turborepo |
| `pnpm run test` | Unit tests |
| `pnpm test:e2e` | Playwright end-to-end tests |
| `pnpm run cleanup` | Tear down containers, remove `.internal/` data |
| `pnpm dev:desktop` | Launch Tauri desktop app in dev mode |

Environments: `local` (default), `dev`, `staging`, `prod`.

On-device CLI/TUI iteration loop:

```bash
pnpm run hub -- purge --yes
pnpm run hub -- hot-reload local
pnpm run test:cli
```

See [e2e/README.md](e2e/README.md) for the E2E test matrix, including the AI-driven App Explorer Test.

---

## Networking

### Cloudflare Tunnel (optional)

Register your device with CI Cloud in the hub UI. CI Cloud provisions a tunnel and the hub writes the token to `tunnel/token` automatically. For local dev:

```bash
echo "YOUR_TUNNEL_TOKEN" > tunnel/token
./scripts/generate-tunnel-certs.sh   # HTTPS certs for local tunnel
```

### Private VPN (Tailscale, optional)

Use Tailscale when you want private remote access to the Hub and its apps without exposing them publicly.

- Set up Tailscale from the onboarding flow or **Settings → Network**
- Use **`TAILSCALE_AUTHKEY`** for unattended deployments
- Access the Hub with its Tailscale hostname and expose apps privately with the **Tailscale** exposure mode

See **[docs/private-vpn.md](docs/private-vpn.md)** for setup, URL examples, troubleshooting, and the recommended remote administration workflow.

---

## Data Layout

```
$ROOT_FOLDER_HOST/
  apps/          Installed app definitions (docker-compose files)
  app-data/      Per-app persistent data volumes
  repos/         App store git repositories
  state/         Traefik config, Headscale state, TLS certs
  backups/       Compressed app backup archives
  logs/          Application logs
  user-config/   Per-app user overrides
  media/         Uploaded media
```

**Update the hub:** `./scripts/updater/update.sh`

---

## Related Projects

- **[CI App Store](https://github.com/companionintelligence/CI-App-Store)** — Open-source app catalog
- **[CI Portal](https://github.com/companionintelligence/CI-Portal)** — Cloud portal for device registration, tunnel management, and the marketplace API
- **[CI Launcher](https://github.com/companionintelligence/companionintelligence.github.io)** — Web launcher for Hub

---

## License

[GNU Affero General Public License](LICENSE) — Use, modify, and share. Derivatives must remain open source.
