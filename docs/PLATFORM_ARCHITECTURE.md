# CI Platform Architecture

This document describes how the three core components of the Companion Intelligence platform — the **Portal**, the **Hub**, and the **App Store** — work together to provide a self-hosted app platform with cloud-managed identity, tunnel networking, and a marketplace.

---

## Platform Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              End Users                                          │
│   Browser · Tauri Desktop · Mobile                                              │
└──────┬──────────────────────────┬──────────────────────────┬────────────────────┘
       │                          │                          │
       ▼                          ▼                          ▼
┌──────────────────┐   ┌──────────────────────┐   ┌──────────────────────────────┐
│   CI Portal      │   │   CI Hub             │   │   Cloudflare Edge            │
│                  │   │                      │   │                              │
│  Cloudflare      │   │  Self-hosted on      │   │  DNS · Tunnel Ingress        │
│  Workers + D1    │   │  user hardware       │   │  Zero Trust Access · TLS     │
│                  │   │                      │   │                              │
│  Identity        │   │  NestJS API          │   │  Routes public traffic       │
│  Organizations   │   │  React Dashboard     │   │  to Hub via cloudflared      │
│  Device Pairing  │   │  Docker Management   │   │                              │
│  Tunnel Mgmt     │   │  Traefik Proxy       │   │                              │
│  App Store API   │   │  App Lifecycle       │   │                              │
│  Docker Registry │   │  RabbitMQ Workers    │   │                              │
│  OAuth Proxy     │   │  Headscale VPN       │   │                              │
└──────────────────┘   └──────────────────────┘   └──────────────────────────────┘
       │                          │                          ▲
       │                          │                          │
       │    ┌─────────────────────┘                          │
       │    │  cloudflared tunnel connection                  │
       │    └────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────┐
│  CI App Store    │
│                  │
│  Git repository  │
│  of app defs     │
│  (config.json +  │
│   compose specs) │
└──────────────────┘
```

### Component Roles

| Component | Runtime | Primary Role |
|-----------|---------|-------------|
| **CI Portal** | Cloudflare Workers (Hono), D1, R2 | Cloud control plane — identity, organizations, device registration, tunnel provisioning, app marketplace, Docker registry, OAuth proxy |
| **CI Hub** | Docker on user hardware (NestJS, PostgreSQL, RabbitMQ) | On-premise data plane — installs/runs Docker apps, manages local Traefik routing, connects to Portal for tunnels and marketplace |
| **CI App Store** | Git repository | App catalog — contains app definitions (metadata, Docker Compose specs, form schemas) consumed by Hubs via git clone |
| **Cloudflare Edge** | Cloudflare infrastructure | Network plane — terminates TLS, routes public traffic through tunnels to Hubs, enforces Zero Trust access policies |

---

## Identity and Organizations

The Portal is the **single source of truth for identity**. Users create accounts on the Portal and organize access through organizations.

### Authentication

The Portal uses **Better-Auth** with multiple authentication methods:

| Method | Details |
|--------|---------|
| Email/password | Standard signup with email verification |
| OAuth | Google, GitHub, Discord (extensible to any OIDC provider) |
| Passkeys | WebAuthn for passwordless login |
| TOTP 2FA | Time-based one-time passwords with backup codes |

Sessions are stored in D1 and tracked via HTTP-only cookies. The Portal also maintains a JWKS endpoint so it can act as an **OIDC identity provider** for Cloudflare Zero Trust, allowing users to access their tunnel-exposed apps with the same Portal credentials.

### Organizations

Organizations are the multi-tenancy boundary. Every device, tunnel, and marketplace publication belongs to an organization.

```
Organization
  ├── Members (owner / admin / member roles)
  ├── Invitations (email-based, 7-day expiry)
  ├── Devices (registered Hubs)
  │     ├── Tunnel (Cloudflare tunnel instance)
  │     └── Applications (exposed apps)
  ├── Published Apps (developer store listings)
  └── Audit Log (all changes tracked)
