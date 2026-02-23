# CI-OS-Hub

REQUIRED: APP STORE
https://github.com/companionintelligence/CI-App-Store

APP STORE LAUNCHER
https://github.com/companionintelligence/companionintelligence.github.io

Based on Runtipi — A personal homeserver for everyone

https://github.com/runtipi/runtipi-appstore

https://www.runtipi.io/docs/getting-started/installation?utm_source=github&utm_campaign=readme

https://forums.runtipi.io

## Desktop Application

CI OS Hub is now available as a native desktop application for Windows, macOS, and Linux! 

The desktop app provides:
- Native system integration and system tray support
- Cross-platform installers (MSI/NSIS for Windows, DMG for macOS, AppImage/DEB for Linux)
- Automatic backend lifecycle management
- Foundation for future automation features (WSL2/Docker setup, installation wizard, cloud instance management)

See [`src-tauri/README.md`](src-tauri/README.md) for desktop development documentation.

### Quick Start - Desktop

```bash
# Development mode
bun run dev:desktop

# Build desktop installers
bun run build:desktop
```

# Running locally

In this guide we will show you how to run Runtipi locally on your machine. This is useful if you want to contribute to the project or if you want to test new apps you added to the appstore.

## Prerequisites

- Docker desktop version 28 or later. Instructions: [Install Docker Engine](https://docs.docker.com/engine/install/)
- Docker-compose
- Node version 22+

## Prepare

Once you have forked the repository and cloned it on your local machine you can start to prepare the environment.

## Install dependencies

runtipi uses [`bun`](https://bun.com/) as its JavaScript runtime and package manager, and `turbo.js` as its monorepo orchestrator. Install Bun using the instructions from the [official Bun website](https://bun.com/).

Install the project dependencies
`bun install`

## Edit the environment variables

You need to copy `.env.example` to `.env`

## Cloudflare Tunnel Token

To enable the Cloudflare Tunnel integration (exposed apps), you must have a valid tunnel token.
Place your token in the `tunnel/token` file:

`echo "YOUR_TUNNEL_TOKEN" > tunnel/token`

This token allows the `cloudflared` daemon to authenticate with Cloudflare.

## Generate Tunnel Certificates

If you are working with the Cloudflare Tunnel integration (exposed apps), you need to generate a local Certificate Authority. This allows the `cloudflared` daemon to trust your local HTTPS services.

Run the helper script:
`./scripts/generate-tunnel-certs.sh`

This will create `tunnel/certs/custom-ca.pem` and `custom-ca.key`.

## Run CI OS Hub locally

We have consolidated the local development workflow into a single command.

### `bun dev` (Recommended)

This is the main command for local development. It does the following:
1. Starts the required infrastructure (Postgres DB, RabbitMQ) in Docker containers in the background.
2. Starts the Backend (NestJS) in watch mode.
3. Starts the Frontend (React Router) in HMR mode.

Both the backend and frontend will hot-reload on file changes.

### Other Commands

- `bun run build`: Builds all packages.
- `bun run test`: Runs all tests.
- `bun run cleanup`: Stops infrastructure containers and removes temporary files/directories (`.internal`, certs).
- `bun run start:docker`: Runs the entire stack (including the Hub app itself) inside Docker containers. This is closer to how it runs in production but slower for development loop.
- `bun run start:prod`: Simulates a production environment (uses production env vars and connects to live cloud APIs).
- `bun run start:staging`: Simulates staging environment (connects to companionintel.com API).
- `bun run start:cloud-dev`: Simulates development environment (connects to portal.companionintelligence.com API).

### Accessing the App

Once `bun dev` is running:
- **Frontend** is available at `http://localhost:5173` (or the port shown in terminal).
- **Backend API** is available at `http://localhost:3000`.

## Data Persistence

### Critical Data Paths

| Path (container) | Volume Type | Contents | Survives Update? |
|---|---|---|---|
| `/app-data` | Named volume (`ci_hub_app_data`) | App databases, configs, user data | ✅ Yes |
| `/var/lib/postgresql/data` | Named volume (`ci_hub_pgdata`) | Hub database | ✅ Yes |
| `/data/state` | Bind mount | Traefik config, ACME certs, seed | ✅ Yes (if paths correct) |
| `/data/apps` | Bind mount | Installed app definitions | ✅ Yes (if paths correct) |
| `/data/user-config` | Bind mount | User app overrides | ✅ Yes (if paths correct) |
| `/app` | Ephemeral | Hub application code | ❌ Rebuilt on update |

### ROOT_FOLDER_HOST

`ROOT_FOLDER_HOST` **must** be set to an absolute host path in `.env` (e.g., `/opt/ci-os-hub/data`). This path is used to generate Docker volume mounts for installed apps. The Hub will refuse to start if it's relative.

### Updating the Hub

Use the update script for safe updates:

```bash
./scripts/updater/update.sh
```

The script performs pre-flight checks, creates a database backup, pulls new images, restarts services, and verifies data integrity.

### Migrating Existing Installs

If upgrading from a version that used bind mounts for app-data:

```bash
./scripts/migrate-to-named-volumes.sh [--dry-run]
```

This copies data from `.internal/app-data` into the `ci_hub_app_data` named volume. The original data is preserved as a backup.

### Health Checks

- `GET /api/health` — Standard health check (database, queue)
- `GET /api/health/data` — Data integrity check (verifies all critical directories exist and are writable)