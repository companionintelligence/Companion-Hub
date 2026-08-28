# Desktop System — CI-Hub

> **Purpose:** Tauri 2 native shell — system tray, hub lifecycle, Docker checks, deep linking.
> **Scope:** `packages/desktop/` — Rust hub_manager, compose resources, Tauri commands.
> **Key paths:** `packages/desktop/src-tauri/src/hub_manager.rs`, `packages/desktop/src-tauri/resources/`
> **Commands:** `pnpm run local:desktop` (Vite :5005), `pnpm run dev:desktop` (appliance :5002), `cd packages/desktop/src-tauri && cargo test`
> **Owner persona:** maintainability + security
> **Last updated:** 2026-08-28
> **Related:** docs/system/frontend.md, docs/DESKTOP-UI-ARCHITECTURE.md, docs/AUTO_HEALING.md

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
pnpm run local            # Source Nest :5004 + Vite :5005 (db/queue only in Docker)
pnpm run local:desktop    # Tauri WebView → Vite :5005
pnpm run dev              # Docker appliance (API + SPA) on :5002 — product path
pnpm run dev:desktop      # Tauri WebView → :5002 (stack-dev; does not spawn a second Hub)
```

macOS signing identity in `tauri.conf.json` — devs without cert see TCC prompts.

Dev Portal is `https://hub.companionintelligence.com`. Production Portal is `https://hub.ci.computer`. `local:desktop` / `dev:desktop` force `CI_HUB_ENVIRONMENT=development` so a stray `CI_HUB_ENVIRONMENT=production` in `.env.dev` cannot compile the Tauri binary against prod. The appliance image still honors `CI_CLOUD_URL` from `.env.dev`.

`pnpm run dev` always passes `docker compose up --build`. A source image build needs `NODE_AUTH_TOKEN` (GitHub `read:packages` for `@companionintelligence/tokens`). To skip the build, set `CI_HUB_IMAGE` in `.env.dev` so `docker-compose.dev-image.yml` pulls `ghcr.io/companionintelligence/ci-hub:dev` (or the tag you set).

## Two stacks — do not mix

The **product** Hub is the Docker appliance on **`:5002`**. Browser tabs and packaged / `dev:desktop` Tauri all load that origin. `local` + `local:desktop` is a source-iteration exception (Vite `:5005` → Nest `:5004`). Almost every "OIDC is broken / cloud connect on Linux / stale token" bug we hit was two Hubs or two origins answering the same Portal callback.

| Assumption that is false while `local:desktop` is up | What is actually true |
|---|---|
| "The Hub is on `:5002`" | UI + SSO + session cookie are on **`:5005`**. `:5004` is Nest only. A leftover appliance on `:5002` is a *different* Hub. |
| "Browser Companion Account stays in the browser" | Tauri heartbeats `GET /api/auth/portal/session-hint?desktop=1` (10 min cache). Loopback `/portal/start` **without** `desktop=1` still hands off to `cihub-dev://` (`shouldHandoffPortalLoginToDesktop`). Stop Tauri (and wait out the cache, or restart the Hub) to test real `browser-hub-sso`. |
| "Cookies / one-time tokens are global" | They are origin-scoped. `localhost:5002`, `:5004`, and `:5005` do not share `ci-hub-session`. Portal PKCE state lives in the Hub process cache (`portal_sso:*` 10 min, `portal_sso_desktop:*` 60s) — exchanging a token minted on `:5005` against `:5002` is `Invalid or expired`. |
| "`pnpm run local` and `pnpm run dev` can run together" | They share Postgres (`:6543`) and the `ci-hub` compose project. Starting one recreates db/queue and kills the other. `.env.dev` maps RabbitMQ at **`:5001`**; `docker-compose.local.yml` uses **`:5672`**. |
| "`local:desktop` will not start Docker" | `local:desktop` is **not** stack-dev. `hub_manager` still initializes `~/.local/share/companion-hub` and may `compose up` the installed appliance onto `:5002`. Use `dev:desktop` when the Hub should be the `:5002` container. |
| "`cihub://` reaches this checkout" | Loopback handoff uses **`cihub-dev://`**. Packaged / public-URL handoff uses **`cihub://`**, which Linux `xdg-mime` often binds to the *installed* Companion Hub. Confirm `xdg-mime query default x-scheme-handler/cihub-dev`. |
| "A Cursor port-forward of `:5005` is the phone app" | It is a **browser**. Cloud connect is iOS/Android only (`usesCloudConnect()`). Leftover `sessionStorage` `cihub.isTauriMobile` or a shared Vite with `VITE_HUB_RUNTIME=mobile` used to send that tab to `/connect`. |
| "`.env.dev` `CI_HUB_ENVIRONMENT=production` means prod Portal" | This repo's `.env.dev` can say `production` while `CI_CLOUD_URL` is still the **dev** Portal. Do not mix `hub.ci.computer` callbacks into a Hub whose `CI_CLOUD_URL` is `hub.companionintelligence.com`. |
| "`API_PORT` in `.env.dev` is what compose binds" | A leftover shell `API_PORT=5004` (from `pnpm run local`) **overrides** the file. The appliance then publishes `0.0.0.0:5004->5002` and browser OIDC looks "broken" because you are still hitting the wrong origin. Unset `API_PORT` / `FRONTEND_PORT` / `RABBITMQ_PORT` before `pnpm run dev`. Confirm with `docker ps` that `ci-os-hub` is `5002->5002`. |
| "Shared Postgres means the same Hub identity" | Appliance data (registration, tunnel token, device id) lives under `~/.local/share/companion-hub`. `pnpm run local` uses `ci-hub/.internal`. The source Nest can report `unregistered` while `:5002` is `locally_ready`. |

### Stale client state to clear after a stack switch

In DevTools on **each** origin you opened (`:5002`, `:5005`, the port-forward):

- `sessionStorage`: `cihub.isTauriMobile`, `cihub.isTauriDesktop`, `ci-hub.pending-desktop-portal-token`
- `localStorage`: `cihub.oidc.pending`, `cihub.oidc.callback`, `ci-hub-session`, `ci-hub-session-issued-at`, `ci-hub.portalAccountEmail`
- Cookies: `ci-hub-session`

Authorization codes and desktop-exchange tokens are single-use. Restarting the Hub process drops in-memory Portal SSO state. Do not keep both stacks up "so the old token still works."

### Which command for which test

- **Browser or desktop Companion Account against dev Portal** — `pnpm run dev` + browser on `http://localhost:5002` (stop Tauri first for true browser cookies) or `pnpm run dev:desktop`.
- **Frontend source iteration** (cloud-connect gate, login UI) — `pnpm run local` + `local:desktop`. Expect SSO to stay on `:5005`. Do not also run the appliance.
- **iOS/Android cloud connect** — `ios:dev` / `android:dev` (`lvh.me` or device), never a Linux Chrome tab.

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
- Linux GTK3 pins `glib` 0.18.5. `[patch.crates-io]` in `src-tauri/Cargo.toml` (and the mobile twin) overlays `third_party/glib-0.18.5` with the GHSA-wrw7-89jp-8q8g backport. Drop it when Tauri ships glib >= 0.20.