```

- **Owners** have full control including org deletion and member role changes
- **Admins** can manage devices and members
- **Members** have read-only access
- Organizations cannot be deleted while they still have registered devices
- All mutations are recorded in the audit log with actor, action, target, and timestamp

---

## Device Registration and Pairing

The pairing flow connects a physical Hub to an organization on the Portal and provisions all necessary infrastructure (tunnel, DNS, access policies).

```
┌──────────┐                ┌──────────────┐                ┌──────────────────┐
│  CI Hub  │                │   Browser    │                │   CI Portal      │
└────┬─────┘                └──────┬───────┘                └────────┬─────────┘
     │                             │                                 │
     │  1. Display pairing URL     │                                 │
     │  ─────────────────────────► │                                 │
     │     (includes device_id)    │                                 │
     │                             │  2. User opens URL, logs in     │
     │                             │ ───────────────────────────────►│
     │                             │                                 │
     │                             │  3. Select org + device name    │
     │                             │ ───────────────────────────────►│
     │                             │                                 │
     │                             │                    4. Portal:   │
     │                             │                    ┌────────────┤
     │                             │                    │ Validate   │
     │                             │                    │ device in  │
     │                             │                    │ whitelist  │
     │                             │                    │            │
     │                             │                    │ Create/    │
     │                             │                    │ reuse CF   │
     │                             │                    │ tunnel     │
     │                             │                    │            │
     │                             │                    │ Create DNS │
     │                             │                    │ CNAME      │
     │                             │                    │            │
     │                             │                    │ Create CF  │
     │                             │                    │ Access app │
     │                             │                    │            │
     │                             │                    │ Generate   │
     │                             │                    │ API key    │
     │                             │                    │            │
     │                             │                    │ Invalidate │
     │                             │                    │ pairing    │
     │                             │                    │ code       │
     │                             │                    └────────────┤
     │                             │                                 │
     │  5. Callback with credentials                                 │
     │ ◄────────────────────────────────────────────────────────────│
     │     { api_key, tunnel_id, tunnel_token,                      │
     │       organization_id, subdomain }                            │
     │                                                               │
     │  6. Save credentials, start cloudflared                       │
     │  7. Hub now reachable at:                                     │
     │     hub-{device-slug}-{org-slug}.{domain}                    │
```

### What Gets Provisioned

| Resource | Created By | Details |
|----------|------------|---------|
| **Cloudflare Tunnel** | Portal → Cloudflare API | Named `hub-{device_id}`, one per device |
| **DNS CNAME** | Portal → Cloudflare API | `hub-{device-slug}-{org-slug}.{domain}` → `{tunnelId}.cfargotunnel.com` |
| **Access Application** | Portal → Cloudflare API | Zero Trust policy protecting the Hub's public URL |
| **Device Registration** | Portal D1 | Links device ID to organization, tracks `lastSeen` |
| **Application Row** | Portal D1 | `privilegedKind='hub'` entry representing the Hub itself (port 5002) |
| **OAuth Client** | Portal D1 | Registers the device for OAuth proxy flows |
| **API Key** | Portal D1 | Per-device UUID secret for Hub → Portal authentication |

The pairing code is a 6-character alphanumeric string, single-use — once consumed it's replaced with `used-{UUID}` so it can never be reused.

---

## Tunnel Networking and App Exposure

Once a Hub is paired, it can expose installed apps to the internet through the Cloudflare tunnel.

### App Exposure Flow

```
┌──────────┐           ┌──────────────┐           ┌──────────────┐
│  CI Hub  │           │  CI Portal   │           │  Cloudflare  │
└────┬─────┘           └──────┬───────┘           └──────┬───────┘
     │                        │                          │
     │  POST /api/tunnels/    │                          │
     │  state                 │                          │
     │  { apps: [...] }       │                          │
     │ ──────────────────────►│                          │
     │                        │                          │
     │                        │  PUT tunnel config       │
     │                        │  (ingress rules)         │
     │                        │ ────────────────────────►│
     │                        │                          │
     │                        │  Create/update DNS       │
     │                        │  CNAMEs per app          │
     │                        │ ────────────────────────►│
     │                        │                          │
     │                        │  Create/update Access    │
     │                        │  Applications            │
     │                        │ ────────────────────────►│
     │                        │                          │
     │                        │  Delete stale app        │
     │                        │  DNS + Access records    │
     │                        │ ────────────────────────►│
     │                        │                          │
     │  200 OK                │                          │
     │ ◄──────────────────────│                          │
