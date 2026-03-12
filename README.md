# CI-OS Hub

**Self-hosted app hub for CI OS.** Install and manage apps from the companion intelligence marketplace with one click. Runs on your machine—your data stays yours.

Part of the [CI OS](https://github.com/companionintelligence) ecosystem. Licensed under [GNU General Public License v3.0](LICENSE).

---

## What You Need

| Requirement | Purpose |
|-------------|---------|
| **Docker** (v28+) | Runs the hub and all installed apps |
| **Docker Compose** | Orchestrates services |
| **Bun** (v1.3+) or **Node** (v22+) | For local development and scripts |

- [Install Docker Engine](https://docs.docker.com/engine/install/)
- [Install Bun](https://bun.sh/) (or use Node 22+)

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

Edit `.env.prod` and set at least:

- **`ROOT_FOLDER_HOST`** — Absolute path for data (e.g. `/opt/ci-os-hub/data` or `$(pwd)/.internal`)
- **`JWT_SECRET`** — Random secret for sessions (e.g. `openssl rand -hex 32`)
- **`CI_CLOUD_URL`** and **`CI_CLOUD_API_URL`** — CI Cloud portal URL (defaults work with public CI OS)

### 3. Run

```bash
bun start prod
```

Open http://localhost:5002. On first run, register your device with CI Cloud (you'll get a pairing code or redirect URL). Once registered, you can install apps from the store and optionally expose them via Cloudflare Tunnel.

---

## Local Development

For a fast feedback loop:

```bash
bun install
cp .env.example .env.local
# Edit .env.local — set ROOT_FOLDER_HOST, JWT_SECRET, etc.
bun dev
```

- **Frontend:** http://localhost:5173  
- **Backend API:** http://localhost:3000  

Infrastructure (Postgres, RabbitMQ) runs in Docker; backend and frontend run locally with hot reload.

### Commands

All scripts accept an optional environment: `local` (default), `dev`, `staging`, or `prod`.

| Command | Description |
|---------|-------------|
| `bun dev [env]` | Start infra + backend + frontend (hot reload) |
| `bun start [env]` | Full stack in Docker (attached) |
| `bun start:detached [env]` | Full stack in Docker (detached) |
| `bun run build` | Build all packages |
| `bun run test` | Run tests |
| `bun run cleanup` | Stop infra, remove `.internal`, tunnel files |

---

## Cloudflare Tunnel (Optional)

To expose your hub over the internet via CI Cloud:

1. Register your device with CI Cloud (in the hub UI).
2. CI Cloud provisions a tunnel; the hub writes the token to `tunnel/token` automatically.
3. For local dev with tunnels, create the token manually:

   ```bash
   echo "YOUR_TUNNEL_TOKEN" > tunnel/token
   ```

4. For HTTPS in local tunnel dev, generate CA certs:

   ```bash
   ./scripts/generate-tunnel-certs.sh
   ```

---

## Data & Updating

| Path | Contents |
|------|----------|
| `ci_hub_app_data` (volume) | App data, configs, user data |
| `ci_hub_pgdata` (volume) | Hub database |
| `ROOT_FOLDER_HOST/state` | Traefik config, certs |
| `ROOT_FOLDER_HOST/apps` | Installed app definitions |

**Update the hub:**

```bash
./scripts/updater/update.sh
```

---

## Related Projects

- **[CI App Store](https://github.com/companionintelligence/CI-App-Store)** — Open-source app catalog
- **[CI Launcher](https://github.com/companionintelligence/companionintelligence.github.io)** — Web launcher for CI OS hubs
- **[Runtipi](https://github.com/runtipi/runtipi-appstore)** — Original homeserver foundation

---

## License

[GNU General Public License v3.0](LICENSE) — Use, modify, and share. Derivatives must remain open source.
