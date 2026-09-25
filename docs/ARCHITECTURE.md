# Companion Hub architecture

> **Purpose:** Describe the major Companion Hub subsystems and how they connect.
> **Scope:** Companion Hub backend, frontend, desktop shell, Docker runtime, and Portal integration.
> **Key paths:** `packages/backend/`, `packages/frontend/`, `packages/desktop/`, `docs/system/`
> **Commands:** `pnpm run local`, `pnpm run local:desktop`, see docs/system/*.md per area
> **Owner persona:** maintainability (see docs/agent/REVIEW_PERSONAS.md)
> **Last updated:** 2026-07-12
> **Related:** docs/system/README.md, PLATFORM_ARCHITECTURE.md, AUTO_HEALING.md

> **Agents:** Use [docs/system/](system/) for searchable subsystem documentation. Update those files when you change code; update this file only for cross-cutting architecture changes.

Companion Hub is a self-hosted Docker app platform that lets users install, manage, and expose containerized applications through a web dashboard or native desktop app. This document describes every major subsystem, how they connect, and the design decisions behind them.

---

## High-level overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          User / Browser / Tauri                         │
│  React 19 SPA · React Router 7 · TanStack Query · Zustand · Radix UI  │
└──────────────┬──────────────────────────────────────┬───────────────────┘
               │  REST + SSE (fetch)                  │  cihub:// deep link
               ▼                                      ▼
┌──────────────────────────────┐        ┌─────────────────────────────┐
│     NestJS 11 Backend API    │        │   Tauri 2 Desktop Shell     │
│  Drizzle · Dockerode · JWT   │        │  Rust · mDNS · Docker CLI   │
│  /api/*  on port 3000/5002   │        │  System tray · Updater      │
└──────┬────────┬────────┬─────┘        └─────────────────────────────┘
       │        │        │
       ▼        ▼        ▼
┌──────────┐ ┌──────┐ ┌──────────────────────────────────────────────┐
│PostgreSQL│ │Rabbit│ │              Docker Engine                    │
│   14     │ │ MQ 4 │ │  Compose v2 · Traefik v3 · cloudflared      │
│ Drizzle  │ │      │ │  Tailscale · hub-tailscale · user apps       │
└──────────┘ └──────┘ └──────────────────────────────────────────────┘
                                   │
                                   ▼
                        ┌─────────────────────┐
                        │  Companion Portal   │
                        │  Device registration│
                        │  Tunnel provisioning│
                        │  Marketplace API    │
                        └─────────────────────┘
```

Tailscale is the current private VPN plane. Headscale is a legacy option in older deployments.

---

## Monorepo structure

The project uses **pnpm workspaces** with **Turborepo** for task orchestration.

| Package | Purpose | Key technology |
|---------|---------|----------------|
| `packages/backend` | REST API, app lifecycle, Docker control, queue workers | NestJS 11, Drizzle ORM, Dockerode |
| `packages/frontend` | Single-page dashboard and app store UI | React 19, React Router 7, Vite 7 |
| `packages/common` | Shared Zod schemas, TypeScript types, app URN utilities | Zod 4, TypeScript |
| `packages/desktop` | Native wrapper with system tray, Docker checks, hub discovery | Tauri 2 (Rust) |

Build dependencies flow `common → backend`, `common → frontend`. Turborepo caches outputs and parallelizes builds. The `turbo.json` configuration defines tasks (`build`, `bundle`, `dev`, `tsc`, `test`) with proper dependency chains and environment variable passthrough.

---

## Backend

### Framework and bootstrap

The backend is a **NestJS 11** application on **Express**. `main.ts` bootstraps the app with:

- Global `/api` prefix on all routes
- `ZodValidationPipe` for request body/query validation
- `AuthMiddleware` applied globally (populates `request.user` from JWT)
- `AuthGuard` as global route guard (rejects unauthenticated requests unless route is marked public)
- `MainExceptionFilter` for centralized error handling with Winston logging
- Swagger/OpenAPI docs served at `/api/docs`
- CORS (`common/helpers/cors-origin.ts`) allows credentialed requests only from the Tauri WebView origins, `DOMAIN`/`LOCAL_DOMAIN`, the loopback ports the Hub itself is served from (`API_PORT`, plus `FRONTEND_PORT` outside production), and any exact origin listed in `CI_HUB_EXTRA_CORS_ORIGINS` — *not* every loopback port, which would trust any installed app that publishes one
- In production, the built frontend SPA is served as static files from `/assets/frontend`

### Module organization

The backend has ~30 NestJS modules organized into **core infrastructure** and **feature modules**.

#### Core modules

| Module | Class | Responsibility |
|--------|-------|----------------|
| **Configuration** | `ConfigurationService` | Loads and validates all environment variables via Zod. Reads from `.env` file, `process.env`, and a persistent `settings.json` file (in order of increasing priority). Exposes typed getters for database, queue, directory paths, architecture, user settings, and theme. |
| **Database** | `DatabaseService` | Initializes the Drizzle ORM instance against PostgreSQL. Runs migrations on startup from the `drizzle/` directory. Exposes the `db` instance for injection into repositories. |
| **Logger** | `LoggerService` | Winston-based structured logger with file rotation. Writes newline-delimited JSON to `$DATA_DIR/logs/`. Supports configurable `LOG_LEVEL`. Daily cleanup of old log files. |
| **Cache** | `CacheService` | SQLite-backed in-process cache with a 6-hour TTL. Used heavily by the marketplace search index to avoid re-scanning the filesystem on every request. |
| **Filesystem** | `FilesystemService` | Abstraction over Node.js `fs` for reading/writing app files, compose files, environment files, and user config overrides. |
| **SSE** | `SSEService` | Server-Sent Events broadcast service. Maintains a `Map<topic, Subject>` of active SSE channels. Topics include `app:status:{urn}`, `app:logs:{urn}`, and `system:status`. Auto-cleans unused topics every 60 seconds. Colorizes Docker log output on the fly. |
| **Encryption** | `EncryptionService` | Symmetric encryption for sensitive config values stored in the database (e.g., TOTP secrets). |
| **Password** | `PasswordService` | Argon2id password hashing with individual salts per user. |

#### Feature modules

| Module | Key classes | What it does |
|--------|-------------|--------------|
| **Auth** | `AuthService`, `SessionManager`, `AuthGuard`, `AuthMiddleware` | **Portal-first operator auth:** human credentials are validated against Companion Portal (email/password proxy and OIDC PKCE). The Hub stores an opaque **session ID** in an HTTP-only cookie (not a JWT payload exposed to the client). Device↔Portal automation uses `ciHubApiKey` (`Authorization` + `x-device-key`). Tauri sends `X-Session-Id` instead of cookies. `AuthGuard` protects routes unless `@Public()`. |
| **User** | `UserService`, `UserRepository` | CRUD for user accounts. Supports operator (admin) and regular user roles. Locale and timezone preferences per user. |
| **Apps** | `AppsService`, `AppRepository`, `AppFilesManager` | Reads installed app metadata from the database and filesystem. `AppFilesManager` handles path resolution for each app's compose file, environment file, config, and user overrides. Path layout: `$DATA_DIR/apps/{storeId}/{appName}/` for definitions, `$APP_DATA_DIR/{storeId}/{appName}/` for persistent data, `$DATA_DIR/user-config/{storeId}/{appName}/` for user overrides (`docker-compose.user.yml`, `.env.user`). |
| **App Lifecycle** | `AppLifecycleService`, `AppLifecycleController`, `AppLifecycleCommandFactory`, `InstallPipelineTracker` | Orchestrates all app state transitions: install, start, stop, restart, uninstall, reset, update, update-config, backup, restore. Uses the **command pattern** — `AppLifecycleCommandFactory` creates a handler for each operation type. Every operation acquires an **async mutex** keyed by app URN to prevent concurrent modifications. **Install** commands additionally acquire a global pipeline mutex (`INSTALL_PIPELINE_MUTEX_KEY`) so only one Docker image pull / `compose up` runs at a time; other queue workers may still process start/stop/update for different apps. Failed installs keep the app record with status `install_failed` (library entry retained). Long-running operations (install, update) are published to RabbitMQ and processed asynchronously. Status changes broadcast via SSE (`status_change` with optional progress, `install_queue`, lifecycle success/error events). After any exposure change, Cloudflare DNS is synced automatically. Supports bulk operations: `updateAllApps`, `startAllApps`, `stopAllApps`, `restartAllApps`. The steps every command shares live in their own modules rather than on the base class — `commands/compose-preparation.ts` (renders the app's compose file), `commands/host-device-preflight.ts` (`/dev/kfd`, `/dev/kvm`), `commands/network-recovery.ts` (compose retry on subnet overlap), and `commands/failure-reporting.ts` (error translation). `AppLifecycleCommand` keeps a thin wrapper for each so subclass `this.<name>()` calls and test spies still dispatch through the prototype. |
| **Docker** | `DockerService` | Wraps Docker operations. Core method `composeApp(appUrn, command)` spawns `docker compose` processes—tries the plugin form (`docker compose`) first, falls back to the standalone `docker-compose` binary. Collects compose files and environment files, resolves relative paths from the app directory. Handles image pulls, container lifecycle, log streaming, port detection (parses compose files and resolves `${VAR}` references), container diagnostics (crash-loop detection from exit codes + captured logs), and Docker network management. |
| **Queue** | `QueueFactory`, `AppEventsQueue`, `RepoEventsQueue`, `SystemEventsQueue` | Generic `Queue<EventSchema, ResultSchema>` abstraction over `rabbitmq-client`. Implements an **RPC pattern**: publish a command → worker processes it → reply is correlated back to the caller. `AppEventsQueue` runs 3 concurrent workers for install/start/stop/update operations (installs serialized at the pipeline mutex, not by worker count). `RepoEventsQueue` runs 3 workers for git clone/pull. `SystemEventsQueue` runs 1 worker for status reconciliation. All messages validated with Zod schemas. App-events RPC timeout is `max(userSettings.eventsTimeout, DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES)` (45 minutes minimum for large image pulls). Supports cron scheduling for repeatable tasks. Includes exponential backoff on reconnection failures. |
| **Marketplace** | `MarketplaceService`, `PortalCatalogService`, `PortalClientService` | **Portal-first catalog:** featured, listings, alternatives, and search requests proxy Companion Portal through `PortalClientService` with a 15-minute in-memory cache. Per-app install still fetches fresh compose/config from Portal at install time. Legacy git store clones remain for power users but are not on the appliance boot path. |
| **App Stores** | `AppStoreService`, `AppStoreRepository` | Registers the built-in `ci-marketplace` (`ci_cloud_api`) store. Git-typed stores are deprecated in product UI until Add Store returns. |
| **Cloudflare** | `CloudflareClientService` | Manages the Cloudflare Tunnel integration. Syncs local app exposure state to the Companion Portal API, which in turn configures Cloudflare DNS ingress rules. Maintains the tunnel token on disk (`tunnel/token`) and in memory. Constructs `AppInfo` payloads (name, subdomain, localPort, protocol) with a `privilegedKind` field for special services (`hub` for the Hub itself). Token overwrites on initialization to recover from invalid state. |
| **Registration** | `RegistrationService` | Handles the device registration flow with Companion Portal. On first run, the Hub displays a pairing code or redirect URL. The user completes registration on the Portal, which calls back with organization ID, tunnel credentials, and subdomain mapping. Stores everything in the `device_registration` table. On startup, recovers tunnel state from the database and reinitializes the Cloudflare tunnel if needed. Polls every 5 seconds when unregistered. Writes a Traefik dynamic YAML route for the Hub's public FQDN. |
| **Tailscale** | `TailscaleService` | When the host has the Tailscale CLI and socket, manages `tailscale` commands and `tailscale serve`. Can fall back to `docker exec` into an optional sidecar named by `TAILSCALE_SIDECAR_CONTAINER` (legacy stacks used `hub-tailscale`). |
| **Backups** | `BackupsService` | Creates, lists, restores, deletes, and uploads per-app backups. Backups are tar.gz archives of the app's data directory. Flow: set app status to `backing_up` → stop containers → archive → restart. Restore reverses the process. Respects `app.maxBackups` for automatic retention. Tracks `cihub_app_version` in backup metadata for version compatibility. |
| **Custom Apps** | `CustomAppService` | Lets users define their own Docker Compose apps without an app store. Files are created under the reserved `_user` store slug. Generates `docker-compose.json`, `config.json`, and metadata files (description.md, logo). Validates metadata via the shared frontmatter schema from `@ci-hub/common`. |
| **System** | `SystemService` | Reports system metrics: CPU load, memory usage (reads `/host/proc/meminfo` from the bind mount), disk usage. Retrieves TLS certificates from Traefik's ACME storage. Lists running Docker services. Powers the dashboard system info panel. |
| **System Update** | `SystemUpdateService` | Checks for new Hub versions (compares `CI_HUB_VERSION` against the latest available). Performs self-updates by pulling new Docker images and restarting the compose stack. |
| **Network** | `PortAllocationRepository` | Tracks TCP/UDP port mappings in the database. Prevents port conflicts between apps. Allocates ports dynamically during install. |
| **Inference** | `InferenceBackendRegistry`, `ModelRegistryService`, `ModelPullerService`, `InferenceRouterService`, `HardwareInspectorService` | Runs local models across eight backends (Ollama, vLLM, Lemonade, MTPLX, mlx-dspark, Lucebox, llama.cpp, LM Studio), each an `InferenceBackend` adapter under `inference/backends/`. The last two are servers the operator runs themselves: the Hub holds a URL (`LLAMACPP_URL`, `LMSTUDIO_URL`), never a container, and cannot pull a model into either. `InferenceBackendRegistry` is the one type-to-instance mapping — a `Record` keyed by the closed `InferenceBackendType` union, so a backend added to the union without being wired here is a build error. `HardwareInspectorService` profiles GPU/NPU/RAM into a tier that the curated model catalog filters against. |
| **Links** | `LinksService` | CRUD for dashboard shortcut links (title, URL, icon, visibility). |
| **I18n** | `I18nModule` | Multi-language support using `i18next` with `i18next-fs-backend`. Translation files live in `assets/translations/`. |

### Database schema

PostgreSQL 14 with **Drizzle ORM**. Five core tables:

```
┌─────────────────────────┐     ┌───────────────────────────────┐
│ user                    │     │ app                           │
├─────────────────────────┤     ├───────────────────────────────┤
│ id           SERIAL PK  │     │ id           VARCHAR PK       │
│ username     VARCHAR     │◄───│ (no direct FK)                │
│ password     VARCHAR     │     │ status       ENUM (14 states) │
│ operator     BOOLEAN     │     │ config       JSONB            │
│ totp_secret  VARCHAR     │     │ port         INTEGER          │
│ totp_enabled BOOLEAN     │     │ domain       VARCHAR          │
│ locale       VARCHAR     │     │ exposed      BOOLEAN          │
│ salt         VARCHAR     │     │ exposedLocal BOOLEAN          │
│ created_at   TIMESTAMP   │     │ openPort     BOOLEAN          │
│ updated_at   TIMESTAMP   │     │ appStoreSlug VARCHAR          │
└─────────────────────────┘     │ appName      VARCHAR          │
                                │ exposureMode VARCHAR          │
┌─────────────────────────┐     │ version      INTEGER          │
│ appStore                │     │ created_at   TIMESTAMP        │
├─────────────────────────┤     │ updated_at   TIMESTAMP        │
│ slug         VARCHAR PK  │     └───────────────────────────────┘
│ hash         VARCHAR     │
│ name         VARCHAR     │     ┌───────────────────────────────┐
│ enabled      BOOLEAN     │     │ link                          │
│ url          VARCHAR     │     ├───────────────────────────────┤
│ branch       VARCHAR     │     │ id           SERIAL PK        │
│ type         ENUM        │     │ title        VARCHAR          │
│ created_at   TIMESTAMP   │     │ url          VARCHAR          │
│ updated_at   TIMESTAMP   │     │ iconUrl      VARCHAR          │
└─────────────────────────┘     │ userId       INTEGER FK→user  │
                                │ description  VARCHAR          │
┌──────────────────────────┐    │ visibility   VARCHAR          │
│ deviceRegistration       │    │ created_at   TIMESTAMP        │
├──────────────────────────┤    └───────────────────────────────┘
│ id/org_id    VARCHAR PK  │
│ slug         VARCHAR     │    ┌───────────────────────────────┐
│ name         VARCHAR     │    │ portAllocation                │
│ hubSubdomain VARCHAR     │    ├───────────────────────────────┤
│ tunnelId     VARCHAR     │    │ id           SERIAL PK        │
│ tunnelToken  VARCHAR     │    │ appUrn       VARCHAR          │
│ created_at   TIMESTAMP   │    │ hostPort     INTEGER          │
│ updated_at   TIMESTAMP   │    │ containerPort INTEGER         │
└──────────────────────────┘    │ protocol     VARCHAR          │
                                │ label        VARCHAR          │
                                └───────────────────────────────┘
```

**App status states:** `running`, `stopped`, `installing`, `install_failed`, `uninstalling`, `stopping`, `starting`, `missing`, `updating`, `resetting`, `restarting`, `backing_up`, `restoring`

Migrations are managed by Drizzle Kit and run automatically on startup.

### Message queue

RabbitMQ 4 provides asynchronous task processing. The queue system uses a generic `Queue<EventSchema, ResultSchema>` class with **RPC semantics** — the caller publishes a command and awaits a correlated reply.

```
Frontend                    Backend API                    RabbitMQ                      Worker
   │                            │                              │                           │
   │  POST /install             │                              │                           │
   │ ──────────────────────────►│                              │                           │
   │                            │  publish(app:install, urn)   │                           │
   │                            │ ─────────────────────────────►                           │
   │                            │                              │   consume(app:install)     │
   │                            │                              │ ─────────────────────────► │
   │                            │                              │                           │
   │  ◄─── SSE: installing ────│◄──── SSE: status_change ────│                           │
   │                            │                              │   docker compose up       │
   │                            │                              │                           │
   │  ◄─── SSE: running ───── │◄──── SSE: status_change ────│◄── reply(success) ────── │
   │                            │                              │                           │
```

**Queue configuration:**

| Queue | Concurrency | Timeout | Commands |
|-------|-------------|---------|----------|
| `AppEventsQueue` | 3 workers | `max(eventsTimeout, 45 min)` | install, start, stop, restart, uninstall, reset, update, update-config, backup, restore |
| `RepoEventsQueue` | 3 workers | `eventsTimeout` (default 5 min) | clone, clone_all, update, update_all |
| `SystemEventsQueue` | 1 worker | `eventsTimeout` (default 5 min) | sync_app_statuses |

**Install pipeline:** Multiple install jobs may be queued in RabbitMQ, but `AppLifecycleService.invokeCommand` holds `INSTALL_PIPELINE_MUTEX_KEY` for the duration of each `install` worker run so Docker pulls do not run in parallel.

**Install queue API (UI):** `GET /api/apps/install-queue` returns `{ active, queued }`. `active` is the app holding the Docker install pipeline mutex; `queued` is every other app in `installing` status (FIFO by app id). When the pipeline is idle but installs are accepted, all pending apps appear in `queued` and `active` is null. SSE event `install_queue` pushes the same snapshot. The frontend polls while work is pending and updates React Query from SSE.

**Stuck-install recovery:** Because the queue is derived from `installing` rows, a crash or hung pull can leave the UI showing perpetual "N installs waiting" with `active: null`. Hub heals that on boot (`recoverStuckInstallsOnStartup`), via status-sync after the image-pull grace when nothing in-process still owns the install, via pull inactivity/overall timeouts that fail (not cancel) a wedged pull, and via `invokeCommand`'s catch finalizing `install_failed`. `(app_name, app_store_slug)` is unique so concurrent install races cannot create duplicate queue tiles.

All messages are validated with Zod schemas before processing. The `QueueFactory` handles connection pooling with exponential backoff reconnection. Cron scheduling is available for repeatable tasks like periodic app status reconciliation.

### API endpoints

All routes are prefixed with `/api`. Key endpoint groups:

```
Health
  GET  /health                              Health check (used by Docker + Traefik)

Authentication
  POST /auth/login                          Email/password login, returns session cookie
  POST /auth/register                       Create new user
  POST /auth/verify-totp                    Verify TOTP code
  GET  /auth/traefik                        Forward-auth for Traefik reverse proxy

User Context
  GET  /user-context                        Current user, settings, registration status

Apps
  GET  /apps/installed                      List all installed apps
  GET  /apps/guest                          Guest-visible apps (for guest dashboard)
  GET  /apps/:urn                           Get specific installed app

App Lifecycle
  POST /app-lifecycle/:urn/install          Install and start an app
  POST /app-lifecycle/:urn/start            Start a stopped app
  POST /app-lifecycle/:urn/stop             Stop a running app
  POST /app-lifecycle/:urn/restart          Restart an app
  DELETE /app-lifecycle/:urn/uninstall      Uninstall an app
  POST /app-lifecycle/:urn/reset            Reset app data
  PATCH /app-lifecycle/:urn/update          Update to latest version
  PATCH /app-lifecycle/:urn/update-config   Update configuration only
  POST /app-lifecycle/update-all            Bulk update all apps
  POST /app-lifecycle/start-all             Bulk start all apps
  POST /app-lifecycle/stop-all              Bulk stop all apps
  POST /app-lifecycle/restart-all           Bulk restart all apps

Marketplace
  GET  /marketplace/apps                    Search/browse app catalog

App Stores
  GET  /app-stores                          List configured stores
  POST /app-stores                          Add a new store

Backups
  GET  /backups/:urn                        List backups for an app
  POST /backups/:urn                        Create a backup
  POST /backups/:urn/restore/:backupId      Restore from backup
  DELETE /backups/:urn/:backupId            Delete a backup

Custom Apps
  POST /custom-apps                         Create a custom app
  PATCH /custom-apps/:urn                   Update a custom app
  DELETE /custom-apps/:urn                  Delete a custom app

Cloudflare
  GET  /cloudflare/status                   Tunnel connection status
  POST /cloudflare/sync-dns                 Force DNS sync

System
  GET  /system/info                         CPU, memory, disk metrics
  POST /system-update/check                 Check for Hub updates
  POST /system-update/perform               Perform Hub self-update

Links
  GET  /links                               Dashboard shortcut links
  POST /links                               Create a link
  PATCH /links/:id                          Update a link
  DELETE /links/:id                         Delete a link

Registration
  POST /registration/register               Register device with Companion Portal
  GET  /registration/status                 Registration status (can send a Portal check-in)
  GET  /registration/phase                  Registration phase and last check-in, read-only

Settings
  GET  /settings                            Hub settings
  PATCH /settings                           Update settings
```

### Authentication flow

```
┌────────┐                    ┌──────────┐                ┌──────────────┐
│ Client │                    │ Backend  │                │  PostgreSQL  │
└───┬────┘                    └────┬─────┘                └──────┬───────┘
    │  POST /auth/login            │                             │
    │  {username, password}        │                             │
    │─────────────────────────────►│                             │
    │                              │  SELECT user WHERE username │
    │                              │────────────────────────────►│
    │                              │◄────────────────────────────│
    │                              │                             │
    │                              │  argon2.verify(password)    │
    │                              │                             │
    │   if TOTP enabled:           │                             │
    │   401 {totpRequired: true}   │                             │
    │◄─────────────────────────────│                             │
    │                              │                             │
    │  POST /auth/verify-totp      │                             │
    │  {totpCode}                  │                             │
    │─────────────────────────────►│                             │
    │                              │  otplib.verify(code,secret) │
    │                              │                             │
    │   Set-Cookie: session=JWT    │                             │
    │◄─────────────────────────────│                             │
    │                              │                             │
    │  Tauri alternative:          │                             │
    │  X-Session-Id: JWT           │                             │
```

- Passwords are hashed with **Argon2id** and individual salts (local hash is vestigial as Portal login becomes primary)
- Hub sessions use opaque **session IDs** in HTTP-only cookies (see `SessionManager`)
- Tauri desktop clients use a custom `X-Session-Id` header because WebView2 blocks cross-origin cookie access
- TOTP 2FA uses `@otplib/core` with encrypted secret storage
- The `AuthMiddleware` extracts the session from cookie or header on every request
- The `AuthGuard` rejects unauthenticated requests unless the route has the `@Public()` decorator
- Traefik uses `/api/auth/traefik` as a forward-auth endpoint so that installed apps can be protected behind Hub authentication. HMAC-signed `X-CI-Hub-User` headers apply only to apps on that appliance; they are not a Portal session (see [`security/hub-portal-trust.md`](security/hub-portal-trust.md)).

---

## Frontend

### Framework stack

The frontend is a **React 19 SPA** built with **React Router 7** (file-convention routing in SPA mode, no SSR) and bundled by **Vite 7**.

| Concern | Library |
|---------|---------|
| Routing | React Router 7 with typed route modules |
| Server state | TanStack React Query 5 (auto-generated hooks from OpenAPI) |
| Client state | Zustand 5 (app filters, UI toggles, multi-service state) |
| Styling | Tailwind CSS 4 (utility-first) |
| Components | Radix UI primitives (dialog, select, dropdown, tabs, checkbox, etc.) |
| Forms | React Hook Form + Zod resolvers |
| Icons | Lucide React |
| Animations | Framer Motion |
| Code editing | CodeMirror (JSON, YAML, Markdown) with merge/diff view |
| Markdown | react-markdown + remark-gfm |
| Notifications | sonner, through the themed `Toaster` in `components/ui/Toaster` |
| i18n | i18next + react-i18next |
| QR codes | qrcode.react |

### API client generation

The API client is generated from the backend's Swagger JSON specification using `@hey-api/openapi-ts`:

```
openapi-ts.config.ts
  input:   packages/backend/src/swagger.json
  output:  packages/frontend/src/api-client/
  plugins: @tanstack/react-query, @hey-api/client-fetch
```

This produces:
- **`sdk.gen.ts`** — 100+ typed endpoint functions (e.g., `login()`, `installApp()`, `userContext()`)
- **`types.gen.ts`** — Request/response TypeScript types
- **`@tanstack/` hooks** — Auto-generated `useQuery` / `useMutation` hooks for every endpoint
- **`core/serverSentEvents.gen.ts`** — SSE streaming utilities

The fetch-based client supports interceptors for auth headers, error handling, and adaptive credential mode (include cookies for browser, omit for Tauri).

### Routing

```
Unauthenticated Layout
  /login
  /register
  /reset-password
  /device-registration

Authenticated Layout (sidebar + titlebar)
  /dashboard                        System metrics, installed apps overview
  /onboarding                       First-time user experience wizard
  /app-store                        Browse all app stores
  /app-store/:storeId               Browse a specific store
  /app-store/:storeId/:appId        App detail page
  /app-store/:storeId/:appId/update App update page
  /apps                             Installed apps list (my apps)
  /apps/create                      Create custom Docker Compose app
  /apps/:appId                      Custom app details
  /apps/:appId/edit                 Edit custom app
  /apps/:storeId/:appId             Installed app details
  /settings                         Hub settings, theme, language
```

Route guards check authentication state and redirect to `/login` or `/onboarding` as needed.

### State management

**Server state** is handled entirely by TanStack React Query. The auto-generated hooks handle caching, refetching, and optimistic updates. Cache is invalidated on mutations automatically.

**Client state** uses Zustand stores:
- `app-store.ts` — Search query, category filter, sort order for the app catalog. Debounced search (300ms).
- `ui-store.ts` — Sidebar open/closed, modal visibility, theme toggles.
- `multiServiceStore.ts` — Multi-service form coordination state.

### Real-time updates

The frontend subscribes to **Server-Sent Events** for live status and log streaming:

| SSE Topic | Data |
|-----------|------|
| `app:status:{urn}` | App status changes (installing → running, etc.) |
| `app:logs:{urn}` | Live Docker container logs (colorized) |
| `system:status` | Hub system-level status updates |

The SSE client is auto-generated from the OpenAPI spec and uses the native `EventSource` API.

### UI features

- **Dashboard** — System resource gauges (CPU, RAM, disk), list of running apps with status indicators
- **App Store** — Full-text search with fuzzy matching, category filters, architecture-aware (only shows apps that support the host CPU)
- **App Detail Page** — Live logs terminal (CodeMirror), configuration editor, exposure settings (local/Cloudflare/Tailscale), backup management
- **Custom Apps** — Docker Compose editor for user-defined apps with dynamic form generation from JSON Schema
- **Settings** — Theme (dark/light), language selector, timezone, advanced settings toggles
- **Onboarding** — Step-by-step wizard for FTUE (first-time user experience)
- **Responsive** — Adapts to mobile viewports via Tailwind breakpoints

---

## Common package

`@ci-hub/common` provides shared code consumed by both backend and frontend:

**Schemas** (`@ci-hub/common/schemas`):
- `appInfoSchema` — Zod schema for app metadata (name, description, version, categories, supported architectures, form fields, Docker services)
- `dynamicComposeSchema` — Validates the Hub's Docker Compose-like app definition format
- `serviceSchema` — Individual Docker service definition
- `formFieldSchema` — Dynamic form field types (text, select, checkbox, textarea, number, etc.)
- `sseSchema` — Server-Sent Events message format
- `appCategoriesEnum` — Standard app categories
- `architecturesEnum` — Supported CPU architectures (amd64, arm64, armv7)

**Types** (`@ci-hub/common/types`):
- `AppUrn` — Branded string type in format `appName:appStoreSlug` (e.g., `nextcloud:ci-app-store`)
- `zodAppUrn` — Zod validator for the URN format
- Architecture type aliases

**Utilities:**
- `parseComposeJson()` — Converts the Hub's JSON-based compose format to standard YAML
- `toJsonSchema()` — Zod to JSON Schema conversion for dynamic form generation

The package tracks `CURRENT_SCHEMA_VERSION` and `MIN_SCHEMA_VERSION` for app compatibility checks across Hub versions.

---

## Desktop app

The desktop app wraps the Hub's web UI in a **Tauri 2** native shell (Rust + system WebView).

### Capabilities

| Feature | Implementation |
|---------|----------------|
| **Hub discovery** | mDNS (`mdns-sd` crate) scanning for other Hub instances on the LAN |
| **Docker checks** | Shell-out to `docker` CLI to verify availability, permissions, and container state |
| **Hub management** | Start/stop the Hub via `docker compose` commands |
| **Deep linking** | `cihub://pair?code=xxx` scheme for device pairing from the Portal |
| **System tray** | Background process with tray icon and context menu |
| **Auto-updates** | Tauri updater plugin pointed at GitHub releases (stable + nightly channels) |
| **Notifications** | Native OS notifications for hub status changes |
| **Persistent storage** | `tauri-plugin-store` for local preferences |

### Tauri commands (Rust → JavaScript)

```rust
check_hub_status(url: String) -> bool           // HTTP health probe
discover_hubs() -> Vec<String>                   // mDNS discovery
start_hub_command() -> String                    // docker compose up
check_docker_available() -> bool                 // which docker
check_docker_access_command() -> DockerAccessCheck
install_docker_command() -> DockerInstallResult
get_hub_status_command() -> HubStatus            // Combined: Docker + container + health
```

### Session handling

Tauri's WebView2 blocks cross-origin cookie access. The desktop app detects it's running in Tauri via `@tauri-apps/api` and sends the JWT session token via an `X-Session-Id` request header instead of relying on cookies. The backend's `AuthMiddleware` checks both locations.

### Configuration

- **Window:** 1280×800 default, 800×600 minimum, overlay title bar
- **Identifier:** `computer.ci.app.hub`
- **Deep link scheme:** `cihub://`
- **macOS minimum:** 11.0
- **Release builds:** LTO enabled, symbols stripped, panic=abort, size-optimized (`opt-level=s`)
- **Release builds:** Bootstrap splash only (`packages/desktop/bootstrap/`); product UI served from the stack container at `http://127.0.0.1:${API_PORT}/`. See `docs/DESKTOP-UI-ARCHITECTURE.md`.
- **Dev URL:** `http://localhost:5005` (Vite) or stack-dev via `scripts/launch-tauri-desktop.ts`

---

## Infrastructure

### Docker Compose services

The Hub orchestrates its infrastructure and all user-installed apps via Docker Compose.

**Core services** (always running):

| Service | Image | Purpose | Port |
|---------|-------|---------|------|
| `ci-hub` | Built from `Dockerfile` | Backend API + static frontend | 5002 (prod), 3000 (dev) |
| `ci-hub-db` | `postgres:14` | Primary data store | 6543 |
| `ci-hub-queue` | `rabbitmq:4-alpine` | Message broker | 5672 |
| `traefik` | `traefik:v3.6.7` | Reverse proxy, TLS termination | 80, 443, 8080 (dashboard) |

**Optional services** (Docker Compose profiles):

| Service | Image | Profile | Purpose |
|---------|-------|---------|---------|
| `cloudflared` | `cloudflare/cloudflared:2026.2.0` | `cloudflare` | Tunnel to Cloudflare edge |
| `hub-tailscale` | `tailscale/tailscale:v1.98.3` | `private-vpn` | Tailscale sidecar ([private-vpn.md](./private-vpn.md)) |

**User-installed apps** run as separate Docker Compose stacks managed by the backend's `DockerService`. Each app gets its own compose file, network, and data directory.

### Reverse proxy (Traefik v3)

Traefik provides automatic routing and TLS for all services:

```
Internet → Cloudflare → cloudflared → Traefik (443/80)
                                          │
                                          ├── ci-hub (Hub UI/API)
                                          ├── app-a (user app)
                                          ├── app-b (user app)
                                          └── ...
```

**Configuration sources:**
1. **Static config** (`traefik.yml`) — Generated by `scripts/init-traefik.ts` at startup. Defines entrypoints (web:80, websecure:443), file providers, Docker provider, and ACME settings.
2. **Dynamic file config** (`$DATA_DIR/state/traefik/dynamic/`) — YAML files written by the backend for the Hub and per-app routes.
3. **Docker labels** — Apps can declare Traefik labels in their compose files for automatic discovery.

**Forward auth:** Traefik's `forwardauth` middleware sends every request to `/api/auth/traefik` before proxying. The backend validates the session and returns an `X-CI-Hub-User` header. This lets installed apps be protected behind Hub authentication without implementing auth themselves. On **public sibling** hostnames (Hub vs app under the same zone root), the browser will not send the Hub session cookie to the app host — `/api/auth/edge-sso` mints a short-lived ticket that `/traefik` consumes to plant a cookie on the app host (ADR 002). Local open via `127.0.0.1:{port}` does not use this path (ADR 001).

**TLS:** Let's Encrypt via ACME (stored in `$DATA_DIR/state/traefik/acme_storage.json`). Local development uses self-signed certificates generated by `scripts/generate-tunnel-certs.sh`.

### Networking and app exposure

Apps can be exposed through three modes:

**1. Local only (default)**
- App is accessible on the host machine at `localhost:{port}` or via Traefik at `{app}.{LOCAL_DOMAIN}` (e.g., `nextcloud.ci.lan`)
- No internet exposure
- Port allocation tracked in `portAllocation` table to prevent conflicts

**2. Cloudflare Tunnel**
- Device must be registered with Companion Portal
- Backend publishes app info (subdomain, port, protocol) to the Companion Portal API
- Portal configures Cloudflare DNS ingress rules
- `cloudflared` container bridges traffic from the Cloudflare edge to Traefik
- Public URL: `{app}.{org_slug}.{domain}` (e.g., `nextcloud.myorg.ci.computer`)

**3. Tailscale sidecar (`hub-tailscale`)** — optional `private-vpn` profile: joins [Tailscale](https://tailscale.com) using a pre-auth key and can advertise the Docker bridge so tailnet devices reach Hub services. Not a self-hosted coordination server; see **docs/private-vpn.md**.

### Filesystem layout

```
$ROOT_FOLDER_HOST/
├── apps/                           App definitions (per store, per app)
│   ├── ci-app-store/
│   │   ├── nextcloud/
│   │   │   ├── docker-compose.yml
│   │   │   ├── app.env
│   │   │   └── config.json
│   │   └── jellyfin/
│   │       └── ...
│   └── _user/                      Custom user-defined apps
│       └── my-app/
│           └── ...
├── app-data/                       Per-app persistent data volumes
│   ├── ci-app-store/
│   │   ├── nextcloud/data/
│   │   └── jellyfin/data/
│   └── _user/
│       └── my-app/data/
├── repos/                          Cloned app store git repositories
│   └── ci-app-store/
│       ├── apps/
│       └── ...
├── state/
│   ├── traefik/
│   │   ├── config/traefik.yml      Static Traefik config
│   │   ├── dynamic/                Dynamic route YAML files
│   │   ├── acme_storage.json       Let's Encrypt certificates
│   │   └── tls/                    Custom TLS certificates
├── backups/                        Compressed app backup archives (.tar.gz)
├── logs/                           Winston log files (JSON, rotated daily)
├── user-config/                    Per-app user overrides
│   └── ci-app-store/
│       └── nextcloud/
│           ├── docker-compose.user.yml
│           └── .env.user
├── media/                          Uploaded media files
└── .env                            Hub environment file (persisted settings)
```

---

## App lifecycle

The app lifecycle follows these steps:

> The Hub reconciles and repairs this lifecycle through desktop
> hash-based reconciliation, `start_hub` self-heal/retry, the 5-minute backend
> status sync, and compose restart policies. See **[AUTO_HEALING.md](AUTO_HEALING.md)**.

### Install

```
1. User browses app store → selects app → fills config form
2. Frontend POST /app-lifecycle/{urn}/install with form values
3. Controller validates: domain conflicts, port conflicts, architecture support
4. AppLifecycleService acquires mutex for this app URN
5. Publishes app:install command to AppEventsQueue
6. Worker:
   a. Copies app definition files from repo to $DATA_DIR/apps/{store}/{app}/
   b. Generates docker-compose.yml from app spec + user config
   c. Writes app.env with user-provided values. The file is seeded from the Hub's own
      `/data/.env`, but only an explicit allowlist of that file's keys is inherited
      (`HUB_ENV_KEYS_INHERITED_BY_APPS` in `app.helpers.ts`: Hub identity such as `DOMAIN`,
      `ROOT_FOLDER_HOST`, `TZ`, plus the documented operator pins). Everything else the Hub
      wants an app to have — keys, Memory and inference credentials — is set explicitly.
      Hub secrets (Postgres, RabbitMQ, JWT, the Portal device key) never reach an app.
   d. docker compose pull (downloads images)
   e. docker compose up -d (starts containers)
7. Status transitions: stopped → installing → running (or install_error)
8. SSE events broadcast at each step
9. If app has exposure settings, Cloudflare DNS is synced
10. Mutex released
```

### Update

```
1. User clicks "Update" on an app
2. Backend creates a backup (if auto-backup enabled)
3. Publishes app:update command
4. Worker:
   a. docker compose pull (new images)
   b. docker compose up -d --force-recreate
5. Status: running → updating → running
```

### Uninstall

```
1. User clicks "Uninstall"
2. Worker:
   a. docker compose down --volumes --remove-orphans
   b. Removes app data directory
   c. Removes app definition files
   d. Frees allocated ports
3. Database row deleted
4. Cloudflare DNS cleaned up if exposed
```

---

## Build and deployment

### Docker build for production

The `Dockerfile` is a multi-stage build:

```
Stage 1: builder_base
  - Node.js Alpine + pnpm
  - Downloads architecture-specific docker-compose binary (amd64/arm64)

Stage 2: builder
  - Installs all dependencies (including devDependencies)
  - Builds all packages: common → backend → frontend
  - Produces ESM bundle via esbuild

Stage 3: runner
  - Minimal Alpine image with: curl, openssl, git, docker-cli, dmidecode
  - Installs production-only npm packages (argon2, drizzle-orm, pg, ssh2, etc.)
  - Copies built backend (main.js), frontend (dist/client), assets, migrations, translations
  - Patches package.json to set type=module (ESM)
  - Runs: node ./main.js
  - Exposes port 3000 (mapped to 5002 in compose)
```

### Development build

`Dockerfile.dev` is a single-stage build that installs all dependencies and runs `turbo dev` with hot reload. Source directories are bind-mounted for instant feedback.

### CI/CD pipeline

GitHub Actions workflow per branch:

| Branch | Environment | Image Tag | Protection |
|--------|-------------|-----------|------------|
| `dev` | dev | `ghcr.io/companionintelligence/ci-hub:dev` | None (auto) |
| `staging` | staging | `ghcr.io/companionintelligence/ci-hub:staging` | Optional approval |
| `main` | production | `ghcr.io/companionintelligence/ci-hub:latest` | Required approval |

A **Desktop Release** run additionally publishes an unprefixed version tag
(`ghcr.io/companionintelligence/ci-hub:0.2.45`) for `production` only — that is the exact
reference a shipped desktop bundle pins via `CI_HUB_BUILD_VERSION`. Non-production runs
publish their channel tag alone, because they compile a different `CI_CLOUD_URL` and must
never claim a production version tag.

The repo name is `ci-hub` on GHCR and on the Portal listing path (`/v2/ci-hub`). The compose
service, container, and Docker DNS name are also `ci-hub` (`ci-hub-queue`, `ci-hub_network`,
`ci-hub.managed` labels). The retired `ci-os-hub` spellings remain network aliases and
lookup fallbacks so already-installed apps keep resolving. Pointing the **image** at the
retired private `ci-os-hub` GHCR package is what broke Hub 0.2.44 (#920).

Two Docker networks carry different trust. `ci-hub_network` (and its retired alias
`ci-os-hub_network`) is the app-facing one: every installed app's main container joins it to
reach the Hub API and other apps' gateways. `ci-hub_internal` is Hub-private: Postgres and
RabbitMQ live only there and only the `ci-hub` service joins it, so a marketplace container
cannot reach the Hub's database or its lifecycle queue at all — by topology, not by password.
Both also publish a host port bound to `127.0.0.1` for local tooling, never to the LAN. The
queue additionally authenticates every message it carries (`modules/queue/message-signing.ts`),
so even a leaked broker password does not confer Hub authority.

Images are pushed to **GitHub Container Registry** (ghcr.io). The package must remain
**public**: the desktop shells out to `docker compose` with no registry credentials, so any
image it pins has to be anonymously pullable. `build-container.yml`'s
`verify-anonymous-pull` job enforces this on every run, unauthenticated, before any desktop
bundle is built. Each environment has its own Cloudflare API token and account ID as GitHub
secrets.

A **Cloudflare Workers** deployment (`wrangler.toml`) defines a Durable Object (`AppContainer`) for future container orchestration at the edge, with separate Workers environments for dev, staging, and production.

### Self-update

Users can update their Hub in-place:
1. `SystemUpdateService.checkForUpdates()` reads the running container's image and OCI labels (never `CI_HUB_VERSION`) and lists newer releases from the Portal registry. Only a release-pinned node is offered one.
2. `SystemUpdateService.performUpdate()` pulls the release, pins it in the env file, and starts an updater container that recreates only the Hub service from the compose files, project, and env file recorded in the container's compose labels.
3. The `scripts/updater/update.sh` script is a host-side, whole-stack alternative that reads the same labels.

See [`hub-stack-self-update.md`](hub-stack-self-update.md) for the refusals and the per-node auto-update switch.

---

## Testing

### Unit tests

Vitest runs unit tests in backend and frontend packages. Tests are co-located with source files or in `__tests__/` directories. Coverage is reported to Codecov (informational, non-blocking).

### End-to-end tests

**Playwright** runs browser automation tests against a full stack:

**Configuration:**
- Single worker, sequential execution (no parallel)
- Chromium desktop browser
- 60-second timeout per test
- Video and trace capture on failure
- HTML reporter (+ GitHub reporter in CI)

**Test infrastructure:** Playwright auto-starts three services for the **default lane** (`pnpm test:e2e:ci`):

1. **Companion Portal mock** (port 4444) — lightweight HTTP stub ([`e2e/mock-portal/server.ts`](../e2e/mock-portal/server.ts))
2. **Backend** (port 3000) — Full NestJS app with real PostgreSQL and RabbitMQ
3. **Frontend** (port 9091) — Vite dev server (preview build in CI)

**Extended lanes** (not in default `testIgnore` coverage):

| Lane | Command / workflow | Portal | Notes |
|------|-------------------|--------|-------|
| Cross-domain | `pnpm e2e:cross-domain` / [`e2e-extended.yml`](../.github/workflows/e2e-extended.yml) | Real CI-Portal via wrangler (port 8012) | Hub ↔ Portal pairing |
| Future onboarding | `pnpm e2e:future:onboarding` / `e2e-extended.yml` | Mock (4444) | AI setup wizard |
| Platform | [`e2e-platform.yml`](../.github/workflows/e2e-platform.yml) | N/A | Self-hosted Hub + test app |
| Fleet | [`e2e-fleet.yml`](../.github/workflows/e2e-fleet.yml) | Live cloud URL | Tailscale-connected hardware |

See [`e2e/README.md`](../e2e/README.md) for full lane documentation.

**Test data:** E2E tests use `/tmp/ci-hub-e2e` as the root data directory. A custom fixture creates test users via the API before each test suite.

**Coverage areas:**

| Test File | Area |
|-----------|------|
| `auth.spec.ts` | Registration, login, TOTP, password reset |
| `dashboard.spec.ts` | Dashboard rendering, system metrics |
| `app-store-browsing.spec.ts` | Store navigation, search, filtering |
| `app-lifecycle.spec.ts` | Install, start, stop, uninstall flows |
| `app-store-lifecycle.spec.ts` | Store-level app lifecycle |
| `apps.spec.ts` | My Apps page functionality |
| `ftue.spec.ts` | First-time user experience / onboarding |
| `settings.spec.ts` | Settings page interactions |
| `navigation.spec.ts` | Route transitions and deep linking |
| `health-api.spec.ts` | API health check endpoint |
| `error-states.spec.ts` | Error handling and edge cases |
| `dev-mode.spec.ts` | Development-only features |
| `launch-path.spec.ts` | Deep link launch paths |
| `cross-domain/` | Hub ↔ Portal pairing (extended lane — [`playwright.cross-domain.config.ts`](../playwright.cross-domain.config.ts)) |
| `future/` | Onboarding AI setup, networking specs (extended lane — see `e2e/README.md`) |
| `platform/` | App networking/lifecycle (self-hosted — [`e2e-platform.yml`](../.github/workflows/e2e-platform.yml)) |

---

## Tooling and code quality

| Tool | Purpose |
|------|---------|
| **pnpm 10** | Package manager with workspace support |
| **Turborepo** | Monorepo task runner with caching |
| **Biome** | Linter and formatter (replaces ESLint + Prettier). 2-space indent, 150-char lines, trailing commas, no console.log in production code. Git-aware — only checks changed files. |
| **Husky** | Git hooks — runs `lint-staged` (Biome fix) on pre-commit |
| **TypeScript 5.8** | Strict mode across all packages |
| **openapi-ts** | Auto-generates frontend API client from backend Swagger spec |
| **Drizzle Kit** | Database migration generation and management |
| **Crowdin** | Translation management (community translations) |
| **Codecov** | Coverage reporting (informational) |

---

## Environment variable reference

### Required

| Variable | Description |
|----------|-------------|
| `ROOT_FOLDER_HOST` | Absolute host path for all persistent data |
| `JWT_SECRET` | Secret key for signing JWT session tokens |

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_HOST` | `ci-hub-db` | PostgreSQL hostname |
| `POSTGRES_PORT` | `6543` | PostgreSQL port |
| `POSTGRES_USERNAME` | `companion` | Database user |
| `POSTGRES_PASSWORD` | `postgres` | Database password |
| `POSTGRES_DBNAME` | `companiondb` | Database name |

### Message queue

| Variable | Default | Description |
|----------|---------|-------------|
| `RABBITMQ_HOST` | `ci-hub-queue` | RabbitMQ hostname |
| `RABBITMQ_PORT` | `5672` | RabbitMQ port |
| `RABBITMQ_USERNAME` | `companion` | Queue user |
| `RABBITMQ_PASSWORD` | `admin` | Queue password |

### Networking

| Variable | Default | Description |
|----------|---------|-------------|
| `CI_CLOUD_URL` | `https://hub.companionintelligence.com` | Companion Portal URL |
| `DOMAIN` | — | Public domain for Cloudflare exposure |
| `LOCAL_DOMAIN` | `ci.lan` | Local domain for Traefik routing |
| `INTERNAL_IP` | `127.0.0.1` | Host internal IP address |
| `HTTP_PORT` | `80` | Traefik HTTP entrypoint |
| `HTTPS_PORT` | `443` | Traefik HTTPS entrypoint |

### System

| Variable | Default | Description |
|----------|---------|-------------|
| `CI_HUB_VERSION` | `0.2.27` | Hub version string |
| `API_PORT` | `5002` (prod) / `3000` (dev) | Backend listen port |
| `NODE_ENV` | `production` | Node.js environment |
| `LOG_LEVEL` | `info` | Winston log level |
| `QUEUE_TIMEOUT_IN_MINUTES` | `5` | Max time for async queue jobs |
| `ARCHITECTURE` | auto-detected | CPU architecture (amd64/arm64) |

### Feature flags

| Variable | Default | Description |
|----------|---------|-------------|
| `PRIVATE_VPN_USER_DISABLED` | unset (sidecar on) | Set `true` to opt out of `hub-tailscale`; default includes `private-vpn` in `COMPOSE_PROFILES` |
| `DEMO_MODE` | `false` | Read-only demo mode |
| `GUEST_DASHBOARD` | `false` | Allow unauthenticated dashboard access |
| `ADVANCED_SETTINGS` | `false` | Show advanced settings in UI |
| `ALLOW_AUTO_THEMES` | `true` | Allow automatic theme switching |
| `DISABLE_PASSWORD_RESET` | `false` | Disable password reset flow |
