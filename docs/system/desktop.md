# Desktop system — Companion Hub

> **Purpose:** Tauri 2 native shell — system tray, hub lifecycle, Docker checks, deep linking.
> **Scope:** `packages/desktop/` — Rust hub_manager, compose resources, Tauri commands.
> **Key paths:** `packages/desktop/src-tauri/src/hub_manager.rs`, `packages/desktop/src-tauri/resources/`
> **Commands:** `pnpm run local:desktop` (Vite :5005), `pnpm run dev:desktop` (appliance :5002), `cd packages/desktop/src-tauri && cargo test`
> **Owner persona:** maintainability + security
> **Last updated:** 2026-10-10 (the Docker engine inside WSL)
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

## Startup screen

The startup screen has two halves that look the same: the release bootstrap page
(`packages/desktop/bootstrap/`, shown until the Hub API answers) and the in-app screens in
`packages/frontend/src/components/hub-status/hub-status.tsx`. Both poll
`get_startup_progress_command` (`hub_manager/status.rs`), which returns:

- Each core service's state: `pending`, `starting`, `ready`, `failed`, `stopped`, or `not_started`.
  An exited container only counts as `failed` when nothing explains it. If the user stopped the Hub,
  the container exited cleanly, or it is a leftover from before a start that is running now, it is
  not a failure. `detail` carries Docker's error or the exit code. `starting_secs` says how long a
  container has waited on its health check.
- `user_stopped` and `user_stopped_at_ms`, from the `.user-stopped` marker, so the screen can say
  the Hub is stopped straight away instead of timing out.
- `start_error` and `start_failed_at_ms`, from the sticky `.start-failed` marker.
- `docker_access`, `hub_api_live`, image pull counts, and `start_in_progress`.
- `docker_engine`: the engine the Hub runs on (`wsl-engine`, `desktop`, and so on), from the
  engine this process pinned or the last start recorded in `state/docker-engine.json`.
- `progress_pct`: the average of the service states. If a poll during the current start finds an
  image missing, downloads count for half of it until the Hub is ready, so a first start does not
  sit at the services' floor for the whole download.

The bootstrap page picks one screen from that data: starting, hasn't finished starting (after 3
minutes, not while images are still downloading), stopped, couldn't start, or Docker not running.
Each screen shows one action that fixes it. Pressing **Start Hub** switches to the starting screen
immediately.

### The Docker engine inside WSL

On Windows the Hub can run on Docker Engine inside a WSL2 distro instead of Docker Desktop
(`hub_manager/installers/engine_alt.rs`). WSL stops a distro soon after its last foreground process
ends, and systemd services such as dockerd don't count, so the installer's logon script keeps it up
with `wsl.exe -d <distro> -u root -- sleep infinity`. After `wsl --shutdown` or `wsl --terminate`,
the app starts that same command again (`hub_manager/wsl.rs`):

- When a status poll (`get_hub_status_command`, `get_startup_progress_command`, the tray's health
  check) finds Docker not answering on the WSL engine. It doesn't wait, starts at most one
  keepalive at a time, waits 30 seconds after an attempt before the next, and does nothing while
  the user has the Hub stopped.
- When a Hub start or the auto-start at launch finds the engine stopped. It then waits up to 90
  seconds for Docker to answer. If Docker still doesn't answer, the start fails with a message that
  starts with "Docker is not running", so it doesn't stick.
- On **Start engine** (`start_wsl_engine_command`), which the Docker screen shows instead of Docker
  Desktop's steps when `docker_engine` is `wsl-engine`. It waits like a start and returns why the
  engine didn't come back.

## Native inference runners

The desktop shell owns the best-effort native setup used by the onboarding FTUE. oMLX, on Apple Silicon, is installed with `brew tap jundot/omlx https://github.com/jundot/omlx`, then `brew install jundot/omlx/omlx`, then `omlx start`. vLLM is NVIDIA only and is not installed on Apple Silicon. Lemonade is operator-managed. MTPLX, mlx-dspark, Lucebox, llama.cpp, and LM Studio are not installed.

The frontend passes the selected runner. vLLM and Lemonade also install Ollama for embeddings. oMLX embeds itself. Runner logs and endpoints are persisted under the Hub data directory. On Linux, native runners are
supervised via per-user systemd services (`~/.config/systemd/user/computer.ci.companion-hub.inference.{runner}.service`)
with `Restart=on-failure` and enable/disable lifecycle matching the macOS LaunchAgent pattern.
Windows host runners retain the existing detached-process lifecycle; a future Windows-service layer remains open.

