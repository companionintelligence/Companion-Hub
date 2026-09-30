# Backend system — Companion Hub

> **Purpose:** NestJS API server — app lifecycle, Docker management, auth, queues, MCP.
> **Scope:** `packages/backend/` — modules, Drizzle schema, RabbitMQ workers, SSE.
> **Key paths:** `packages/backend/src/modules/`, `packages/backend/src/database/`, `packages/backend/src/queue/`
> **Commands:** `cd packages/backend && pnpm test`, `pnpm run test:integration` (root)
> **Owner persona:** maintainability + security (see REVIEW_PERSONAS.md)
> **Last updated:** 2026-09-24 (diagnostics name the dark custom domain; the Hub applies a requested binding)
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
| `auth` | Hub sessions, 2FA, Portal SSO. Human login admits each Portal `(iss, sub)` in the paired org as their own operator — not `getFirstOperator()`. Session middleware prefers the newest of cookie vs `X-CI-Hub-Session`. Also the route guards that are not operator auth: `InternalNetworkGuard` (source address only; passes proxy traffic unless `HUB_TRUST_PROXY` is set), `ObservabilityReadGuard` (`qa:read` keys on marked GETs), `InferenceAccessGuard` (see [Inference access](#inference-access)), and `InternalOriginGuard` (the origin leg alone, no key — the app credentials handout). |
| `health` | Liveness/readiness (`/api/health/live`) |
| `sse` | Real-time status stream to frontend |
| `mcp` | MCP server tools for agent apps |
| `tailscale` / `cloudflare` | Optional sidecar integrations |
| `inference` | Backend registry, model resolution, routing to a local engine. The OpenAI-compatible `/api/inference/v1/*` routes carry `InferenceAccessGuard`; `apps/:slug/credentials*` carries `InternalOriginGuard` (origin only, no key — see [App inference handout](#app-inference-handout)). |
| `hub-pool` | Multi-Hub inference pooling: peer identity, pairing, discovery, ranking, and the proxy. The app-facing `v1/*` and `api/*` proxy routes (and the root-level `/api/version`, `/api/tags`) carry `InferenceAccessGuard`; `local/*` carries `PoolPeerGuard`. |
| `registration` | Portal pairing, device ID, and registration-state drift. `check-in-response.ts` maps Portal's check-in answers to Hub responses, and `GET /registration/phase` reports the phase and last check-in without sending one — see [`portal-check-in.md`](../portal-check-in.md). The hourly check-in also carries this Hub's own status (phase, degraded reasons, tunnel health, Tailscale connectivity, version) for Portal's org fleet report — see `check-in-payload.ts`; every field is optional and absent means "no report this time", never "the value is gone". |

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

## Model loading and eviction

`InferenceRouterService.loadTrackedModel` is the one path that puts a catalog model into memory.
The pool proxy reaches it through `prepareTrackedModel` for every app generation naming a
Hub-tracked model that the engine does not hold. `POST /api/inference/models/load` and `models/pin`
reach it, and so do MCP `hub_load_model` and `hub_pin_model`. When the model does not fit,
`MemoryManagerService.planEviction` decides what may be unloaded. Who asked decides the scope:

| Caller | Scope | May unload |
|---|---|---|
| An app's request, through the pool proxy or the router | `request` | Idle models the Hub loaded itself |
| An MCP tool called with any API key, `full` included | `request` | Idle models the Hub loaded itself |
| REST load or pin (`AuthGuard`: an operator session or a host-local credential) | `operator` | Any idle, unpinned model on any engine |
| An MCP tool run from the Hub UI's tool runner (`/api/mcp-admin`) | `operator` | Any idle, unpinned model on any engine |

Hermes' and OpenClaw's managed keys are `write` keys, so without the `request` scope an agent
could evict the model every other app on the node is serving.

Both scopes share these rules:

- **Busy models stay.** A model with a request in flight is never unloaded, whoever asks.
  `HubPoolLoadService.localBusyModelsOn` supplies the list: every generation, and every embedding
  batch (`/v1/embeddings`, `/api/embed`, `/api/embeddings`), which is recorded apart from the
  generations so the contention and throughput judgements never see it. Ollama only marks a busy
  runner to expire, so evicting it frees nothing in time and its app reloads it cold on the next
  request. Only work that passes through the pool proxy is counted. An app calling the engine
  directly, or `/api/inference/v1` on a Hub with no connected peers, is invisible to this check.
- **Candidates are sized in the budget's units.** A candidate is sized by its share of the
  figure the budget counted for its engine. With one model per engine process, that is the process
  figure. With several, the figure is split in the engine's own proportions. A Hub-tracked model
  that the engine no longer holds is not a candidate. A model that cannot be sized, or that frees
  0 MB of the pool (Ollama on CPU reports `size_vram` 0), is never unloaded.
- **Refuse without unloading where possible.** When the sized candidates cannot cover the
  shortfall, the load is refused and nothing is unloaded. The reason names any busy model.
- **After unloading, load only onto memory that is known to be free.** When the candidates can
  cover it, they are unloaded and the fit is re-measured for up to 10 s. Each attempt re-reads the
  engines and the hardware profile, with MemAvailable sampled at that moment rather than reused
  from the last 5 s, because on unified memory MemAvailable is the figure that shows the memory
  coming back. If the re-measure never catches up, the model is still loaded only when every
  evicted model was on the target's own engine and that engine arbitrates its own memory. Today
  only Ollama does: its scheduler will not load beside a runner it has marked to expire, and waits
  for that runner's request to end. Otherwise the load is refused, because an evicted model may
  still be serving work the Hub cannot see, and nothing stops a Lemonade load from landing on top
  of a busy Ollama runner, or the reverse. That was the freeze #1679 fixed. An unload the engine
  refuses stops the plan at once, so the models after it stay loaded, and the load goes ahead only
  if what was already freed shows up in the re-measure.
- **A model that is not downloaded is refused first.** The check runs before any fit check or
  eviction.
- **Loads are serialized per node.** Fit, eviction, and load run under one lock. A second load of
  the same model finds it resident, and the cached memory reading is dropped after every load. A
  model the engine already holds is answered before the lock, so a request for it never queues
  behind another model's cold load. The pool proxy passes the client's hang-up signal along, and a
  load whose client went away while it was queued is dropped before it measures, evicts or loads
  anything.
- **Pins match under `:latest`.** Pins and the model being loaded are matched with
  `sameModelId`, so a pinned `nomic-embed-text` is protected while `/api/ps` lists
  `nomic-embed-text:latest`.

A load refused on the request path is still forwarded to the engine. The pool proxy does that
regardless of the answer. A refusal there means the Hub made no room, not that the engine does not
try.

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

## Inference access

`InferenceAccessGuard` (`modules/auth/inference-access.guard.ts`) admits the inference surface — the
six `/api/inference/v1/*` routes, the app-facing pool proxy under `/api/inference/pool/*`, and the
root-level `/api/version` and `/api/tags` — by origin OR by an API key with the `inference` scope.
It replaced `InternalNetworkGuard` (and the pool's own app-origin guard) there because `request.ip`
behind Traefik or the Cloudflare tunnel is the proxy's own private address unless `HUB_TRUST_PROXY`
is set, so the source-address check alone passed public tunnel traffic with no credential.

- **Leg 1, origin.** `internalOriginRefusal` in `common/helpers/request-origin.ts` places a request
  inside the appliance when its resolved address is private, none of `TUNNEL_MARKER_HEADERS` is
  present, and every hop of `x-forwarded-for` is private. An internal request is admitted before
  `Authorization` is read, so an app sending `Bearer ollama` on every turn costs no key-store lookup.
- **Leg 2, key.** Otherwise the request needs `Authorization: Bearer <key>` where the token is
  64 lowercase hex (`HUB_API_KEY_SHAPE` in `api-key.service.ts` — the one definition `AuthMiddleware`
  screens `qa:read` tokens with too) and resolves with the `inference` scope. The guard sets
  `request.inferenceApiKey` and never `hubPrincipal` or `req.user`: the key is not an operator.
  On a GET this leg is the second lookup of the same token — `AuthMiddleware`'s `qa:read` arm ran
  first — accepted because the arm's own routes share the `/api/inference/pool/` prefix; it costs one
  indexed SELECT on the catalog reads and nothing on completions.
- **Refusals are OpenAI-shaped.** `{ error: { message, type: 'authentication_error', code } }` with
  `code` `missing_api_key` or `invalid_api_key` and a `WWW-Authenticate` header; a key-store outage
  answers 503 with `type: 'server_error'`. The guard writes the body and then throws, because
  `MainExceptionFilter` returns early once `headersSent`.

The `inference` scope is appended last in `API_KEY_SCOPES` so `normalizeScopes` keeps every stored
row's order. It is minted by the CLI only (`cihub api-key create --scope inference`, alone on its key,
stored as `read`); Settings → Security lists it under the "Inference" badge but does not mint it.
`inference-access.guard.test.ts` pins the exact guard list of every handler on `InferenceController`,
`HubPoolController` and `HubPoolOllamaCompatController`, so a new `/v1` route without a guard fails
there. Operator-facing walkthrough: [`docs/editor-inference.md`](../editor-inference.md).

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
  from an untargeted `repair()`. The question "is the customer's domain dark?" is published
  separately as `awaitingCustomDomainRestart`, so a surface can say *which* domain is dark instead of
  the generic "configuration has changed". It is **wider** than the `action` suppression, not its
  negation: it drops the `envHostname === identity.hostname` clause, so an app re-pointed from one
  bound domain to another is named as dark *and* still reported `action: 'repair'`. The UI must key
  on it rather than on `pendingRestart`.
- `repair()` restarts the app **only** when its status is `running`, `starting` or `restarting`;
  otherwise it rewrites the env and still reports `success: true`. Any UI offering a restart has to
  gate on the status too, or the click reports success without starting anything.
- The Hub applies a binding itself when CI-Cloud delivers `applyRequested: true` — see
  `ExposureSyncService.reconcileCustomDomains`. The gate is *not* `pendingRestart`: that flag is
  raised by any settings save, so `customDomainPendingApply` reads the app's compose env and acts
  only when it is still on some other hostname. Apply and revert share one dispatcher
  (`restartRevertedApps`) and one restart cooldown, but only a **revert** is remembered on failure:
  an apply is re-derived every pass from the request, the env and the app's status, so retrying it
  blind would restart an app after the operator withdrew the request or stopped it.

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
  domain still verifying) keeps the intent and retries. Two answers clear it, with its confirmation:
  "that domain is not this organization's", and "another Hub holds it" (listed `boundElsewhere` and
  not `bindable` once verified, or a bind refused with `DOMAIN_BOUND_TO_ANOTHER_DEVICE`). Only an
  owner or admin can move such a domain, from the portal's organization settings → domains, and the
  log line and the picker both say so.
- A listing that could not be READ (older CI-Cloud, unreachable, unparseable) keeps every intent.
  `supported: false` on the Hub's own endpoint means "could not ask", which the dialog must not
  render as "you have none".

## The four engines, or two endpoints

Setup offers Ollama, oMLX, vLLM, or Lemonade, and only the ones the detected machine can run. The other path is a decode endpoint and an encode endpoint. Either URL may be set alone. From inside Docker the probe uses `host.docker.internal`, and the card shows that URL.

oMLX is Apple Silicon only. Install it with `brew tap jundot/omlx https://github.com/jundot/omlx`, then `brew install jundot/omlx/omlx`, then `omlx start`. It serves chat and embeddings. vLLM is NVIDIA only. Its serve command is `vllm serve <model> --host 0.0.0.0 --port 8000`. Lemonade is AMD or NPU, operator-managed, and hidden on Mac. Ollama embeds when the chosen decoder cannot. vLLM and oMLX both default to port 8000, and `owned_by` on `/v1/models` is what tells them apart. Ollama answering is only Ollama.

## Inference cloud providers

Settings → AI saves OpenAI / Anthropic / Google / GitHub Copilot keys to `settings.json`
(`inferenceCloudProviders`) via `POST /api/inference/cloud-providers`. They used to live only in
RAM and did not restart AI apps.

On save the Hub:

1. Persists every provider (a masked `••••` POST keeps the stored key).
2. Requests an AI app refresh, which `AiAppInferenceRefreshService` debounces (1.5 s) so four
   provider POSTs + a preferences PATCH produce one sweep. See
   [App inference handout](#app-inference-handout).
3. Injects **all** enabled providers additively. Local Ollama/vLLM stays `CI_LLM_*` /
   `OPENAI_API_*` / `CI_INFERENCE_BACKEND`. Cloud keys are `CI_CLOUD_<PROVIDER>_*` plus
   conventional aliases (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`). Cloud becomes
   the primary `CI_LLM_*` only when neither the local backend nor a connected pool peer can serve
   chat.
4. OpenClaw's entrypoint writes each Hub-managed provider into `openclaw.json`
   (`models.providers.openai|anthropic|google|github-copilot`). Schema-safe fields
   only — do not write `hubManaged` (unknown keys quarantine the whole file).

AI apps that want these tokens must read the `CI_CLOUD_*` contract (or `hub_integration.inference`
plus the extra env). See the tracking issue on marketplace / OpenClaw / Hermes.

## App inference handout

Installed apps get inference config two ways, and both choose the model through the same rules:
`InferenceEnvResolver` writes it into `app.env` when the app is generated, and
`AppCredentialsService` serves it over `GET /api/inference/apps/:slug/credentials.env` (alias
`bootstrap.env`), which CI-OpenClaw, CI-Hermes and the CI-Mentra glasses bridge (slug `ci-mentra`,
keys `LLM_API_BASE`, `LLM_API_KEY`, `LLM_DEFAULT_CHAT_MODEL`, `LLM_DEFAULT_EMBEDDING_MODEL`,
`LLM_NUM_CTX`) fetch at container start.

- **App-only, by origin.** The handout routes (`credentials`, `credentials.env`, `bootstrap.env`)
  carry `InternalOriginGuard` and accept no API key. Apps fetch them container-to-container, which
  traverses no proxy, so the guard admits a request only when its resolved address is private AND
  it carries no Cloudflare tunnel marker (`cf-ray` and friends) AND every `X-Forwarded-For` hop is
  private. `InternalNetworkGuard` alone checked the address, which behind the tunnel is the proxy's
  own private one unless `HUB_TRUST_PROXY` is set, so a registered Hub answered these routes — and
  the cloud provider API key the body can carry — from the public internet through its
  `hub-public` router. A refusal is a 403 with a warn line naming the path and the reason
  (`tunnel-marker`, `forwarded-hop`, or `public-address`); an app that sees one is reaching the Hub
  through its public hostname instead of the Docker network.
- **Requirements.** `app-inference-requirements.ts` is the per-app table: Hermes needs tool calling
  and a 64000-token window, and OpenClaw and CI-Mentra need tool calling. Each is keyed under its
  bootstrap slug (`hermes-agent`, `openclaw`, `ci-mentra`) and its installed app name (`ci-hermes`,
  `ci-openclaw`, `mentra`), because
  `app.env` is generated under the installed name. A catalog model that fails them is never handed
  out. If nothing suitable is available the app gets no model and an explicit `CI_INFERENCE_ERROR`
  instead. The credentials endpoint still answers 200 in that case, because both bootstrap scripts
  `curl --fail` and keep their stale `.env` on any error. `num_ctx` and the error key are always
  listed in `X-Hub-Managed-Keys` so a stale value is stripped. The model key is listed only when the
  answer is authoritative: a model was chosen, or unsuitable ones were refused while this node's
  backend was up. A container that starts before Ollama is ready keeps its last model.
- **Pool-aware choice.** With a connected peer the app talks to the pool proxy, so the model comes
  from `selectPoolChatModel` over the pool inventory (`InferenceEndpointService.poolInventory`). The
  order is the operator's preferred model when a node serves it and it qualifies, then the best served
  catalog model that qualifies (the recommender's ranking), then a model a host-served engine (vLLM
  or oMLX) lists that the catalog has no row for. An uncatalogued Ollama
  tag is never handed out unless the operator named it, because an Ollama inventory holds every tag
  ever pulled. A model only a peer serves gets `num_ctx` 32768 (raised to the app's floor) rather than
  a value sized from this node's memory. The peer filter mirrors `PoolProxyService.usablePeers`;
  change both together.
- **Context cap.** `CI_LLM_NUM_CTX` (`HERMES_NUM_CTX`) is `min(model window, memory-sized
  recommendation, cap)`, where the cap is the node's `inferenceMaxNumCtx` setting — the operator's
  statement of the engine's own context (`OLLAMA_CONTEXT_LENGTH`) — and, for an app routed through
  the pool, the smallest cap among the nodes serving the chosen model (`poolContextCap`). Absent is
  no cap. Without it apps asked Ollama for a 65536 window on a node running four slots at 16384, and
  every request at a different size reloaded a 30B model (core-2, 2026-09-20). The cap wins over an
  app's floor, with a warning; a handout that differs from the window the local Ollama holds the
  model at (`/api/ps` `context_length`) is also logged, since it is a reload. See
  [Context caps](../hub-pool.md#context-caps-the-window-an-app-asks-for-is-the-window-the-engine-runs).
- **Pre-pull.** `decideModelPrePull` returns a logged decision for every handout. A credentials GET
  never pulls a model a pool node already serves, nor one the app's requirements rule out. When the
  pool already serves the app a suitable model, it pulls only the operator's preferred model, never
  this node's hardware recommendation in its place. `previewCredentials` resolves the same answer with
  no pull, cache, or handout record.
- **Staleness.** `GET /api/apps/:urn/inference-env` compares what an app holds with what it would be
  handed now: `app.env` against `AppHelpers.buildInferenceEnv`, and, for an app with no inference
  mapping (OpenClaw), its last fetched handout against `previewCredentials`. It reports `stale`, the
  differing key names (never values), and `routedThroughPool` / `chatModel` on both sides. A key the
  Hub leaves unset and the app's form declares is the operator's value, not compared. The last
  handout per app is kept in `state/inference-handouts.json` as SHA-256 digests of its values, so
  apps that keep running through a Hub restart are not read as stale.
- **Refresh.** `AiAppInferenceRefreshService` is the one path that restarts AI apps for inference
  changes. `PATCH /api/inference/preferences`, `POST /api/inference/cloud-providers`,
  `PATCH /api/user-settings` (when a write changes an inference or pool-switch value), and
  `PATCH /api/inference/pool/settings` (when the master or outbound switch moves) all request a
  sweep. A watcher also requests one when pool membership holds a new value for two health polls. A
  sweep restarts only stale apps. An automatic sweep also skips an app whose regeneration would
  remove its endpoint or its chat model, and restarts an app at most once per 10 minutes, checking
  again when that window ends. The Hub-upgrade sync still restarts every AI app unconditionally.

## App readiness endpoint

App status (`running`, `stopped`) is what Docker says, from `app-status-sync.service.ts`, and
readiness never changes it. An app that wants the Hub to see inside its process declares
`hub_integration.readiness` (`{ service, port, path = "/health", bearer_env? }`, CI-Hub#1556).
`AppRuntimeMonitorService` then dials `http://<service>:<port><path>` on the shared network, the
way `agent-notify` dials a wake hook, on its existing cadence and only while the app is `running`,
with a 2 s timeout and `Authorization: Bearer <value of bearer_env from the app's app.env>` when
the manifest names one. The bearer is never logged. The probe only ever dials a service declared in
the app's own installed docker-compose.json — the schema refuses hostnames, and the monitor refuses
(with `unknown` and one warning) a name the compose does not declare — so `bearer_env` can only
reach the app's own containers, never another app, the host, or the internet.

`app-readiness.helpers.ts` normalises the body into `AppRuntimeHealthDto.readiness`:
`status` (`ok` | `degraded` | `unknown`), `checks[name].{status, detail?}`, `busy`, `drainable`,
`sampledAt`. It reads Hermes's `/health/detailed` layout (`readiness.checks`, `gateway_busy`,
`gateway_drainable`); a body with no `readiness` block is `ok` only from a top-level
`status: "ok"`. A probe that times out, answers non-2xx, or returns an unreadable body is `unknown`,
never `degraded`. `readiness` is `null` when the app declares no endpoint or is not running. The
app detail page shows a pill beside the Memory badge and, when checks fail, lists them by name
with the app's `detail` (`app-readiness.tsx`).

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