```

### How It Works

1. **Hub syncs state** — Whenever an app's exposure changes (install, update-config, uninstall), the Hub's `CloudflareClientService` calls `POST /api/tunnels/state` with the full list of currently exposed apps.

2. **Portal rebuilds tunnel config** — The Portal processes the sync:
   - Reconstructs the Hub's own ingress rule from the database (source of truth for the Hub port)
   - Generates ingress rules for each user app: `{app-subdomain}-{device-slug}-{org-slug}.{domain}`
   - Sets `originRequest.httpHostHeader` so Traefik on the Hub can route by hostname
   - Sends the complete ingress configuration to Cloudflare's tunnel API

3. **Portal manages DNS** — For each app, creates or updates a DNS CNAME pointing to the tunnel. Stale apps (no longer in the sync payload, not pinned, not privileged) have their DNS records and Access applications cleaned up.

4. **Cloudflare routes traffic** — The `cloudflared` daemon on the Hub maintains a persistent encrypted connection to Cloudflare's edge. Incoming HTTPS requests are matched against ingress rules and proxied to the local service.

### Ingress Rule Generation

```yaml
# Generated by Portal, applied to Cloudflare tunnel
ingress:
  - hostname: hub-mydevice-myorg.ci.computer
    service: http://host.docker.internal:5002

  - hostname: jellyfin-mydevice-myorg.ci.computer
    service: http://host.docker.internal:8096
    originRequest:
      httpHostHeader: jellyfin.ci.lan

  - hostname: nextcloud-mydevice-myorg.ci.computer
    service: http://host.docker.internal:443
    originRequest:
      httpHostHeader: nextcloud.ci.lan

  - service: http_status:404    # catch-all fallback
```

The `httpHostHeader` is set so that Traefik on the Hub can use hostname-based routing to reach the correct app container, even though the tunnel delivers all traffic to `host.docker.internal`.

### Three Exposure Modes

| Mode | Routing | Auth | Use Case |
|------|---------|------|----------|
| **Local only** | `http://127.0.0.1:{port}` (ADR 001); Traefik `*.{LOCAL_DOMAIN}` is tunnel origin only | Direct / host-only session | This computer |
| **Cloudflare Tunnel** | Sibling `{app}-{device}-{org}.{domain}` via Cloudflare edge | Hub forward-auth + **edge ticket SSO** (ADR 002) when Hub/app cookies cannot span siblings | Public internet access |
| **Tailscale VPN** | Tailscale IP via Headscale coordination | End-to-end encrypted | Private remote access without public DNS |

---

## App Store and Marketplace

Apps flow through the platform via two channels: the **git-based app catalog** (free, open-source) and the **Portal marketplace API** (supports paid apps, reviews, and a Docker registry).

### Git-Based App Catalog (CI App Store)

The simplest path. The CI App Store is a **git repository** containing app definitions:

```
CI-App-Store/
  apps/
    nextcloud/
      config.json              # App metadata (name, port, categories, form fields)
      docker-compose.json      # Service definition (images, volumes, env)
      metadata/
        description.md         # Long-form description
        logo.jpg               # App icon
    jellyfin/
      ...
```

**How Hubs consume it:**

1. Hub stores have the store URL in the `app_store` database table (type: `git`)
2. On startup and periodically, `RepoEventsQueue` workers clone/pull the repository to `$DATA_DIR/repos/{slug}/`
3. `MarketplaceService` loads `config.json` from each app, builds a MiniSearch full-text index
4. Users browse the index in the Hub's app store UI
5. On install, app files are copied from the repo to the installed apps directory and Docker Compose is run

```
┌──────────┐         git clone/pull        ┌──────────────────┐
│ CI Hub   │ ────────────────────────────── │ CI App Store     │
│          │                                │ (GitHub repo)    │
│ repos/   │ ◄──────────────────────────── │ apps/{name}/     │
│          │        app definitions         │   config.json    │
└──────────┘                                │   compose.json   │
                                            └──────────────────┘
```

### Portal Marketplace API

For published apps (including paid apps), the Portal provides a REST API and Docker registry:

```
┌──────────────┐    GET /api/store         ┌──────────────────┐
│  CI Hub      │ ─────────────────────────►│  CI Portal       │
│  (frontend)  │    browse apps            │  (Hono API)      │
│              │ ◄─────────────────────────│                  │
│              │    app metadata + compose  │  D1: store_app   │
│              │                            │  D1: versions    │
│              │    GET /api/store/:id/     │  R2: images,     │
│              │    install                 │      compose,    │
│              │ ─────────────────────────►│      metadata    │
│              │ ◄─────────────────────────│                  │
│              │    { compose, config }     │                  │
│              │                            │                  │
│  Docker      │    docker pull             │  Docker V2       │
│  Engine      │    portal.ci.computer/     │  Registry        │
│              │    app-slug:latest         │  /v2/*           │
│              │ ─────────────────────────►│                  │
│              │ ◄─────────────────────────│  R2: blobs,      │
│              │    image layers            │      manifests   │
└──────────────┘                            └──────────────────┘
```

**Publishing workflow:**

1. Developer packages their app as a tar.gz archive (config.json + docker-compose.json + metadata/)
2. Calls `POST /api/store/ingest` with the archive and an admin API key
3. Portal validates schemas, extracts files, uploads to R2, creates/updates D1 records
4. If the app includes Docker images, they're pushed to the Portal's OCI-compatible registry

**Store data model:**

| Table | Purpose |
|-------|---------|
| `store_app` | App listings — title, description, pricing, tags, privacy labels, status (draft/published/archived) |
| `store_app_version` | Versioned releases — semver, changelog, compose definition, published flag |
| `store_review` | User ratings (1–5) with optional developer responses |
| `store_discount` | Discount codes — percentage or fixed, per-app or global, usage limits, expiry |
| `store_subscription` | Active subscriptions per user (ties to payment provider) |
| `store_transaction` | Immutable purchase records (amount, currency, status, payment intent) |

**Pricing models:** Free, Paid (fixed), Pay-What-You-Want (min/suggested price), Subscription (monthly/yearly).

### Docker Registry

The Portal implements the **OCI Distribution Spec** (Docker V2 Registry) backed by Cloudflare R2:

```
Docker Client                   Portal /v2/*                   R2 Storage
     │                               │                              │
     │  GET /v2/                     │                              │
     │  (version check)              │                              │
     │ ─────────────────────────────►│                              │
     │                               │                              │
     │  GET /v2/app/manifests/latest │                              │
     │ ─────────────────────────────►│── GET docker/app/manifests ─►│
     │ ◄─────────────────────────────│◄─────────────────────────────│
     │                               │                              │
     │  GET /v2/app/blobs/sha256:... │                              │
     │ ─────────────────────────────►│── presigned R2 URL ─────────►│
     │ ◄─────────────────────────────│◄─────────────────────────────│
     │  (redirect to R2)             │                              │
```

- Repositories are **private by default** — require Basic Auth or Bearer JWT
- Public repositories (marked with a `docker/{repo}/public` marker in R2) are readable without auth
- Large blobs are served via R2 presigned URLs to avoid proxying through the Worker
- Push operations (used during publishing) require admin credentials

---

## OAuth Proxy

The Portal acts as an **OAuth proxy** so that Hub-installed apps can integrate with third-party services (GitHub, Google, etc.) without each Hub needing its own OAuth client credentials.

```
┌──────────┐         ┌──────────────┐         ┌──────────────┐
│  CI Hub  │         │  CI Portal   │         │  OAuth       │
│  (app)   │         │  (proxy)     │         │  Provider    │
└────┬─────┘         └──────┬───────┘         └──────┬───────┘
     │                      │                        │
     │  POST /oauth/        │                        │
     │  authorize           │                        │
     │  {provider, scopes}  │                        │
     │ ────────────────────►│                        │
     │                      │                        │
     │  {authorization_url} │                        │
     │ ◄────────────────────│                        │
     │                      │                        │
     │  redirect user ──────┼───────────────────────►│
     │                      │                        │
     │                      │  callback with code    │
     │                      │ ◄──────────────────────│
     │                      │                        │
     │                      │  exchange code + PKCE  │
     │                      │ ──────────────────────►│
     │                      │ ◄──────────────────────│
     │                      │  {access, refresh}     │
     │                      │                        │
     │                      │  encrypt refresh token │
     │                      │  store in D1           │
     │                      │                        │
     │  redirect with       │                        │
     │  opaque proxy token  │                        │
     │ ◄────────────────────│                        │
     │                      │                        │
     │  later: POST /oauth/ │                        │
     │  token/refresh       │                        │
     │ ────────────────────►│  rotate tokens         │
     │                      │ ──────────────────────►│
     │  new access token    │                        │
     │ ◄────────────────────│                        │
```

