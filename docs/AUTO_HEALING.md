# Auto-Healing

The Hub is designed to bring itself up — and keep itself up — without the user
having to understand Docker, Traefik, or compose internals. This document
describes the layers of self-healing that run automatically, with particular
attention to what happens on **first-time setup** (the very first launch on a
new machine).

The healing logic lives in three places:

| Layer | Where | Heals |
|-------|-------|-------|
| **Desktop (Tauri/Rust)** | `packages/desktop/src-tauri/src/main.rs`, `hub_manager.rs` | The Hub stack itself — Traefik, Postgres, RabbitMQ, the Hub backend |
| **Backend (NestJS)** | `packages/backend/src/.../app-lifecycle`, `app.service.ts` | Installed marketplace apps and their reconciled status |
| **Docker Compose** | `docker-compose.prod.yml` | Per-container crash recovery and startup ordering |

---

## On first-time setup

When the desktop app launches for the first time, there is no running Hub, no
saved configuration hash, and no persisted Traefik state. The first-launch path
is the most healing-heavy path the app ever runs:

1. **Initialize the data dir and compose files.** `hub_manager::initialize_hub`
   creates the Hub data directory, seeds `docker-compose.prod.yml` and `.env`,
   and runs the **Traefik runtime preflight** (`prepare_traefik_runtime_state`),
   which seeds `state/traefik/config/traefik.yml`, `dynamic/dynamic.yml`, the
   `tls/` directory, and `acme_storage.json` if any are missing.
   (`main.rs` setup hook, ~L190–207)

2. **Decide to start.** The hash-based reconciliation block sees that no
   containers exist yet and sets `should_start = true` with the reason
   *"containers are missing"*. (`main.rs`, ~L216–265)

3. **Pre-clean, then start.** Before the first `compose up`, the app runs
   `cleanup_stale_project_containers` to clear any leftovers from a prior
   install/uninstall cycle, then calls `start_hub` on a background task.
   (`main.rs`, ~L267–333)