## Running locally

```bash
pnpm run local            # Source Nest :5004 + Vite :5005 (db/queue only in Docker)
pnpm run local:desktop    # Tauri WebView → Vite :5005
pnpm run dev              # Docker appliance (API + SPA) on :5002 — product path
pnpm run dev:desktop      # Tauri WebView → :5002 (stack-dev; does not spawn a second Hub)
```

macOS signing identity in `tauri.conf.json` — devs without cert see TCC prompts.

Dev Portal is `https://hub.companionintelligence.com`. Production Portal is `https://hub.ci.computer`. `local:desktop` / `dev:desktop` force `CI_HUB_ENVIRONMENT=development` so a stray `CI_HUB_ENVIRONMENT=production` in `.env.dev` cannot compile the Tauri binary against prod. The appliance image still honors `CI_CLOUD_URL` from `.env.dev`.

### Point a desktop Hub at another Portal

A published bundle compiles its Portal in (production: `https://hub.ci.computer`) and rewrites `CI_CLOUD_URL` in the Hub env files on every launch, so a hand edit to `CI_CLOUD_URL` lasts only until the next launch. To use another Portal, write its origin to the desktop's Portal URL override file. Every launch validates the file and writes that Portal into `CI_CLOUD_URL` in both env files.

| OS | Override file |
|---|---|
| Linux | `~/.config/computer.ci.app.hub/portal-url-override` (under `$XDG_CONFIG_HOME` when it's set) |
| macOS | `~/Library/Application Support/computer.ci.app.hub/portal-url-override` |
| Windows | `%APPDATA%\computer.ci.app.hub\portal-url-override` |

Switch to dev Portal (Linux shown):

```bash
# 1. Quit Companion Hub (tray → Quit).
mkdir -p ~/.config/computer.ci.app.hub
echo 'https://hub.companionintelligence.com' > ~/.config/computer.ci.app.hub/portal-url-override
# 2. Launch Companion Hub. It writes CI_CLOUD_URL into both env files and recreates ci-hub.
grep -h '^CI_CLOUD_URL=' ~/.local/share/companion-hub/.env ~/.local/share/companion-hub/.env.dev
grep 'Portal URL override' ~/.local/share/companion-hub/logs/desktop.log | tail -n 1
```

Switch back:

```bash
# Quit Companion Hub first.
rm ~/.config/computer.ci.app.hub/portal-url-override
# Launch Companion Hub. CI_CLOUD_URL returns to the Portal compiled into the build.
```

Rules:

- **Where it's read.** The app reads the override only from that file, and no container mounts the desktop's config dir. The app never reads an override from the Hub env files and never copies one into them, because the primary env file is mounted into `ci-hub` as `/data/.env` and the backend writes to it. A `CI_HUB_CLOUD_URL_OVERRIDE` line in an env file has no effect, and the next launch drops it.
- **Format.** The value is the first line that isn't blank or a `#` comment. Quotes around it are optional.
- **Allowed values.** The value must be a bare origin, `https://host[:port]`, with no path, query, fragment, or credentials. The host must be an IP address or a DNS name made of letters, digits, hyphens, and dots, with no trailing dot. Plain `http` is accepted only for `localhost`, `*.localhost`, `127.0.0.1`, and `[::1]`, for a local Portal.
- **Invalid values.** If the value is invalid or the file can't be read, the app ignores it and uses the compiled Portal. It leaves the file as it is and logs `Ignoring the Portal URL override in <file>: <reason>` to `logs/desktop.log` on every launch.
- **Logging.** A valid override logs `Portal URL override active: CI_CLOUD_URL=<url> from <file> ...` on every launch.
- **What follows it.** Everything that reads `CI_CLOUD_URL` from the env files follows the override:
  - the backend: pairing, check-in, the catalog, the tunnel API, Companion Account sign-in, and Bearer JWKS;
  - app OIDC issuer injection, and the `CI_CLOUD_URL` and `HUB_API_KEY` given to Memory;
  - desktop Sentry tags;
  - the bundled `cihub register`;
  - the tray's Account Management item, which opens the `CI_CLOUD_URL` the running stack started with.
- **What doesn't.** The SPA's own Sentry environment tag comes from the image build, so it doesn't follow.

**Registrations belong to one Portal.** Pairing stores a device key (`state/settings.json`), organization rows, and a tunnel token, and none of them records which Portal issued them. If you switch a paired Hub to another Portal, it keeps using them there:

- The Hub sends the old device key to the new Portal on check-in, catalog, and tunnel calls. The new Portal rejects check-in with 401. When the rejections have lasted 10 minutes, the Hub shows `degraded` (`portal_rejected`). It keeps the registration and accepts a new pairing from an authenticated caller (`cihub register --code`).
- The tunnel keeps serving the old Portal's hostname.
- Settings → Network → Reset this Hub only keeps the device key, and pairing sends it to the Portal you pair with as proof of possession. Pair a switched Hub only with a Portal you trust with that key.
- A reset never removes the device from a Portal, and removing it from the new Portal doesn't touch the old one. When you switch back, the old Portal may still list the device as active, and the pairing page offers to restore it.

The desktop doesn't warn about a switch, because nothing records which Portal issued a registration. To test against another Portal, use a Hub that isn't paired, or switch back before you rely on the paired Hub again.

`pnpm run dev` always passes `docker compose up --build`. The design tokens and brand files the image build needs are in this repo, so the build does not need a GitHub Packages token. To skip the build, set `CI_HUB_IMAGE` in `.env.dev` so `docker-compose.dev-image.yml` pulls `ghcr.io/companionintelligence/ci-hub:dev` (or the tag you set).

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
| "`API_PORT` in `.env.dev` is what compose binds" | A leftover shell `API_PORT=5004` (from `pnpm run local`) **overrides** the file. The appliance then publishes `0.0.0.0:5004->5002` and browser OIDC looks "broken" because you are still hitting the wrong origin. Unset `API_PORT` / `FRONTEND_PORT` / `RABBITMQ_PORT` before `pnpm run dev`. Confirm with `docker ps` that `ci-hub` is `5002->5002`. |
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

Before it starts the stack, `start_hub` checks the Docker it runs on (`hub_manager/docker_versions.rs`). The stack file's `gw_priority` needs Docker Compose 2.33 or newer and Docker Engine 28 or newer:

- An older Compose rejects the whole file with an error that doesn't mention Docker's version. The start stops with a message that names the Compose version found, and the failure sticks until the user tries again.
- An older Engine runs the file and ignores the setting. Measured on Engine 27.5.1 with Compose 5.1.4: `up` succeeded, and each container's default route went to the network that sorts first. The start goes on, and a `hub.start` line in `desktop.log` (shown by the start screen's View logs) warns that the Hub, Traefik, and the Tailscale helper may use the wrong network for internet and host traffic.
- A version that can't be read is logged to `desktop.log` and doesn't block the start.

