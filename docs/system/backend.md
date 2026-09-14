# Backend system — Companion Hub

> **Purpose:** NestJS API server — app lifecycle, Docker management, auth, queues, MCP.
> **Scope:** `packages/backend/` — modules, Drizzle schema, RabbitMQ workers, SSE.
> **Key paths:** `packages/backend/src/modules/`, `packages/backend/src/database/`, `packages/backend/src/queue/`
> **Commands:** `cd packages/backend && pnpm test`, `pnpm run test:integration` (root)
> **Owner persona:** maintainability + security (see REVIEW_PERSONAS.md)
> **Last updated:** 2026-09-09 (family Hub auth: org members become Hub people; Memory connect keys are per Hub user)
> **Related:** docs/system/e2e.md, docs/ARCHITECTURE.md

---

## Layout

```
packages/backend/
  src/modules/       Feature modules (apps, auth, docker, health, mcp, …)
  src/database/      Drizzle schema + migrations
  src/queue/         RabbitMQ workers (install, lifecycle, …)
  src/common/        Shared guards, filters, decorators
```

## Key modules

| Module | Responsibility |
|--------|----------------|
| `apps` / `app-lifecycle` | Install, start, stop, uninstall marketplace apps |
| `docker` | Dockerode + compose orchestration |
| `auth` | Hub sessions, 2FA, Portal SSO. Human login admits each Portal `(iss, sub)` in the paired org as their own operator — not `getFirstOperator()`. Session middleware prefers the newest of cookie vs `X-CI-Hub-Session`. |
| `health` | Liveness/readiness (`/api/health/live`) |
| `sse` | Real-time status stream to frontend |
| `mcp` | MCP server tools for agent apps |
| `tailscale` / `cloudflare` | Optional sidecar integrations |
| `inference` | Backend registry, model resolution, routing to a local engine |
| `hub-pool` | Multi-Hub inference pooling: peer identity, pairing, discovery, ranking, and the proxy |
| `registration` | Portal pairing, device ID, and registration-state drift. The hourly check-in also carries this Hub's own status (phase, degraded reasons, tunnel health, Tailscale connectivity, version) for Portal's org fleet report — see `check-in-payload.ts`; every field is optional and absent means "no report this time", never "the value is gone". |

## App volumes

`DockerComposeBuilder` renders each manifest volume as either a host bind mount (`hostPath`) or a
docker-managed named volume (`volumeName`), never both. Compose scopes named volumes to the app's
project, so `db` becomes `<app>_<store>_db`, and the existing lifecycle commands already reclaim
them — `down --volumes` on uninstall-with-data and reset, preserved on stop/restart/update.

A bind mount may also declare `requiresPosixPermissions: true`, meaning its contents need real
ownership. Windows-backed host paths (drvfs/9p) accept `chown`/`chmod` and silently discard them,
so postgres' `initdb`, mysql's `mysqld`, and mongo's WiredTiger all abort with `EPERM` on such a
mount. `supportsPosixPermissions()` (`common/helpers/bind-mount-helpers.ts`) probes the app-data
filesystem once per process by flipping a scratch file's mode and reading it back; when the mode
does not stick, the builder mounts those volumes as named volumes instead. The redirected volume is
named after the bind's **host path**, not its mount point — apps like `fastgpt` and `postiz` run two
postgres services that both mount `/var/lib/postgresql/data`, and naming by mount point would put
both servers on one data directory.

The probe reports "supported" on any error **by design** — the opposite would move a working app's
data directory into an empty named volume over what may be a transient IO failure. For the same
reason the redirect is keyed off the filesystem rather than applied everywhere: on Linux and macOS
bind mounts keep working and existing data stays exactly where it is.

## App lifecycle command structure

`AppLifecycleCommandFactory` builds one command object per operation (`commands/install-app-command.ts`,
`start-app-command.ts`, and eight more). They all extend `AppLifecycleCommand` in `commands/command.ts`,
which used to also carry the four steps they share. Those now live in their own modules:

| Module | Step |
|---|---|
| `commands/compose-preparation.ts` | Renders the app's `docker-compose.yml` from its manifest — architecture overrides, exposure hostnames, resource limits, subnet |
| `commands/host-device-preflight.ts` | Fails fast when a manifest wants `/dev/kfd` or `/dev/kvm` the host cannot provide |
| `commands/network-recovery.ts` | Runs compose, retrying with a fresh subnet when Docker reports an overlapping bridge range |
| `commands/failure-reporting.ts` | Turns a thrown error into the structured result the queue replies with, and reports it |