4. **Start with self-heal + retry.** `start_hub` (in `hub_manager.rs`) brings the
   stack up under a retry loop that repairs common first-run failures — see
   [Stack startup self-heal](#desktop-stack-startup-self-heal) below.

5. **Compose enforces ordering and keeps containers alive.** Health checks gate
   `depends_on`, and every container has `restart: unless-stopped`, so a service
   that crashes during the first cold start is restarted by Docker automatically
   — see [Container-level recovery](#container-level-recovery-docker-compose).

6. **Backend schedules ongoing reconciliation.** Once the Hub backend boots, it
   registers the repeatable jobs (5-minute app status sync, 15-minute repo
   update) described in [Installed-app reconciliation](#installed-app-reconciliation-backend).

The user sees the onboarding wizard while all of this happens behind the
front end (`hasCompletedOnboarding` is `false` until they finish). If Docker
isn't running yet, the desktop app logs *"Skipping auto-start because Docker is
not currently available"* and the same reconciliation runs on the next launch
once Docker is up — first-time setup is **idempotent and resumable**.

---

## Desktop: hash-based reconciliation

**Where:** `packages/desktop/src-tauri/src/main.rs` (setup hook, ~L216–340)

On **every** launch (not just the first), the app decides whether to (re)start the
Hub stack by comparing the current configuration against the last-known-good
state. It computes a SHA-256 hash of `docker-compose.prod.yml` + `.env` and
compares it to `.config-hash` in the data dir.

`should_start` is decided in priority order:

| Condition | Decision | Why |
|-----------|----------|-----|
| User explicitly stopped the Hub (`.user-stopped` marker) | **don't start** | Honour the user's "Stop Hub" decision across relaunches |
| Containers missing | **start** | First launch, or containers were removed |
| Traefik recreate required (preflight changed mounted state) | **start** | Runtime state changed; Traefik must be recreated before reuse |
| Config hash changed | **start** | Upgrade, env fix, or compose change |
| Otherwise | **do nothing** | Containers exist, config unchanged, no repair pending |

The decision and its reason are written to the desktop log. After a start
attempt, the new hash is persisted **regardless of compose exit status** — a
partial start (e.g. a Traefik port conflict) is still a valid state, and saving
the hash prevents every relaunch from re-running compose forever.

This is what heals a **poisoned upgrade**: if a new Hub version ships a changed
compose file or `.env`, the hash mismatch forces a recreate on next launch
without the user doing anything.

---

## Desktop: stack startup self-heal

**Where:** `packages/desktop/src-tauri/src/hub_manager.rs` — `start_hub` /
`start_hub_inner` (~L3208–3583)

`start_hub` is guarded against concurrent invocation by an atomic
`START_IN_PROGRESS` flag with an RAII guard, so overlapping start requests
collapse to one. Before the retry loop it runs the **Traefik preflight**
(`prepare_traefik_runtime_state`) and, if that changed mounted state, writes a
recreate marker so Traefik is recreated rather than reused.

The core is a retry loop, `for attempt in 1..=MAX_START_RETRIES` (**3 attempts**:
1 initial + 2 retries). On each failed `docker compose up -d`, the combined
output is pattern-matched and a **targeted repair** runs before retrying:

| Detected failure | Repair action | Retries? |
|------------------|---------------|----------|
| **Container name conflict** (stale containers from a prior install) | `cleanup_stale_project_containers` (compose down) + 2s pause | Yes |
| **Host port bind conflict** (80/443 already bound) | Release stale Traefik, `ci-hub-db` (6543) and `ci-os-hub-queue` (5001) if not running, clean orphaned port proxies, compose down + 2s pause | Yes |
| **Docker-config mount path poisoned** (host bind for `/data/.docker/config.json` became a directory) | `ensure_hub_docker_config_state` rebuilds it + 1s pause | Yes |
| **OCI runtime error** (Docker Desktop / WSL2 broken) | Log and **stop retrying** — needs a manual Docker restart | No |
| Any other transient failure | Exponential backoff: `2^attempt` seconds, then retry | Yes |

On a successful `compose up`, the app then calls `wait_for_hub_healthy()` and
only reports success once `ci-os-hub` reports **running: healthy**. If compose
succeeds but the Hub never becomes ready, the error includes a "view logs" hint.

All steps append to the desktop log (`hub.start` channel) so a failed start is
diagnosable after the fact.

---

## Installed-app reconciliation (backend)

**Where:** `packages/backend/src/modules/app-lifecycle/app-status-sync.service.ts`,
scheduled from `packages/backend/src/app.service.ts`

On bootstrap the backend registers two repeatable jobs (production):

- `update_all` — every **15 minutes** (pulls the marketplace app repo)
- `sync_app_statuses` — every **5 minutes** (reconciles installed-app status)

It also restarts running apps after a Hub version change or nightly build
(`buster !== version || version === 'nightly'`) so installed apps come back up
on the new Hub version.

### App status sync (every 5 minutes)

`syncAllAppStatuses` lists all containers labelled `ci-os-hub.managed=true`,
groups them by app URN, and reconciles each installed app's DB status against
reality:

- **`running`** — every container is running, or exited cleanly (`Exited (0)`).
- **`stopped`** — some containers are not running (mixed state is logged).
- **`missing`** — no containers exist at all.

Guards prevent false alarms:

- **Transitional grace.** Apps in a transitional state (`installing`,
  `uninstalling`, `stopping`, `starting`, `updating`, `resetting`, `restarting`,
  `backing_up`, `restoring`) are skipped while within their grace window. The
  window is `eventsTimeout`, extended to `max(eventsTimeout, image-pull-timeout)`
  for the long-running `installing` / `updating` states so big image pulls
  aren't mistaken for failures. Apps stuck past the grace window are logged as
  stuck.
- **Mid-install protection.** An `installing` / `install_failed` app with no
  containers is **not** marked `missing` (the pull may simply be slow).

When a status actually changes, it is written to the DB and broadcast over SSE
(`status_change`). **Crash detection:** a `running → stopped` or
`running → missing` transition fires an `app.crashed` agent notification at
**high** urgency, so the agent layer can react.

> Related: `agent-health-check.service.ts` notifies the agent on high disk usage
> (high urgency), high memory (medium), and health-check failures (low).

---

## Container-level recovery (Docker Compose)

**Where:** `docker-compose.prod.yml`

Two compose mechanisms provide the always-on safety net underneath everything
above:

**Restart policy.** Every Hub infrastructure container — `ci-hub-db`,
`ci-os-hub-queue`, `ci-os-hub`, `traefik`, `cloudflared`, `hub-tailscale` — uses
`restart: unless-stopped`. Docker restarts any of them automatically if they
crash, and keeps them down only if a user explicitly stopped them.

**Health checks + ordered startup.** Dependent services wait on
`depends_on: condition: service_healthy`, so the Hub backend doesn't start
before its database and queue are actually ready:

| Service | Health check | Interval | Retries | Start period |
|---------|--------------|----------|---------|--------------|
| `ci-hub-db` (Postgres) | `pg_isready -d companiondb -U companion -p 6543` | 5s | 120 | — |
| `ci-os-hub-queue` (RabbitMQ) | `rabbitmq-diagnostics -q check_running` | 15s | 20 | 180s |
| `ci-os-hub` (Hub) | `curl -f http://localhost:5002/api/health` | 10s | 15 | 90s |
| `hub-tailscale` | `tailscale status --json … grep BackendState` | 5s | 12 | 10s |

---

## Connection-level retry

Several clients reconnect on their own with exponential backoff, so transient
network/service blips heal without surfacing to the user:

- **Queue (RabbitMQ).** `QueueFactory` reconnects with exponential backoff.
- **MCP bridge / OpenClaw plugin.** Lazy reconnect to app MCP servers with
  exponential backoff capped at 30s
  (`packages/backend/src/modules/mcp/agents/mcp-bridge.service.ts`,
  `packages/openclaw-plugin/src/mcp-client.ts`).
- **Frontend SSE.** The generated SSE client retries with backoff from 3s up to
  30s (`packages/frontend/src/api-client/core/serverSentEvents.gen.ts`).
- **Port / subnet allocation.** Concurrent installs retry allocation on
  conflict (`port-manager.service.ts`, `subnet-manager.service.ts`).

---

## Respecting user intent

Auto-healing never fights the user:

- A user who clicks **Stop Hub** writes a `.user-stopped` marker; the desktop
  reconciliation will not auto-restart the stack on the next launch until they
  click **Start Hub** (which clears the marker).
- `restart: unless-stopped` won't resurrect a container the user stopped
  on purpose.

---

## Where to look when healing misbehaves

- **Desktop log** (`hub.start`, `setup` channels) — every start decision,
  detected failure, repair action, and retry is logged here.
- **`.config-hash`**, **`.user-stopped`**, Traefik recreate marker — the
  reconciliation state files in the Hub data dir.
- **Backend logs** — app status sync results (`Synced N apps`), stuck-app
  warnings, and crash notifications.
- **`docker ps -a`** — the ground truth the backend reconciles against.

See [docs/ARCHITECTURE.md](ARCHITECTURE.md) for the broader system design.