**Security properties:**
- Hub devices never see the Portal's OAuth client secret
- Refresh tokens are encrypted with AES-256-GCM before storage in D1
- Hubs only receive opaque proxy tokens — the real provider tokens stay in the Portal
- PKCE (Proof Key for Code Exchange) prevents authorization code interception
- Each device is registered as an OAuth client with allowed callback origins validated on every request

---

## Hub ↔ Portal Communication

All communication between a Hub and the Portal is authenticated via the device's **API key** (a UUID generated during pairing).

### Authentication

The Hub sends its credentials in the `x-device-key` header. The Portal's `deviceAuthMiddleware` validates the key against the `device` table and injects the device context into the request.

### API Calls Made by Hub

| Hub Action | Portal Endpoint | Purpose |
|------------|----------------|---------|
| Registration check | `GET /api/devices/pair?pairing_code=...` | Check if device is ready for pairing |
| Complete pairing | `POST /api/devices/pair` | Finish registration, get credentials |
| Sync exposed apps | `POST /api/tunnels/state` | Update tunnel ingress rules and DNS |
| Browse marketplace | `GET /api/store` | List published apps with search/filter |
| Get app install bundle | `GET /api/store/:id/install` | Download compose + config for installation |
| Get app image | `GET /api/store/:id/image` | Stream app logo from R2 |
| Docker image pull | `GET /v2/{name}/manifests/...`, `GET /v2/{name}/blobs/...` | Pull Docker images from Portal registry |
| OAuth initiation | `POST /api/oauth/authorize` | Start third-party OAuth flow |
| Token refresh | `POST /api/oauth/token/refresh` | Rotate OAuth access tokens |
| Token revocation | `POST /api/oauth/token/revoke` | Revoke OAuth tokens |

### Data That Lives Where

| Data | Location | Why |
|------|----------|-----|
| User accounts, sessions | Portal (D1) | Central identity, SSO across devices |
| Organizations, members | Portal (D1) | Multi-tenant boundary |
| Device registry, API keys | Portal (D1) | DRM + device management |
| Tunnel config, DNS records | Portal → Cloudflare | Cloud-managed networking |
| App store listings, versions, reviews | Portal (D1 + R2) | Marketplace is cloud-hosted |
| Docker images | Portal (R2) | Centralized registry |
| Installed app state, config | Hub (PostgreSQL) | Local data sovereignty |
| App data volumes | Hub (Docker volumes) | User data stays on their hardware |
| Traefik routes | Hub (filesystem) | Local reverse proxy config |
| App backups | Hub (filesystem) | Local backup archives |
| Hub user accounts | Hub (PostgreSQL) | Local auth (separate from Portal identity) |

---

## App Installation End-to-End

Here is the complete journey of installing an app, from browsing to running:

```
1. USER BROWSES APP STORE
   Hub Frontend ──GET /api/marketplace/apps──► Hub Backend
                                                │
                                   MiniSearch index (cached)
                                   built from git repo + Portal API
                                                │
   Hub Frontend ◄── app list with metadata ────┘

2. USER CLICKS INSTALL
   Hub Frontend ──POST /api/app-lifecycle/{urn}/install──► Hub Backend
                  { config form values }                     │
                                                             │
                                              Validate config (domain
                                              conflicts, port conflicts,
                                              architecture support)
                                                             │
                                              Acquire mutex for app URN
                                                             │
                                              Publish to AppEventsQueue
                                                             │
   Hub Frontend ◄── SSE: status=installing ─────────────────┘

3. WORKER PROCESSES INSTALL
   RabbitMQ Worker:
     a. Copy app files from repos/{store}/{app}/ → apps/{store}/{app}/
     b. Generate docker-compose.yml from app spec + user config
     c. Write app.env with form field values
     d. Allocate ports in database
     e. docker compose pull  (download images — from Portal registry or Docker Hub)
     f. docker compose up -d (start containers)
     g. Write Traefik dynamic config for local routing

4. HUB SYNCS EXPOSURE (if app is exposed)
   Hub Backend ──POST /api/tunnels/state──► CI Portal
                 { apps: [{ name, subdomain,     │
                   localPort, protocol }] }       │
                                                  │
                            Portal rebuilds tunnel ingress
                            Portal creates/updates DNS CNAME
                            Portal creates Access Application
                                                  │
   Hub Backend ◄── 200 OK ──────────────────────┘

5. APP IS RUNNING
   Local:   https://nextcloud.ci.lan (via Traefik)
   Public:  https://nextcloud-mydevice-myorg.ci.computer (via Cloudflare tunnel)
   VPN:     https://100.64.x.x:port (via Tailscale)
```