`AppLifecycleCommand` keeps a thin wrapper for each. The wrappers are load-bearing: subclasses call
them as `this.<name>()` and tests install instance spies over them, so the members have to stay on
the prototype for that dispatch to work. For the same reason `runComposeWithNetworkRecovery` receives
`ensureAppDir` and `removeStaleAppNetworks` as bound callbacks instead of importing them — a direct
import would bypass instance overrides.

Each module is tested directly in `commands/__tests__/`, which was not possible while they were
protected methods.

## Inference backend registry

`InferenceBackendRegistry` (`modules/inference/backends/backend-registry.ts`) is the single mapping
from `InferenceBackendType` to a backend instance. `get(type)` resolves one; `entries()` walks all
six in `INFERENCE_BACKEND_TYPES` order.

It replaced five byte-identical private `getBackend` switches in `model-puller`,
`inference-env-resolver`, `inference-router`, `app-credentials`, and the controller. Two details are
deliberate and easy to undo by accident:

- The map is a `Record` keyed by the union, not a `Map`. A missing backend is then a build error,
  and unlike an index signature it is not widened to `| undefined` by `noUncheckedIndexedAccess`.
- The six backend classes are **value** imports, not `import type`. Nest resolves constructor
  parameters through `emitDecoratorMetadata`'s `design:paramtypes`, so a type-only import erases them
  to `undefined` at runtime with no compile error — and Biome's `useImportType` is off for this
  package, so nothing would flag it.

`entries()` yields the type as the string from the source tuple rather than reading `backend.type`
off the instance, because test doubles are mock proxies whose `type` is undefined.

## Hub Pool

`modules/hub-pool/` is the largest single module in the backend. It is worth knowing which service
owns what before changing any of it — deep model in [`docs/hub-pool.md`](../hub-pool.md).

| Service | Owns |
|---|---|
| `hub-pool-peer.service.ts` | Peer lifecycle: pairing, approval, health polling, capabilities, and `getPoolStatus` |
| `hub-pool-proxy.service.ts` | The request path: candidate ranking, forwarding, and failover |
| `hub-pool-discovery.service.ts` | Naming unpaired candidates, and the address probe |
| `hub-pool-identity.service.ts` | This node's Ed25519 keypair and UUID |
| `hub-pool-pairing-pin.service.ts` | The six-digit PIN: mint, consume, expiry, and the attempt ceiling |
| `hub-pool-pin.service.ts` | Operator routing pins (a *different* pin — a preference, not a secret) |
| `hub-pool-pressure.service.ts` | The GPU-pressure band sampler |
| `hub-pool-routing-log.service.ts` | The in-memory last-200 routing decisions |

Two traps in this module:

- **Two things are called a pin.** `hub-pool-pairing-pin.service.ts` holds the six-digit pairing
  secret; `hub-pool-pin.service.ts` holds operator routing preferences. They are unrelated.
- **Discovery is not pollable.** Every leg probes the network, so `getPoolStatus` must never call it.

The `cihub pool` CLI mirrors these routes in `scripts/hub-pool-cli.ts` (API calls plus pure
formatters) and `scripts/lib/cli-pool.ts` (arg parsing and confirmation). The response types there
are **hand-mirrored** from `hub-pool.types.ts`, because every pool route declares an empty response
schema in `swagger.json` and the generated client types them as `unknown`. Adding a field to a pool
status payload therefore does not reach the CLI on its own — update both.

## Database

- PostgreSQL via Drizzle ORM
- Migrations in `packages/backend/drizzle/`
- Integration tests use Docker Postgres (see `integration-tests.yml`)

## Queue workers

RabbitMQ consumers handle long-running install/update operations. Frontend polls + SSE for progress.

## Install lifecycle recovery

The UI "install queue" is derived from DB rows with `status = 'installing'`, not a durable job table.
A crash, RPC timeout, or hung image pull can leave those rows stranded with nothing holding the
in-memory pipeline mutex — the home screen then shows perpetual "N installs waiting".

Guards against that:

- **Startup sweep** (`AppLifecycleService.recoverStuckInstallsOnStartup`) — on boot, every
  `installing` row with no live registry/pipeline entry becomes `install_failed`.
- **Status-sync heal** (`AppStatusSyncService`) — past the image-pull grace, `installing` + no
  containers + not the active pipeline holder + no registry entry → `install_failed` (instead of
  skip-forever). Live pulls keep the tracker/registry set, so slow-but-alive pulls are not killed.
- **pullImages stall/overall timeouts** — inactivity (`DEFAULT_APP_IMAGE_PULL_INACTIVITY_TIMEOUT_MS`)
  and overall (`DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES`) abort a wedged pull as a regular failure
  (not `AbortError`, which would delete the row as a user cancel).
- **Worker catch finalizes** — `invokeCommand`'s catch calls `handleFailedResult` for installs so a
  throw after the publisher RPC timed out still reaches `install_failed`.
- **Unique `(app_name, app_store_slug)`** — closes the concurrent-install race that used to insert
  two rows for the same app (duplicate tiles / "Firefly III, Firefly III" in the queue).

## Custom domains

CI-Cloud reports the customer hostnames it actually cloned into this device's tunnel ingress on
`POST /api/tunnels/state`. The Hub is a **mirror** of that array, never a re-derivation of it —
only CI-Cloud knows whether a hostname really routes here.

- `syncStateOnce` (`modules/cloudflare`) validates the wire elements and drops malformed ones.
  `undefined` (a CI-Cloud predating the field, a failed sync, or a payload nothing could parse)
  means *change nothing*; `[]` means *unbind*. Collapsing those two takes live domains off the air.
- `reconcileCustomDomains` (`modules/app-lifecycle/exposure-sync.service.ts`) joins each delivered
  `targetHostname` against the app's own platform hostname and writes `app.custom_domain`. It runs
  last in the sync and in its own try/catch, so a DB error cannot swallow the per-app DNS reporting
  above it. Apps absent from the payload (stopped, or excluded for a release pass) keep their
  binding — "not asked about" is not "unbound".
  A domain CI-Cloud reports against two targets is a rebind in flight: it is dropped from both,
  and an app already serving on it **holds** its binding rather than being unbound by the drop.
- `generateEnvFile` emits the bound hostname for `APP_PUBLIC_URL` / `APP_PUBLIC_HOSTNAME` /
  `APP_HOST` / `APP_DOMAIN` / `APP_BASE_URL`. The cloned ingress rule keeps the platform
  `httpHostHeader`, so these env vars are the **only** way an app learns the name the browser used —
  which is what OAuth `redirect_uri` is built from.
- An `app_base_url` value that is merely an auto-derived public URL follows the binding **wherever
  it arrives from**. The install dialog pre-fills these fields and the value is persisted into
  `app.config`, which every later lifecycle command replays as `form` — so a correction that only
  looked at the app's existing env would never run for a UI install.
- Two more consumers must follow the same binding, because they are what an app or a browser
  actually sees: Traefik's `X-Forwarded-Host` middleware (`commands/compose-preparation.ts` →
  `traefik-labels.builder.ts`), which frameworks that trust proxy headers use instead of the env,
  and the forward-auth host map (`modules/auth`), which the edge-SSO return URL is built from.
- Restarts are asymmetric. A **first** bind reaches a running app via `pendingRestart` + an SSE
  nudge: the app still works on its platform hostname, so a background sync has no reason to take a
  running container down for a hostname nothing depends on yet. **Losing** a bound hostname is not
  symmetric — the container keeps injecting it as `X-Forwarded-Host` until it is recreated, so the
  app is broken on the platform hostname it is supposed to fall back to — and the reconcile restarts
  it itself (CI-Hub#1207). That is narrowed three ways: only for changes CI-Cloud drove (a settings
  save owns its own restart, via `skipAutoRestartAppUrns`); not while the Hub is still asking
  CI-Cloud for that hostname (the bind pass decides, and reverts only once it gives the domain up);
  and not when the domain is still delivered against a hostname this Hub no longer composes, which
  is the Hub's own identity moving rather than a disconnect. Writes are deferred while an app is
  `starting`/`restarting`,
  because the in-command sync would otherwise be clobbered by `settleCommandOutcome` — and, because
  that status is a snapshot taken before the CI-Cloud round trip, the write itself is a
  compare-and-set on it (`updateAppByIdIfStatus`) so a command that claims the app mid-sync wins.
