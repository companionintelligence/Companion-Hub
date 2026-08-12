# Desktop System — CI-Hub

> **Purpose:** Tauri 2 native shell — system tray, hub lifecycle, Docker checks, deep linking.
> **Scope:** `packages/desktop/` — Rust hub_manager, compose resources, Tauri commands.
> **Key paths:** `packages/desktop/src-tauri/src/hub_manager.rs`, `packages/desktop/src-tauri/resources/`
> **Commands:** `pnpm run local:desktop`, `cd packages/desktop/src-tauri && cargo test`
> **Owner persona:** maintainability + security
> **Last updated:** 2026-07-12
> **Related:** docs/system/frontend.md, docs/AUTO_HEALING.md

---

## Layout

```
packages/desktop/
  src-tauri/src/
    hub_manager.rs       Hub status, startup progress, optional sidecar states
    commands/            Tauri invoke handlers
  src-tauri/resources/
    docker-compose.prod.yml   Production compose bundled with desktop app
```

## Hub manager

`hub_manager.rs` reports hub status to the frontend via `get_hub_status_command`:

- `DockerNotAvailable` | `Stopped` | `Starting` | `Running` | `Error`
- Optional sidecars (Tailscale, cloudflared, Ollama): only `Ready` or `Unavailable` — never `Starting`/`Failed`
- Optional sidecars must not block `all_ready`

## Running locally

```bash
pnpm run local:desktop   # Tauri against source-dev stack
pnpm run dev:desktop     # Tauri against .env.dev appliance stack
```

macOS signing identity in `tauri.conf.json` — devs without cert see TCC prompts.

## Compose lifecycle

Desktop app spawns `docker compose` against bundled `docker-compose.prod.yml`.

Container identity: `CI_HUB_CONTAINER_UID/GID`, `DOCKER_GID` env vars from `resolve_hub_container_identity()`.

## Testing

```bash
cd packages/desktop/src-tauri && cargo test
```

CI: `.github/workflows/desktop-tests.yml` on `packages/desktop/**` changes.

## Agent notes

- Rust + TypeScript boundary: frontend calls Tauri commands, not Rust directly
- Reload/watchdog interactions can restart stack — see hub-status frontend gate
- Update both Rust tests and hub-status.test.tsx for status behavior changes
