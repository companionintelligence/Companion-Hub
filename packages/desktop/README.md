# Companion Hub Desktop

Native desktop wrapper for the Companion Intelligence Hub, built with [Tauri v2](https://v2.tauri.app).

## Features

- **Native window** — Loads the Hub web UI in a performant WebView
- **System tray** — Shows Hub connection status, quick access to open/quit
- **mDNS discovery** — Auto-discovers Hub instances on the local network
- **Window state** — Remembers size and position between sessions
- **Native notifications** — Via Tauri notification plugin (for install progress, etc.)
- **Cross-platform** — Builds for macOS, Windows, and Linux

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Bun](https://bun.sh/) (for frontend build)
- Platform dependencies for Tauri:
  - **macOS:** Xcode Command Line Tools
  - **Linux:** `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`
  - **Windows:** WebView2 (ships with Windows 11, auto-installs on Windows 10)

## Development

From the repo root:

```bash
bun run dev:desktop
```

Or from this directory:

```bash
cargo tauri dev
```

This starts the frontend dev server and opens the Tauri window pointing at it.

## Building

```bash
bun run build:desktop
```

Produces platform-specific installers in `src-tauri/target/release/bundle/`.

## Architecture

```
packages/desktop/
├── package.json          # npm scripts for dev/build
├── README.md
└── src-tauri/
    ├── Cargo.toml        # Rust dependencies
    ├── tauri.conf.json   # Tauri configuration
    ├── build.rs
    ├── icons/            # Generated app icons
    └── src/
        ├── main.rs       # App entry, setup, window state persistence
        ├── lib.rs         # Library re-exports
        ├── tray.rs        # System tray with health-check status loop
        └── discovery.rs   # mDNS/Bonjour Hub discovery
```

The desktop app does **not** duplicate the frontend. It either:
- **Dev mode:** Connects to the frontend dev server (`localhost:9091`)
- **Production:** Bundles the pre-built frontend static files from `packages/frontend/build/client`

Hub backend connection defaults to `localhost:5002`. The mDNS discovery command (`discover_hubs`) can find Hub instances on the LAN.

## Configuration

Window geometry is persisted automatically via `tauri-plugin-store` in the app's data directory.

Hub URL and other settings can be extended via the store or Tauri's IPC commands.
