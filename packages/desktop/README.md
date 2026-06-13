# Companion Hub Desktop

Native desktop wrapper for the Companion Intelligence Hub, built with [Tauri v2](https://v2.tauri.app).

## Features

- **Native window** — Loads the Hub web UI in a performant WebView (WebKitGTK on Linux, WebView2 on Windows, WKWebView on macOS)
- **Custom titlebar** — Platform-aware window controls (minimize/maximize/close) with drag region
- **System tray** — Hub health status, start/stop Docker containers, show/hide window, open Portal
- **Single instance** — Second launch focuses the existing window instead of opening a duplicate
- **mDNS discovery** — Auto-discovers Hub instances on the local network
- **Window state** — Remembers size and position between sessions
- **Cross-platform** — Builds for macOS (ARM64 + Intel), Windows (x64), and Linux (x64)

## Prerequisites

### All Platforms

- [Rust](https://rustup.rs/) (stable) — `rustup` will install `cargo`, `rustc`, etc.
- [pnpm](https://pnpm.io/) (≥ 10) — for frontend build and dependency management
- [Node.js](https://nodejs.org/) (≥ 22) — required by some build tooling
- [Git](https://git-scm.com/)

### macOS

```bash
# Xcode Command Line Tools (provides the C compiler and macOS SDK)
xcode-select --install
```

No additional system libraries needed — macOS uses the built-in WKWebView.

### Linux (Ubuntu/Debian)

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  pkg-config \
  curl \
  wget \
  file \
  libssl-dev \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libxdo-dev \
  patchelf
```

For building `.rpm` packages (optional):

```bash
sudo apt-get install -y rpm
```

For running `.AppImage` bundles:

```bash
sudo apt-get install -y libfuse2
```

### Windows

1. **Visual Studio Build Tools 2022** with the **"Desktop development with C++"** workload:

   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```

   > A restart may be required after installation.

2. **WebView2 Runtime** — ships with Windows 11. On Windows 10, it auto-installs or can be downloaded from [developer.microsoft.com/webview2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

3. **Rust** (if not already installed):

   ```powershell
   winget install Rustlang.Rustup
   ```

4. **Bun**:

   ```powershell
   winget install Oven-sh.Bun
   ```

**Important:** When building from a terminal (CMD/PowerShell), you must first load the VS build environment:

```cmd
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64
```

Or open the **"x64 Native Tools Command Prompt for VS 2022"** from the Start menu which does this automatically.

## Headless launch

When the packaged desktop binary is installed on a Linux machine without an attached GUI session, start the Hub runtime without opening Tauri:

```bash
companion-hub --detached
```

This runs the packaged Hub stack startup in detached mode, using the bundled compose resources and runtime env files, so it works over SSH without requiring `DISPLAY` or GTK initialization.

## Development

### 1. Install dependencies (from repo root)

```bash
pnpm install
```

### 2. Build the common package

```bash
pnpm run --filter=@ci-hub/common build
```

### 3. Start the Hub backend + frontend

The Tauri dev mode connects to the Vite frontend dev server at `http://localhost:5005`, which proxies API calls to the backend at `http://localhost:5004`.

**Option A — Docker (recommended for first setup):**

```bash
# From repo root — starts Postgres, RabbitMQ, backend, and frontend
docker compose -f docker-compose.local.yml up -d
```

**Option B — Native dev mode:**

```bash
# Start Postgres + RabbitMQ in Docker
docker compose -f docker-compose.local.yml up -d ci-hub-db ci-os-hub-queue

# Copy and configure .env.local with your local paths
cp .env.example .env.local
# Edit .env.local — set ROOT_FOLDER_HOST, CI_HUB_DATA_DIR, etc.

# Start backend + frontend
dotenv -e .env.local -- pnpm run dev:app
```

### 4. Start the Tauri dev app

**Prod stack + Tauri (same containers as desktop, no Vite):** from repo root, with `.env.dev` configured:

```bash
pnpm run dev:desktop
```

This starts the `.env.dev` appliance stack in the background, then opens Tauri with `tauri.stack-dev.json` (WebView loads the Hub in Docker, not the local Vite port).

Compose profiles: `private-vpn` (Tailscale) always; `cloudflare` (`cloudflared`) when `tunnel/token` exists next to `ROOT_FOLDER_HOST` (e.g. `ci-hub/tunnel/token` for `.internal`). Check with `cihub config dev`.

**Classic local source-dev + Tauri:**

From the repo root:

```bash
pnpm run local
pnpm run local:desktop
```

Or from this directory:

```bash
cargo tauri dev
```

This opens the Tauri window pointing at the Vite dev server. Hot-reload works for frontend changes. Rust changes require a recompile (automatic with `cargo tauri dev`).

**Windows:** Ensure you have the VS build environment loaded first (see Prerequisites above).

## Building

### Release build (from this directory)

```bash
cargo tauri build
```

Or from repo root:

```bash
pnpm run build:desktop
```

On Linux, the desktop build patches generated `.deb` bundles with a Debian `postrm` maintainer script so uninstall can remove Hub runtime state and related Docker resources.

**Important:** The frontend must be built first — the release build embeds static files from `packages/frontend/dist/client`:

```bash
# From repo root
pnpm run --filter=@ci-hub/common build
pnpm run --filter=frontend build
```

### Build output

| Platform | Artifacts | Location |
|---|---|---|
| **macOS** | `.app` bundle, `.dmg` installer | `src-tauri/target/release/bundle/macos/`, `bundle/dmg/` |
| **Windows** | `.msi` installer, NSIS `-setup.exe` | `src-tauri/target/release/bundle/msi/`, `bundle/nsis/` |
| **Linux** | `.deb`, `.rpm`, `.AppImage` | `src-tauri/target/release/bundle/deb/`, `bundle/rpm/`, `bundle/appimage/` |

Typical sizes: `.deb`/`.rpm`/`.msi` ≈ 7 MB, `.dmg` ≈ 6.5 MB, `.AppImage` ≈ 80 MB (bundles WebKitGTK).

### Cross-compilation

macOS ARM64 runners can cross-compile for Intel:

```bash
rustup target add x86_64-apple-darwin
cargo tauri build --target x86_64-apple-darwin
```

Cross-compiling between Linux/Windows/macOS is not supported by Tauri — use the CI workflow (`.github/workflows/desktop-build.yml`) which builds on native runners for each platform.

### Windows-specific notes

- Always run builds from a terminal with the VS build environment loaded
- If you see `error: no such command: tauri`, install the Tauri CLI:

  ```cmd
  cargo install tauri-cli --version "^2" --locked
  ```

- If Docker pulls fail from SSH sessions, the Docker Desktop credential helper may need to be cleared — see [Docker docs on credential stores](https://docs.docker.com/reference/cli/docker/login/#credential-stores)

## Architecture

```
packages/desktop/
├── package.json          # Build scripts (gracefully skip when cargo tauri unavailable)
├── README.md
├── TESTING.md            # WebDriver automation guide
└── src-tauri/
    ├── Cargo.toml        # Rust dependencies
    ├── tauri.conf.json   # App config, CSP, window settings
    ├── capabilities/     # Tauri v2 permission model
    │   └── default.json  # Window mgmt, shell, store, notification, OS permissions
    ├── icons/            # CI globe branding — all sizes
    └── src/
        ├── main.rs       # Entry point, plugin registration, window geometry persistence
        ├── lib.rs        # Library re-export
        ├── tray.rs       # System tray menu + background health-check loop
        └── discovery.rs  # mDNS/Bonjour Hub discovery
```

### How it works

- **Dev mode:** The Tauri WebView loads from `http://localhost:5005` (Vite dev server). The frontend proxies `/api/*` to the backend on port 5004.
- **Release mode:** The pre-built frontend static files are embedded in the binary from `packages/frontend/dist/client`. The backend must be running separately.
- **System tray:** Polls the Hub health endpoint every 10 seconds (tries both port 5002 for appliance mode and port 5004 for local source dev). Start/Stop Hub uses `docker start/stop` on the known container names.
- **Single instance:** Uses `tauri-plugin-single-instance` — a second launch sends focus to the existing window via IPC.
- **Close-to-tray:** The window close button hides to tray instead of quitting. Use "Quit" from the tray menu to actually exit.

## Configuration

- **Window geometry** — Persisted via `tauri-plugin-store` in the OS app data directory (`settings.json`)
- **App identifier** — `computer.ci.app.hub`
- **CSP** — Locked down in `tauri.conf.json` with exceptions for Vite HMR WebSocket, Tauri IPC, external images, and Google Fonts

## Troubleshooting

| Issue | Solution |
|---|---|
| `error: no such command: tauri` | Install: `cargo install tauri-cli --version "^2" --locked` |
| Windows build fails with "cannot compile" | Load VS env: `call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64` |
| Linux build fails with missing headers | Install all deps listed in Prerequisites → Linux section |
| App shows blank window | Ensure the frontend dev server is running on port 5005 (dev mode) or frontend was built (release mode) |
| Docker credential errors on Windows SSH | Clear `credsStore` in `~/.docker/config.json` |
| "Maximum number of active sessions" (WebDriver) | Kill stale `tauri-driver` and `WebKitWebDriver` processes |