---

## Security Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│ TRUST BOUNDARY: Internet                                     │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Cloudflare Edge                                      │    │
│  │  TLS termination · DDoS protection · WAF             │    │
│  │  Zero Trust Access (OIDC via Portal)                 │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                          │ encrypted tunnel                  │
│  ┌───────────────────────┼─────────────────────────────┐    │
│  │ TRUST BOUNDARY: User  │ Network                      │    │
│  │                       ▼                              │    │
│  │  ┌─────────────────────────────────────────────┐    │    │
│  │  │ CI Hub (Docker)                              │    │    │
│  │  │  Traefik (forward-auth → Hub JWT check)      │    │    │
│  │  │  Hub API (Argon2 passwords, JWT sessions)    │    │    │
│  │  │  App containers (network-isolated)           │    │    │
│  │  │  PostgreSQL (local, not exposed)             │    │    │
│  │  │  RabbitMQ (local, not exposed)               │    │    │
│  │  └─────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ CI Portal (Cloudflare Workers)                       │    │
│  │  Better-Auth (sessions, passkeys, 2FA)               │    │
│  │  Organization-scoped data isolation                  │    │
│  │  Device API key authentication                       │    │
│  │  Encrypted OAuth token storage (AES-256-GCM)         │    │
│  │  Audit logging on all mutations                      │    │
│  │  DRM device whitelist                                │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Authentication Layers

| Boundary | Mechanism |
|----------|-----------|
| User → Portal (web) | Better-Auth: email/password, OAuth, passkeys, TOTP 2FA |
| User → Hub (web) | Hub-local JWT sessions with Argon2 passwords, optional TOTP |
| User → Exposed app (Cloudflare) | Cloudflare Zero Trust with Portal as OIDC IdP |
| User → Exposed app (LAN) | Traefik forward-auth to Hub's `/api/auth/traefik` |
| Hub → Portal (API) | Device API key in `x-device-key` header |
| Docker → Portal (registry) | Basic Auth or Bearer JWT |
| Portal → Cloudflare (API) | Cloudflare API token (per-environment secret) |

### Data Sovereignty

User data never leaves the Hub. The Portal stores only:
- User identity and organization structure
- Device metadata and API keys
- Tunnel configuration
- App marketplace listings
- OAuth proxy tokens (encrypted)

App data, configuration files, Docker volumes, database contents, and backups all remain on the user's hardware.

---

## Environment Matrix

| Environment | Portal Domain | Hub Compose | Portal D1 | Portal R2 | Registry |
|-------------|--------------|-------------|-----------|-----------|----------|
| Local dev | `localhost:8415` | `docker-compose.local.yml` | `ci-cloud-db-local` | `ci-registry-local` | local /v2 |
| Dev | `hub.companionintelligence.com` | `.env.dev` | `ci-cloud-db-dev` | `ci-registry-dev` | dev /v2 |
| Staging | `portal.companionintel.com` | `.env.staging` | `ci-cloud-db-staging` | `ci-registry-staging` | staging /v2 |
| Production | `portal.ci.computer` | `.env.prod` | `ci-cloud-db-prod` | `ci-registry-prod` | prod /v2 |

Hub environments (`local`, `dev`, `staging`, `prod`) each point to their corresponding Portal via the `CI_CLOUD_URL` environment variable (treat `CI_CLOUD_URL` as the **Portal URL** in code and docs; `portalUrl` in new APIs).