- Diagnostics report `action: 'ok'` **only** for the bind window itself (a custom domain bound, the
  env still on the platform hostname). `pendingRestart` alone must not suppress a verdict: it is
  raised by any settings change, and suppressing on it hides real drift from `mismatchCount` and
  from an untargeted `repair()`.

⚠ `SSEService.emit('app', data, appUrn)` publishes to topic `app:<urn>`, which **nothing
subscribes to** — the frontend opens `/api/sse/app` only. Always omit the third argument.

### Choosing one at install time

The install dialog offers the organization's connected domains (`GET /api/cloudflare/custom-domains`
→ CI-Cloud's `GET /api/custom-domains/device`). Picking one records an **intent**, not a binding.

- `app.custom_domain_intent` is the CHOICE; `app.custom_domain` is the OUTCOME. Only the second is
  ever read by env generation. The Hub cannot tell whether a hostname resolves to its own tunnel, so
  an app is never told about one on the strength of a form field.
- The two cannot happen at the same moment: CI-Cloud derives a domain's target from an `application`
  row, and at install time it has never heard of this app. So `bindCustomDomainIntents` runs after
  each successful sync — the sync is what registers the app — and asks CI-Cloud to wire it.
- End to end: pick → sync registers the app → bind → the **next** sync reports the hostname in
  `customDomains` → `reconcileCustomDomains` writes `app.custom_domain` + `pendingRestart` → the
  user's restart regenerates the env. Every step is one CI-Cloud confirmed.
- The bind names the domain id and the app's **subdomain** (the same string the tunnel-state payload
  carries), never a hostname: CI-Cloud composes the target from rows it owns, which is what stops a
  device pointing a domain into another organization's tunnel.
- An intent that equals the delivered binding costs nothing — no listing, no bind — which is the
  steady state for the life of the app. A refusal that can clear itself (app not registered yet,
  domain still verifying) keeps the intent and retries; only "that domain is not this
  organization's" clears it.
- A listing that could not be READ (older CI-Cloud, unreachable, unparseable) keeps every intent.
  `supported: false` on the Hub's own endpoint means "could not ask", which the dialog must not
  render as "you have none".

## Managed host-inference credentials

mlx-dspark and MTPLX run on the macOS host but are reached from the containerized Hub and installed
apps. Desktop FTUE writes a random key for each managed runner under
`/data/state/inference-runners/*.api-key` (the host `state/` directory is mounted at `/data/state`).
`readManagedRunnerApiKey` checks `DSPARK_API_KEY` or `MTPLX_API_KEY` first for operator-managed and
remote servers, then reads that desktop-managed key. The backend uses it for mlx-dspark admin calls
and every MTPLX request, and both `InferenceEnvResolver` and `AppCredentialsService` pass the same
credential to direct app clients. mlx-dspark `/health` remains unauthenticated by upstream design so
an empty `--no-model` server is still a valid readiness target. Never log or return these key files.

## Inference cloud providers

Settings → AI saves OpenAI / Anthropic / Google / GitHub Copilot keys to `settings.json`
(`inferenceCloudProviders`) via `POST /api/inference/cloud-providers`. They used to live only in
RAM and did not restart AI apps.

On save the Hub:

1. Persists every provider (a masked `••••` POST keeps the stored key).
2. Debounces `restartAiApps()` (1.5s) so four provider POSTs + a preferences PATCH recreate
   OpenClaw / Hermes once.