`cihub up` runs the same check (`scripts/lib/docker-versions.ts`).

Container identity: `CI_HUB_CONTAINER_UID/GID`, `DOCKER_GID` env vars from `resolve_hub_container_identity()`.

The Hub's own Docker calls (its self-update, every app install and start) read `<data dir>/.docker/config.json`, mounted as `DOCKER_CONFIG=/data/.docker`. On every launch, `generate_container_docker_config` (`hub_manager/compose.rs`) writes it from the host's `~/.docker/config.json`, keeping only what works inside the container: inline registry auths, credential helpers that aren't host-only binaries, and the `proxies` section as it is. Docker Compose sets `HTTPS_PROXY`, `NO_PROXY`, and the rest from `proxies` in each container it creates, so the containers the Hub starts get the same proxy as the ones the desktop starts. `cihub setup` writes the same file (`scripts/init-docker-config.ts`).

## Host update listener

`companion-hub --update-listener` (`updater.rs`) listens on `0.0.0.0:17400`, so the Hub container can hand a desktop update to the host. The Hub hands over updates started from Settings or the MCP tool `hub_perform_update`, never its daily auto-update, which updates the stack image only. The updater keeps the Hub running until the new version is installed (on Windows, until it hands over to the installer), and starts the Hub again if the update fails after the stop. See [Install flow](../DESKTOP-AUTO-UPDATE.md#install-flow-per-platform). Requests need the token in `<data dir>/state/update-listener.token`, which the Hub reads as `/data/state/update-listener.token`. The listener writes a new token each time it starts, and trusts the file only while it is private to the desktop user. Compose mounts `state/` and other subfolders into the Hub, never the data dir itself, so a file the desktop writes for the Hub to read belongs in one of them. See [The listener token](../DESKTOP-AUTO-UPDATE.md#the-listener-token).

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
- "Open data folder" is desktop-Tauri-only (`reveal_item_in_dir` → Finder / Explorer / the Linux file manager). A browser or phone copies the Hub host path instead — those clients are not that machine.