3. Injects **all** enabled providers additively. Local Ollama/vLLM stays `CI_LLM_*` /
   `OPENAI_API_*` / `CI_INFERENCE_BACKEND`. Cloud keys are `CI_CLOUD_<PROVIDER>_*` plus
   conventional aliases (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`). Cloud becomes
   the primary `CI_LLM_*` only when the local backend is down.
4. OpenClaw's entrypoint writes each Hub-managed provider into `openclaw.json`
   (`models.providers.openai|anthropic|google|github-copilot`). Schema-safe fields
   only — do not write `hubManaged` (unknown keys quarantine the whole file).

AI apps that want these tokens must read the `CI_CLOUD_*` contract (or `hub_integration.inference`
plus the extra env). See the tracking issue on marketplace / OpenClaw / Hermes.

## Family Hub auth and Memory connect

Human dashboard login (password and Portal SSO) goes through `AuthService.admitHubPerson`. Each Portal `(issuer, subject)` that is a member of the paired org gets their own Hub `user` row (`operator: true`). Device-key Bearer and CLI JWT still map to the bootstrap operator.

`memory_connection` is unique on `(app_urn, hub_user_id)`. Env generation injects the latest connected key; opening an app as a different Hub person revokes the previous Memory key and re-prompts connect. Hermes and OpenClaw declare `hub_integration.memory` so Hub can inject `CI_SERVER_URL` / `CI_SERVER_TOKEN` for the current person.

## Per-app grants

Routes that read or mutate one app assert the operator's Portal grant through
`MarketplaceWhoIsService`: `assertSessionAction` for a single app, `assertSessionActions` for a set
(one batched WhoIs round trip — asserting in a loop costs a Portal request per app), and
`filterSessionByView` to trim a list. Both asserts no-op when the request carries no Hub session, so
API-key callers such as the `cihub` CLI are unaffected.

Assert over **every** app a request could touch before touching any of them, and include apps the
caller named even when they turn out to need no work — checking only the apps that do lets an
unauthorized caller read an app's state out of the 403-vs-200 answer.

`public-web/repair` rewrites app envs and restarts apps, so it carries `configure`; `public-web/diagnostics`
filters its report by `view`.

The services check too, so HTTP is not the only transport that asks
([CI-Hub#1397](https://github.com/companionintelligence/CI-Hub/issues/1397)). These calls on one app
take a named `LifecycleActor`: install, update-config, start, stop, restart, uninstall, reset, update,
cancel, `BackupsService` backup, restore, list and delete, and the app-API proxy. `AppLifecycleService.assertActorMay`
decides from it before anything is read or queued, and refuses with `APP_ACTION_GRANT_DENIED` (403).
Not every per-app call takes one yet: `forceStopApp`, `startAppAndWait`, `restartAppAndWait`,
`regenerateAppEnv`, `BackupsService.uploadBackup` and `getBackupFilePath`, and the user-config,
custom-app and `AppsService` calls behind the per-app MCP tools assert nothing, so a route or tool
that reaches them must assert the grant itself (the MCP tools do, through `assertMcpCallerMay`).
An operator, and the creator of an unmanaged MCP key, answer to their WhoIs grant. A managed app key
passes every check on its own app except a custom-domain change, which takes an organization owner or
admin at any capability. On other apps its capability decides: `read` may view them; `write` may also
start, stop and restart them and call their tools and API; `full` may do everything (see
[MCP agent bootstrap](../MCP_AGENT_BOOTSTRAP.md)). The `mcp` actor carries the capability its key was
resolved with for this request, so a change in Settings applies from the next call.
`AppLifecycleService.actorMay` is the one place that decides this. Where the verb cannot say which call
a check is, the call site passes an `ActorCheckContext`: `appCall` for a call into the app's tools or
API, and `stopsApp` for stopping the app (cancelling its operation is `stop` too, and stays unmarked).
Leave the marker off every other call, so a `write` managed key is refused it on other apps.

When you add an MCP tool that acts on one app, pass `mcpCallerLifecycleActor(action)` to a service that
takes an actor, or call `assertMcpCallerMay` before the tool reads or changes anything. Give an internal
caller a `{ kind: 'system', reason }` actor, with a reason named in `SystemLifecycleReason`.

## API client generation

OpenAPI spec generated from NestJS decorators. Drift check: `pnpm run check:openapi`.

Frontend client: `packages/frontend/src/api-client/` (regenerate via `pnpm run gen:api-client`).

Zod-backed DTOs must also be listed in `src/swagger-zod-registry.ts` — Nest reflects the class as an
empty object, and only registered DTOs get their schema patched in. An unregistered one publishes
`{"type":"object","properties":{}}` and generates as `{ [key: string]: unknown }`.

## Agent notes

- Do not add secrets to committed `.env` files.
- New endpoints need Swagger decorators for OpenAPI drift CI.
- Hub health probe used by desktop/frontend: `/api/health/live` only (not full readiness).
