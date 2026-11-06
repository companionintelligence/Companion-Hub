# Backend system — Companion Hub

> **Purpose:** NestJS API server — app lifecycle, Docker management, auth, queues, MCP.
> **Scope:** `packages/backend/` — modules, Drizzle schema, RabbitMQ workers, SSE.
> **Key paths:** `packages/backend/src/modules/`, `packages/backend/src/database/`, `packages/backend/src/queue/`
> **Commands:** `cd packages/backend && pnpm test`, `pnpm run test:integration` (root)
> **Owner persona:** maintainability + security (see REVIEW_PERSONAS.md)
> **Last updated:** 2026-11-05 (sign in with a DID, off unless `CI_HUB_DID_AUTH=true`; earlier: uninstall removes only the images an app pulled; reset and uninstall reach the `_user` store; backup archives are owner-only)
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
| `auth` | Hub sessions, 2FA, Portal SSO. Human login admits each Portal `(iss, sub)` in the paired org as their own operator — not `getFirstOperator()`. Session middleware prefers the newest of cookie vs `X-CI-Hub-Session`. Forward auth (`GET /api/auth/traefik`) signs the username and the person's stable id, which is the issuer and the id with nothing derived from them; the AID header names (`X-CI-Hub-User-AID`, `X-CI-Hub-AID`, `X-CI-Hub-KEL-Digest`) are reserved and never set, and on a route that uses the `ci-hub` forward-auth middleware the current header list makes Traefik delete a visitor's copy (not exercised against a running Traefik). The in-tree KERI module in `packages/common/src/keri` is frozen and not interoperable (see its `FROZEN.md`); `scripts/__tests__/keri-import-guard.test.ts` keeps production code from importing it. Also the route guards that are not operator auth: `InternalNetworkGuard` (source address only; passes proxy traffic unless `HUB_TRUST_PROXY` is set), `ObservabilityReadGuard` (`qa:read` keys on marked GETs), `InferenceAccessGuard` (see [Inference access](#inference-access)), and `InternalOriginGuard` (the origin leg alone, no key — the app credentials handout). Optional sign-in with a DID (`did-auth.service.ts`), absent unless `CI_HUB_DID_AUTH=true`: see [Sign in with a DID](#sign-in-with-a-did). |
| `health` | Liveness/readiness (`/api/health/live`) |
| `sse` | Real-time status stream to frontend |
| `mcp` | MCP server tools for agent apps |
| `tailscale` / `cloudflare` | Optional sidecar integrations |
| `inference` | Backend registry, model resolution, routing to a local engine. The OpenAI-compatible `/api/inference/v1/*` routes carry `InferenceAccessGuard`; `apps/:slug/credentials*` carries `InternalOriginGuard` (origin only, no key — see [App inference handout](#app-inference-handout)). |
| `hub-pool` | Multi-Hub inference pooling: peer identity, pairing, discovery, ranking, and the proxy. The app-facing `v1/*` and `api/*` proxy routes (and the root-level `/api/version`, `/api/tags`) carry `InferenceAccessGuard`; `local/*` carries `PoolPeerGuard`. |
| `registration` | Portal pairing, device ID, and registration-state drift. `check-in-response.ts` maps Portal's check-in answers to Hub responses, and `GET /registration/phase` reports the phase and last check-in without sending one — see [`portal-check-in.md`](../portal-check-in.md). The check-in also carries this Hub's own status (phase, degraded reasons, tunnel health, Tailscale connectivity, version) for Portal's org fleet report — see `check-in-payload.ts`; every field is optional and absent means "no report this time", never "the value is gone". |

## App volumes

`DockerComposeBuilder` renders each manifest volume as either a host bind mount (`hostPath`) or a
docker-managed named volume (`volumeName`), never both. Compose scopes named volumes to the app's
project, so `db` becomes `<app>_<store>_db`, and the existing lifecycle commands already reclaim
them — `down --volumes` on uninstall-with-data and reset, preserved on stop/restart/update.

Uninstall removes only the images the Hub pulled for the app. An install, an update, a start or a restart records the IDs of the images it brought onto the computer in `<dataDir>/state/pulled-images/<store>/<app>.json`, with the tags they arrived with. A start and a restart count for the same reason: `compose up` pulls whatever isn't here. That is where a custom app gets its images. The record sits in `state/` because a packaged Hub mounts only the folders under `/data`, so it can be written there and a Hub update keeps it. An image that was already there, under any name, is never recorded: when a reference names nothing or a pull is forced, the Hub also lists the image IDs here before the pull, so an ordinary start doesn't pay for that. Only a new image gets its tags recorded. Two apps can share an image and the second one to start doesn't record it until the first one goes.

Four things keep a recorded image on the computer. Docker refuses one a container uses, running or stopped, since removal is never forced. Docker also refuses one with two tags. It doesn't refuse one with a single tag, so the Hub keeps an image with a tag it didn't arrive with: store apps pin `name:tag@digest`, which leaves no tag. `docker pull name:tag` by hand afterwards gives it one. And the Hub keeps an image another installed app names, because a stopped app has no containers to hold it. If it can't read the compose of another app, or that app has none, every image stays. An image named only in a person's own compose override isn't seen by this check. Images go whether or not Delete all data is on, since they aren't the app's data. Compose removes only the images it built (`--rmi local`). An app installed before this record existed has none, so its pulled images stay on the computer after uninstall.

An image kept because another app names it moves to that app's record, so it goes when the last app using it goes, along apps A, B and C in whatever order they leave. It takes the tags it has now that the old record holds. Any other tag could be a person's, so it stays off the new record and the image then stays when the last app goes. That also covers an app that names a tag while the first pinned the digest: nothing shows whether its pull or a person gave the image that tag. The new record is written before the old one goes. If it can't be written, or the image's tags can't be read, the image stays on the computer and on the old record, which then holds only those images. Uninstall reads the record and checks the other apps after `compose down`, since an install or another uninstall in that time changes the answer. Uninstalls run side by side, so two at once can leave a shared image behind when each sees the other still installed. They can't remove it while an app that stays names it.

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

The same answer turns off the `a+rwx` sweep `AppFilesManager.setAppDataDirPermissions` runs over an
app's data folder each time a lifecycle command prepares the app (a restart does it twice). The
mount sets every mode there (0777 for every uid on a default WSL2 drive), so the sweep has nothing to
grant, and walking a big tree over 9p (OpenClaw's has over 13,000 files) took minutes on every
restart. The one thing a chmod still does on drvfs is set or clear the Windows read-only attribute,
which shows as a file with no write bits. The sweep used to clear it on every prepare; now a file a
container makes read-only stays read-only, to root as well, until something chmods it back.

Backups carry the named volumes. `BackupManager` asks Docker for the volumes compose created for
the app's project and puts each in the archive as `volumes/<key>.tar`, next to `app-data`, `app`
and `user-config`. A restore checks that every volume can go back, and reads each archive through
with `tar -tf -`, before it replaces any file, then empties the app's volume with that key and
unpacks the archive into it. The check reads from stdin because busybox, handed a file by name,
seeks over each entry and takes an archive cut short inside one for a complete one. When a reset
removed the volume, the restore creates it with compose's project and volume labels, so `up` adopts it.
`AppVolumeArchiveService` does the copying with busybox `tar` in a short-lived container of the
Hub's own image (the image ID of the container it runs in), as root, with no network and no log
driver, so nothing is pulled and the stream is not also written to a container log. A backup or
restore stops the app first and carries on if that stop fails, so the service refuses a volume
that a running container still has mounted: a database copied mid-write may not start from the
copy, and one emptied under a running server is lost. An app without
named volumes gets the same archive as before, and restoring a backup without a `volumes` folder
does not ask Docker anything. A backup made where the database is in a volume and restored where it
is a folder (Windows to Linux) still comes back without it, because nothing maps a volume key back
to a path.

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
backends (`ollama`, `vllm`, `lemonade`, `omlx`, `localai`) in `INFERENCE_BACKEND_TYPES` order.

It replaced five byte-identical private `getBackend` switches in `model-puller`,
`inference-env-resolver`, `inference-router`, `app-credentials`, and the controller. Two details are
deliberate and easy to undo by accident:

- The map is a `Record` keyed by the union, not a `Map`. A missing backend is then a build error,
  and unlike an index signature it is not widened to `| undefined` by `noUncheckedIndexedAccess`.
- The backend classes are **value** imports, not `import type`. Nest resolves constructor
  parameters through `emitDecoratorMetadata`'s `design:paramtypes`, so a type-only import erases them
  to `undefined` at runtime with no compile error — and Biome's `useImportType` is off for this
  package, so nothing would flag it.
- `localai` (`LocalAiBackend`) provides OpenAI-compatible inference, audio (TTS/STT), and image generation (`POST /v1/images/generations`). Active image/media tasks acquire a slot via `HubPoolLoadService.acquireMedia()`, reflecting host GPU occupancy in pool queue depth.

`entries()` yields the type as the string from the source tuple rather than reading `backend.type`
off the instance, because test doubles are mock proxies whose `type` is undefined.

## Model loading and eviction

`InferenceRouterService.loadTrackedModel` is the one path that puts a catalog model into memory.
The pool proxy calls it (`PoolProxyService.arbitrateLocalLoad`) for every app generation bound for
this node's engine that names a Hub-tracked model the registry has as downloaded but not loaded. It
finds the model the way `prepareTrackedModel` does, but does not go through that method, which
answers "not tracked" and "refused" with the same `null` and drops the reason.
`POST /api/inference/models/load` and MCP `hub_load_model` reach it directly; `models/pin` and MCP
`hub_pin_model` reach it through `pinTrackedModel`. Every caller states its origin (`LoadOrigin`);
there is no default. The origin decides both the window the model is loaded at (see
[Model loads](#model-loads)) and the scope `MemoryManagerService.planEviction` uses when the model
does not fit:

| Caller | Origin | Scope | May unload |
|---|---|---|---|
| An app's request, through the pool proxy or the router | `request` | `request` | Idle models the Hub loaded itself |
| An MCP tool called with any API key, `full` included | `agent` | `request` | Idle models the Hub loaded itself |
| REST load or pin (`AuthGuard`: an operator session or a host-local credential) | `operator` | `operator` | Any idle, unpinned model on any engine |
| An MCP tool run from the Hub UI's tool runner (`/api/mcp-admin`) | `operator` | `operator` | Any idle, unpinned model on any engine |

Window and scope used to be two separate options with opposite defaults: a call that named neither
planned its window as an operator's load and evicted as an app's request. The pin made exactly that
call, so a REST pin could no longer clear an idle model an app loaded, while a REST load could.

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
  eviction. Once Ollama answers, its own list decides, so a model removed with `ollama rm` is refused
  here even while the registry still has it as pulled.
- **Loads are serialized per node.** Fit, eviction, and load run under one lock, and so do a
  never-measured model's trial load and the measurement after it. A pin holds the lock from its
  budget check to the pin itself: between the load and the pin the model is an idle Hub load, which
  a queued request's load could otherwise evict before it is pinned. A second load of the same model
  finds it resident, and the cached memory reading is dropped after every load. A model the engine
  already holds is answered before the lock, so a request for it never queues behind another model's
  cold load. The pool proxy passes the client's hang-up signal along, and a load whose client went
  away while it was queued is dropped before it measures, evicts or loads anything.
- **Pins match however the engine spells the model.** Residents are matched to the registry, the
  catalog, pins, busy work and the model being loaded with `engineModelKey`
  (`model-availability.util.ts`). It folds Ollama's `name` ≡ `name:latest` on every engine, so a
  pinned `nomic-embed-text` is protected while `/api/ps` lists `nomic-embed-text:latest`. On Lemonade
  it also folds the `user.` namespace: 10.2.0 lists the embedder the Hub registers as
  `user.nomic-embed-text-v1.5-GGUF`, and before this an operator's load could unload that embedder
  while it was pinned. Footprint sightings are keyed the same way.
- **Pins survive a Hub restart.** The registry writes the pinned catalog ids to
  `<data dir>/state/inference-pinned-models.json` and reads them back before anything is tracked
  (`onModuleInit`). A state file rather than `settings.json`, because an older build that saves
  settings drops keys it does not declare. At boot, `InferenceRouterService.readoptPinnedModels`
  marks as pinned each pinned model an engine still holds (Ollama keeps it at `keep_alive: -1`),
  in the background so boot does not wait on an engine probe. Until then, and whenever the probe
  missed it, `planEviction` still skips a resident model whose catalog row is pinned. A pinned model
  that no engine holds any more keeps its pin, and is tracked pinned the next time the Hub tracks or
  loads it. Before this, the first operator load after a restart that needed room could unload the
  pinned embedder (PIN-2 in the #1679 audit).
- **A pinned model reads `pinned` whenever it is in memory.** The registry records `loaded` as
  `pinned` for a pinned model. A request queued behind the pin of the same model, or a REST load of a
  pinned model that is already resident, used to show it as `loaded` in the Hub UI although it stayed
  pinned. An unload leaves it `pulled` and still pinned; only an unpin removes the pin.

A load refused on the request path fails over. While another candidate can take the request (a
peer, or another local engine), the pool proxy passes this node's engine over, and the routing row
records it in `attempts` as `local load refused: <reason>`. The engine is not asked, because it
would load the model on its own terms, beside what the Hub has just declined to unload, and
overcommit the card or put part of the model in system memory. When no other candidate is left,
either from the start or because every other candidate failed, the request goes to the engine
anyway, as it did before. The row then carries the reason in `localLoadRefused`, and a warning is
logged. A refusal for a model the Hub tracks on a different local engine does not pass over this
one. A load is not needed for a model the registry has as loaded or pinned, or one it does not
track, and nothing changes for those.

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
  The tailnet (100.64.0.0/10, `fd7a:115c:a1e0::/48`) counts as private, so a tailnet caller is admitted
  here by default. With `HUB_INFERENCE_TAILNET_AUTH=require-key` the guard passes
  `{ tailnetIsOutside: true }` and `internalOriginRefusal` answers `tailnet-address` for a resolved
  address or forwarded hop on the tailnet, which sends the caller to leg 2. Only this guard asks; the
  app-only guards (`InternalOriginGuard`, `AppContainerOriginGuard`) and Portal SSO keep the default.
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

An install's progress ticks (`status_change` with `progress`) carry `downloadedBytes` and
`totalBytes` once Docker has reported layer sizes. `SSEService` keeps the latest tick of each
install still running and sends it to every new `app` subscriber after the hello, so a page opened
mid-install shows where the download is instead of waiting for the next tick. `pullImages` logs
when each image's pull starts, its first event from Docker, and every 30 seconds where the layers
are.

A start, restart or install can move an app off a host port another program holds. With no page
connected, `SSEService` keeps the move and sends it to each new `app` subscriber as
`host_port_moved`, until one connection has stayed up for five seconds. A tab that reloads on the
hello doesn't use it up. It is kept in memory, one entry per app, so a Hub restart loses it. The
Hub's log keeps the move.

What cancelling an install (`AppLifecycleService.cancelOperation`) does depends on how far it got:

- `installApp` registers the operation only after the Portal bundle download and the image
  architecture check. A cancel during those checks is held in `AppOperationRegistry`
  (`holdPreparingCancel`), and `installApp` stops before it queues anything and sends
  `install_cancelled`. A fresh install's row goes if it had written one. A retry of a failed
  install stays `install_failed`, since nothing cleaned up after the failed attempt and its row is
  what **Remove** works through. Reinstalling an app that is already installed restarts it and
  can't be cancelled: its window ends once `installApp` has read the row, and a cancel held before
  that is dropped.
- A queued install's cancel is settled at once. The row is deleted, `install_cancelled` and the
  install queue go out, and the worker skips the message when it reaches it
  (`takeSettledBeforeStart`), even if the app has been installed again since.
- A running install's abort reaches the pull or `compose up`, and the worker compensates and sends
  `install_cancelled`. From `finalizing` on, the cancel is refused.

## One lifecycle operation per app

Every lifecycle command (install, start, stop, restart, update, uninstall, reset, backup and
restore) claims its app in `AppOperationRegistry` right after its grant check
(`AppLifecycleService.withOperationClaim`) in one synchronous step. `register` takes the claim over
once the command is queued. While another command holds the app, a new one is refused with a
409 that names what holds it (`APP_ERROR_UNINSTALL_IN_PROGRESS`, `APP_ERROR_UPDATE_IN_PROGRESS` and
the rest) before it reads or writes the row. An entry older than `operationStaleAfterMs`, the window
the status sync also uses, no longer holds the app. A force stop registers over a live entry
without dropping another command's claim. It still takes the per-app lock first, so it waits behind a
command that holds it.

The restarts the Hub owes an app after a settings save or a device key change
(`RESTARTS_THAT_WAIT_FOR_THE_APP`) wait for the operation holding the app instead of taking its 409,
and leave alone an app that operation left stopped. A credential change (a Hub access rotate, a
Memory connect, disconnect or key rotation) holds the app first through
`AppLifecycleService.withAppHeld`, so it is refused before anything is revoked and its restart runs
under the same claim. The Memory connect callback, the key rotation sweep and the Memory status
poll use `withAppHeldUnlessBusy`: the callback lands on `/?memoryConnect=busy&app=<urn>` and the
other two try a busy app again on their next round. In `MemoryConnectService` the order is always
the grant and an ownership read, then the app's hold, then the connection lock for the revoke and
the rows, then the restart after the lock. Nothing waits for the app while holding that lock.

`installApp` checks the grant first, then refuses a second install call for the same app
(`beginInstallCall`), then reads the row. A row left `installing` with no operation under way is
retried like a failed install; a row left `uninstalling` is refused. It claims the app right before
it writes anything. `GET /api/apps/:urn` reports the operation under way in `operation`, an install
still in its checks included. The `operation_change` event carries it to every open page.

Before it registers, an install runs the bundle download and the image architecture check side by
side. The check starts on the compose the store already holds and runs again only when the
downloaded compose names other images. Each image's registry is asked at once. One
`[install] <urn> took N ms (grant ..., bundle ..., architecture ...)` line per install call says how
long each check took.

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
  (not `AbortError`, which would delete the row as a user cancel). An image whose pull gets no event
  at all fails sooner, after `DEFAULT_APP_IMAGE_PULL_FIRST_EVENT_TIMEOUT_MS`, with a message that
  says its download hasn't started.
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
  above it. Apps absent from the payload (still installing, a failed install or excluded for a
  release pass) keep their binding: "not asked about" is not "unbound". A stopped app is in the
  payload (`CLOUDFLARE_PUBLISHED_STATUSES`), so its binding follows what CI-Cloud delivers.
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

## settings.json writes

`state/settings.json` holds the user settings and the Hub's credentials: the Portal device key, the
host-local key, and stored cloud provider keys. Every write in the Hub process takes its turn in one
queue, `inSettingsFileTurn` in `configuration.service.ts`. `mergeSettingsToDisk` reads, merges, and
writes inside a turn, and so does the factory reset's `{}`. Two saves that overlapped used to drop
each other's keys, or leave the file as one object followed by the end of a longer one.

A write goes to `settings.json.<pid>-<n>.tmp` beside the file, is flushed to disk, and is renamed over
it, so a crash, a power cut or a full disk leaves the old file or the new one. The rename needs write
access to `state/` itself.
`POST /api/inference/cloud-providers` answers once the provider is on disk, so the preferences save
that Settings > AI sends next can't overlap it.

At boot, `generateSystemEnvFile` drops a byte order mark from the start of `settings.json`, which
Notepad's "UTF-8 with BOM" and PowerShell 5 add, and writes the file back without it. It copies a
`settings.json` that still doesn't parse to `settings.json.corrupt-<time>` and replaces it. If the
file opens with a complete JSON object, which is what overlapping saves in older builds left, the Hub
keeps that object. Anything else becomes `{}`. Either way, an `"allowErrorMonitoring": false` left in
the lost part is kept, so error reporting stays off. When the copy can't be written, the file stays
as it is and the Hub boots on what it recovered. The log names the copy and the parse position, never
the content. A factory reset deletes the copies and any temporary file a crash left, since they hold
the same credentials.

On a Windows data folder (a bind mount through WSL), a read from outside the queue that overlaps the
rename can get `ENOENT` for a file that is there. Once `readUserConsentFrom` has read the file, it
counts a missing file as unreadable, so error reporting stays off for a user who turned it off.

## Factory reset data folders

`FactoryResetService.wipeDataMounts` empties `/app-data`, `/data/apps`, `/data/repos`, `/data/backups`
and `/data/user-config` entry by entry and keeps each folder: they are bind mounts, and removing a
mount point fails with `EBUSY` before anything inside it goes. It leaves `/data/media` alone, because
that is the user's media library (the books, films, music and downloads media apps share), and
`cihub reset` still deletes it with the rest of the data folder.

Before it empties a folder it reads `/proc/self/mountinfo` (`common/helpers/mount-source.ts`). The
compose files mount `<ROOT_FOLDER_HOST>/<name>` at each of them, and when that host folder is a
symlink, or a junction on Windows, Docker mounts the link's target, so the mount's root names the
target. A root whose last folder has another name than `<name>` (letter case aside) is a folder
outside the Hub's data folder, and the reset leaves it alone and names it with the files it could
not delete. Everything else is emptied as before: no mount of its own at that path (one volume for
all of `/data`, or a backend run outside a container), no readable mountinfo, the root of a whole
filesystem, or a Docker or Podman volume (`.../volumes/<name>/_data`). A link to a folder with the
same name looks like the folder itself and is emptied, unless `mountedFromFolder` (below) places
that folder in a home folder, as with `~/repos`. The reset leaves that one alone and names it too.

If anything is left or left alone, the reset throws `SETTINGS_FACTORY_RESET_FILES_LEFT` before it
wipes the database, so the operator can still sign in. Each app it tore down has already lost its
row by then, as an ordinary uninstall does.

Before it tears down a single app, the reset refuses to run when the data folder is the top of a
disk or a home folder, where it would empty `~/repos` and the rest. The container sees neither that
folder nor the host's home, so `common/helpers/home-folder.ts` goes by the shape of the path:
`/root`, `/home/<name>`, `/var/home/<name>`, `/Users/<name>`, `<drive>:\Users\<name>`,
`/mnt/<drive>/Users/<name>`, and `/<drive>/Users/<name>`, in any letter case. The top of a disk is
`/`, or drive C as `C:\`, `/mnt/c`, or `/c`. Drive C holds Windows and its users' folders, while the
top of another drive may be a disk given to the Hub. It checks `ROOT_FOLDER_HOST`, and the folder
the data folders are mounted from when mountinfo shows them all in one (`mountedDataRoot`), which is
where a `ROOT_FOLDER_HOST` that is a link to a home folder shows. It throws
`SETTINGS_FACTORY_RESET_DATA_ROOT_REFUSED` with the folder it refused. `cihub reset` runs on the host
and checks real paths instead.

A mount's root is a path inside its filesystem, so `mountedFromFolder` reads it by the filesystem.
Through drvfs it is a path on the drive the mount names: `D:\home\hub` reads `/home/hub`, and is
named `D:\home\hub`, which is no home folder. With Docker Desktop on macOS it is the Mac's path, or
with VirtioFS a path in the shared `/Users`. On a Linux disk it lacks the disk's mount point
(`/data/home/hub` on a disk mounted at `/data` reads `/home/hub`), so a folder that
`ROOT_FOLDER_HOST` ends in is taken to be `ROOT_FOLDER_HOST` itself. On any other filesystem, such
as a network share, it gives no answer.

Once settings.json is `{}`, the reset also drops what the running Hub still holds from it:
`CloudFallbackService.forgetProviders()` empties the cloud provider keys, and
`ConfigurationService.forgetPersistedUserSettings()` puts the inference, Hub Pool, and app resource
settings in `userSettings` back to what boot makes of an empty file. Without that, apps were handed
the old keys until a restart, and the next provider saved wrote them all back to the file. The
General settings keep their old values until the Hub restarts: boot resolved them into the process
environment (`generateSystemEnvFile`), and nothing kept the environment as it was before that.

The file is not quite empty: `resetSettings` writes a new `hubLocalKey` into it in the same settings
turn and the running Hub switches to that key, so the old one is refused at once.
`forgetPersistedUserSettings` also sets `ciHubApiKey`, `ciHubMoveKey` and `ciHubOrganizationId` in
the running config to null, so the reset Hub stops calling Portal as its old device and its next
pairing sends no device key or move key.

`wipeDatabase` truncates every table in `schema.ts` (`FACTORY_RESET_TABLES`, which a test keeps
complete) and then forgets the caches over them: the stable ids forward auth signs
(`ForwardAuthIdentityResolver.forget()`), the Hub Pool identity and any pairing PIN. After the
settings, `InferenceRouterService.forgetPinnedModels()` (through `ModelRegistryService.forgetPins()`)
and `AppCredentialsService.forgetHandouts()` remove `state/inference-pinned-models.json` and
`state/inference-handouts.json` with their copies in memory. `forgetPinnedModels` then takes the
load lock so a load under way ends first. It unloads each unpinned model its engine holds, along with
the model of each pin still under way. The Hub loads at `keep_alive: -1`, so the engine would hold it
for good. It asks the engine only at the address the Hub is configured with
(`residentAtConfiguredEndpoint`, `unloadAtConfiguredEndpoint`): a fallback address can be another
Ollama on the host. When that address does not answer, nothing is unloaded. A model counts as held
only under its own name or `<name>:latest`, not by the prefix `isModelLoaded` accepts, since an
unload naming a model that is not in memory can make Ollama load it. A pin still
waiting or loading when the reset runs is refused once its load ends
(`ModelRegistryService.currentPinGeneration()`), so it does not pin the old Hub's model again.
`clearOldHubRequests` removes `state/password-change-request` and `state/pairing-app-check.json`
and drops the backoff of that apps check (`PairingAppRestoreService.forget()`).
`AppFilesManager.deleteAllPulledImages()` removes `state/pulled-images`, which the uninstalls before
it have mostly emptied: a record left behind would claim images for an app of the same name on the next Hub.
`state/inference-footprint-sightings.json` and `state/tailscale-serve-ownership.json` stay: one
describes this hardware and the other names the Tailscale Serve listeners this Hub published.

The truncate takes `app_store` too, so the stores a person added go for good. Only boot writes the
CI Marketplace row (`AppStoreService.registerCloudAppStore`), so `restoreCloudAppStore` writes it
again right after the reset and rebuilds the marketplace from the table. The catalog it downloads
then (`pullRepositories`, in the background as at boot) is what the restore after the next pairing
installs from. A full download writes the folder of every app Portal lists, a dozen at a time, so a
pairing soon after the reset can meet it half done. Read half done, the catalog lacked the apps the
download had not reached, the restore skipped them as unlisted and the next sync released them. So the
restore waits up to a minute for a download under way to end (`ReposHelpers.waitForCatalogDownloads`)
before it reads the catalog. One still running then holds the apps check, which asks again 5 s later
without backing off. `PairingAppRestoreService.forget()` also drops the cooldown of its own
catalog download, which would otherwise keep a pairing within ten minutes of the last one from
downloading the catalog the reset emptied.

## The four engines, or two endpoints

Setup offers Ollama, oMLX, vLLM, or Lemonade, and only the ones the detected machine can run. The other path is a decode endpoint and an encode endpoint. Either URL may be set alone. From inside Docker the probe uses `host.docker.internal`, and the card shows that URL.

oMLX is Apple Silicon only. Install it with `brew tap jundot/omlx https://github.com/jundot/omlx`, then `brew install jundot/omlx/omlx`, then `omlx start`. It serves chat and embeddings. vLLM is NVIDIA only. Its serve command is `vllm serve <model> --host 0.0.0.0 --port 8000`. Lemonade is AMD or NPU, operator-managed, and hidden on Mac. An engine embeds for itself when the catalog gives it an embedder (Ollama, Lemonade); one that has none (vLLM, oMLX) borrows a healthy Ollama. vLLM and oMLX both default to port 8000, and `owned_by` on `/v1/models` is what tells them apart. Ollama answering is only Ollama.

Lemonade's model registry depends on its version, so the Hub reads it: each health probe (at most once a minute) fetches `GET /v1/models?show_all=true`, and a catalog Lemonade row that listing does not name is not offered, recommended, or pre-pulled, and a pull of it is refused with that reason. A Lemonade that ignores `show_all` filters nothing. Lemonade 10.x lists a model the Hub registered (the v1.5 embedder) only as `user.<id>`; the Hub counts that spelling as installed and hands it out. See [`MODEL_REGISTRY.md`](../MODEL_REGISTRY.md#lemonade-rows).

`GET /api/inference/lemonade/status` says how the probe failed (`failureMode`: `refused`, `filtered`, `dns`, `auth` for a 401 or 403, or `none`), the host platform, whether the Hub holds `LEMONADE_API_KEY`, and `firewallCommands` for the host's firewall, which admit both the Hub's network and the app subnet (`10.128.0.0/9`) to Lemonade's port. The setup card shows the rebind to `0.0.0.0` only for a refused or unclassified probe on Linux, and always with an API-key step, because the bind alone leaves Lemonade open to the network with no authentication.

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

`GET /api/inference/cloud-providers` and the MCP tool `hub_get_cloud_providers` report `configured`
in place of a key. They report a provider's `baseUrl` only when that names another server than the
provider's own, and then only its address and path. Nothing written before the host or after the
path is shown, since a secret can sit there. Only the POST and the MCP tool
`hub_set_cloud_provider` can set one, since Settings > AI sends no URL. Settings shows that URL on
the provider's card, because a key entered there goes to it. It also lists such a provider when it
holds no key, with **Remove** to delete its settings, URL included.

A blank key in the POST keeps the stored one, so a key is removed with
`DELETE /api/inference/cloud-providers/:provider`. It forgets the provider, key included, in memory
and in `settings.json`, and requests the same AI app refresh as a save. Settings > AI calls it on
save for a provider whose stored key was cleared, by hand or with its **Remove** button. The card
shows **On** or **Off** for a provider that holds a key.

A stored key belongs to the server it was saved for, as the vLLM key does. A POST, or a call to the
MCP tool `hub_set_cloud_provider`, whose `baseUrl` names another server drops the stored key unless
it sends a new one. The provider then reads as not configured until it gets a key for that server.
The Hub logs `Dropped the stored <provider> key` when that happens, since the save still answers
success.

A save with a `provider` other than those four, or with a field of the wrong type, is refused: the
POST answers 400 and the MCP tool returns an error. `apiKey`, `baseUrl` and `defaultModel` are
strings and `enabled` is a boolean. A save that leaves `enabled` out keeps the stored value.

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
- **Memory sizing.** The memory-sized recommendation uses the same inputs and budget as a
  [model load](#model-loads): the model budget with nothing loaded (`modelMemoryCeilingMb`: the card
  less its 512 MB display reserve, or live MemAvailable less 2048 MB on unified memory), not the whole
  card. On a node with several AMD cards (counted from sysfs; a card under half the largest is an iGPU
  carve-out and not counted) that is every card's memory less a reserve each, since Ollama spreads a
  model over them and the per-process VRAM the budget measures is summed over them: beta-1's two 7900 XTX
  are 48,096 MB for models, not 24,048. The sum assumes the engine may use every card. Nothing detects an
  engine pinned to one (`ROCR_VISIBLE_DEVICES`, `HIP_VISIBLE_DEVICES`) or one that cannot split (vLLM
  without tensor parallel); on such a node a model larger than one card is admitted and handed windows
  sized for the pool. The catalog tiers and filters still count one card, so the dashboard and the router
  disagree on a multi-card node. The KV cache is charged per Ollama slot, and a model this node has
  measured replaces the catalog footprint. A handout for a Lemonade model is never above the `ctx_size` Lemonade serves it
  at (`servedContextLength`). When that window is below the handout, the Hub hands out the saved
  window and logs a warning, naming the app's floor when it is under it.
- **Installed means on disk.** Once Ollama answers, its `/api/tags` list decides whether an Ollama
  model is installed. The registry's record of a pull counts only while Ollama cannot be asked: the
  record is in memory, and nothing dropped it when a model was removed with `ollama rm`, so apps were
  handed that model until the Hub restarted (`trackedPullCounts`). The handout, the app env, the pull
  check, the onboarding profile and the load path's not-downloaded check all apply this rule, and
  `GET /api/inference/models/tracked` drops a `pulled` entry that Ollama no longer lists. Lemonade,
  vLLM and oMLX keep the old rule.
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
  changes. `PATCH /api/inference/preferences`, `POST` and `DELETE /api/inference/cloud-providers`,
  `PATCH /api/user-settings` (when a write changes an inference or pool-switch value), and
  `PATCH /api/inference/pool/settings` (when the master or outbound switch moves) all request a
  sweep. A watcher also requests one when pool membership holds a new value for two health polls. A
  sweep restarts only stale apps. An automatic sweep also skips an app whose regeneration would
  remove its endpoint or its chat model, and restarts an app at most once per 10 minutes, checking
  again when that window ends. The Hub-upgrade sync still restarts every AI app unconditionally.
  An operator's sweep also restarts OpenClaw when its env is current but its model picker holds a
  downloaded model (`ollama/<tag>` in `/data/.openclaw/openclaw.json`), so OpenClaw's reconciler
  puts it back on Hub Auto. The Hub reads that file out of the running container through Docker's
  archive API, since where `/data` is a named volume (see [App volumes](#app-volumes)) the app-data
  folder never gets it. A stopped container or a missing file means there is no pick to take back.
  Any other failed read restarts OpenClaw too, as a failed staleness check restarts an app on an
  operator's sweep, and the log line says the picker could not be checked. An automatic sweep never
  reads the picker.

## Model loads

An operator's or an agent's pin or load (`POST /api/inference/models/pin`, `POST
/api/inference/models/load`, MCP `hub_load_model` and `hub_pin_model`) and a pool request for a
tracked model that is not resident all go through `InferenceRouterService.loadTrackedModel`.
`planLoad` picks the context window and the footprint that the fit check and any eviction are sized
to. The load's origin decides whose window it is, as below, and what may be unloaded for it, as in
[Model loading and eviction](#model-loading-and-eviction).

- **One budget.** The window is sized against the budget the fit check applies: `modelMemoryCeilingMb`
  with nothing loaded, and `MemoryManagerService.loadHeadroomMb` for what is free now. Sizing against
  the whole card refused qwen3.8:27b on an empty 24 GB RX 7900 XTX: 32768 tokens cost 24,371 MB
  against a 24,048 MB budget.
- **Step-down before eviction.** The Hub wants the window it hands its apps, then halves it (65536,
  32768, down to 4096) to the largest that fits what is free now. It evicts only when not even 4096
  fits, and then sizes for the largest window an empty card holds.
- **Measurements over the catalog.** `MemoryManagerService` records what each model was measured
  occupying at its window. It takes the engine's process figure from nvidia-smi or rocm-smi, split
  between models in the engine's own proportions, or else the engine's own figure. On a discrete card
  it records only a model that was wholly on the GPU. That measurement replaces the catalog footprint
  in the estimate and in `canPinModel`. gemma4:e4b's catalog row says 10,813 MB, and beta-red's RTX 3080
  serves it in 5,550 MiB. A measurement is evidence for its own window and larger ones. Above it the
  KV cache for the difference is added. Below it, when the weights are known and under the measurement,
  the weights and runner overhead stay and the rest scales with the window; otherwise the per-token KV
  cost is taken off, down to no less than half the measurement (gemma4's cost is several times high).
  Charged unscaled at a smaller window, a 27B seen at 65536 was refused at 16384 on an empty card. The
  per-token cost alone does not cure that on one 24 GB card (its geometry gives 0.066 MB where the engine
  held 0.207), which is why the weights matter. For an operator's or an agent's load, the step-down
  comes first: a measured model whose reserves put its sighted window over is loaded at the largest
  smaller window that fits. Only when not even 4096 fits, and the measurement itself is in what is free
  now, is it loaded at that window with a warning.
  Nothing is unloaded for it.
- **Measurements survive a restart.** The measurements are written to
  `<data dir>/state/inference-footprint-sightings.json`, tagged with the card they were taken on (or
  the machine, on unified memory and CPU), and read back by the next Hub process on the same hardware.
  The file is rewritten only when a figure moves by more than 64 MB or 2 %, or its window changes.
  Held in memory only, every Hub restart and fleet roll put the catalog's figure back, and the 8 and
  10 GB cards serving gemma4:e4b refused to pin or load it again.
- **Never measured: try the load.** An operator's load of an Ollama model onto a discrete card, for a
  model never measured here, whose catalog figure alone says no empty card here holds it even at 4096,
  is tried at 4096 instead of refused. The Hub evicts nothing for it: Ollama makes room among its own
  idle runners and puts what the card cannot take in system RAM. The model is measured as soon as it
  lands, and a warning is logged when Ollama could not put it wholly on the card. Lemonade and unified
  memory keep the refusal: Lemonade loads the whole model on the card, and on unified memory the spill
  would come out of the memory the OS itself runs in. So does an Ollama the Hub holds a pin on, since
  Ollama could make room by unloading the pinned model. An agent's MCP key and an app's request keep
  it too: the room Ollama makes can include runners apps loaded, which only an operator may have
  unloaded. On the request path a refusal is forwarded to the engine as before, which loads the model
  at the window the request runs at.
- **Pins.** The REST pin (`operator`) and MCP `hub_pin_model` (`operator` from the tool runner, else
  `agent`) share `InferenceRouterService.pinTrackedModel`, which holds the per-node load lock
  throughout: load the model the way `loadTrackedModel` does when it is not resident, then check the
  pinned-model budget with what it was measured occupying. A pin refused on a measurement is final
  and loads nothing. A pin refused on the catalog figure alone loads first and asks again; a model
  that then could not be measured on the card stays loaded but unpinned. Pins are persisted and
  survive a Hub restart; see [Model loading and eviction](#model-loading-and-eviction).
- **Slots.** The KV cache is charged once per Ollama slot. The slot count is the engine's own
  statement, else `inferenceOllamaSlots`, else 1. It is 1 for the families Ollama 0.34 runs on a
  single slot (`qwen35`, which includes qwen3.8:27b, `qwen3vl`, `mllama`, and others; see
  `OLLAMA_SINGLE_SLOT_ARCHITECTURES`), for a cost calibrated from a sighting, and for gemma4's geometry
  cost (`GEOMETRY_COVERS_EVERY_SLOT_ARCHITECTURES`). That cost counts gemma4's sliding-window layers as
  global: one slot is charged 6,144 MB of KV at 65536, while core-2 holds gemma4:e4b at 65536 on four
  slots in 3.4 GB in all.
  The Hub cannot read `OLLAMA_NUM_PARALLEL` (the API does not expose it, and the daemon's environment is
  outside the container), so a node whose `inferenceOllamaSlots` is unset is sized for one slot and logs a
  warning saying so, once per process. The setting lives in the Hub's data directory, which a Hub reset
  discards while the daemon's systemd drop-in survives: restate it after a reset with `cihub pool slots <n>`.
  beta-red ran four slots unstated and spilled 6.3 GB of qwen3:8b to the CPU at a 16384 window.
- **The request's window.** A load triggered by an app's request on Ollama uses the window that
  request runs at: its `options.num_ctx` on the native routes, and no `num_ctx` on `/v1`, where
  Ollama's default applies. A load at any other window is reloaded by that request. An operator's or
  an agent's pin or load uses the Hub's own window. For a `/v1` load the fit check sizes Ollama's
  default window, which the API does not expose: set `inferenceMaxNumCtx` to the node's
  `OLLAMA_CONTEXT_LENGTH`. Without it the check sizes the handout instead, and says so at debug level.
- **Lemonade.** Lemonade has one saved `ctx_size` per model and no window per request. The Hub loads
  at the larger of its own window and the context floor of any installed app the model qualifies for
  (Hermes: 64000). It does not step below that floor for memory that eviction can free: when an empty
  card holds the floor but what is free now does not, the load is sized at the floor and the eviction
  path unloads idle models for it. Whether eviction can free it is asked of the same plan the load
  then executes, with the load's own scope and the pool's in-flight work, so the floor is kept only
  where this load may pay for it. An operator's load may unload any idle unpinned model; an app's
  request or an agent only the Hub's own idle loads; nobody a busy one. The load goes below the floor
  only when not even an empty card holds it, or when what this load may unload would not free enough,
  and the warning says which, naming any busy model and, for a request or agent, that an operator's
  load could free more. Before this, beta-1 saved 32768 for Gemma-4-E4B-it-GGUF beside an idle Ollama
  gemma4:e4b, on a card that holds 64000 empty. The window is saved with `save_options` on
  `/v1/load`, which Lemonade 10.2.0 and 2026.x both accept. The options already saved are sent back
  with it, because 10.2.0 replaces them instead of merging. A window below the floor only because
  this load could not unload what holds the card is marked provisional
  (`LoadModelOptions.provisionalWindow`), and it never replaces a larger saved window. The model is
  loaded at it with the saved options but without `save_options`, so its next load, whether
  Lemonade's own or the Hub's once the memory is back, uses the saved window. Before this, a request's
  load beside an app's idle Ollama model saved the lower window for every later load and app. With
  nothing saved, or a smaller window saved, the provisional window is still saved, because Lemonade's
  own default is worse (4096 on 10.2.0, the whole card on 2026.x). A window below the floor because an
  empty card cannot hold it, or because of `inferenceMaxNumCtx`, is saved as usual.
  `engineCapabilities` reports the saved window of the LLM Lemonade holds, for pool placement (the
  smallest, when it holds more than one; it is not yet per model). `servedContextLength` is the
  smaller of the window a resident model is running at and its saved `ctx_size`, or whichever of the
  two can be read. A model Lemonade loaded by itself runs at its configured default (4096 on 10.2.0),
  and a provisional load runs below the saved window.
- **Lemonade's names.** 10.2.0 lists, loads and describes a model the Hub registered (the
  `nomic-embed-text-v1.5-GGUF` embedder) only as `user.<id>`. Residency (`isModelLoaded`), saved
  options (`GET /v1/models/{id}`), `servedContextLength` and `loadModel` resolve the catalog id through
  `engineModelId`, and a resident record matches under either spelling, so a resident embedder is
  adopted rather than loaded and registered again. The eviction plan and the footprint sightings match
  under either spelling too (`engineModelKey`).
- **No window for non-LLMs.** Embedding, TTS, and STT models get no window and no KV charge.

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

## Sign in with a DID

The Hub half of ADR-0016 (Local.Pub alongside KERI). A person whose identity key is an Ed25519 `did:key` signs a challenge this Hub issued, and signs in as the person who **linked** that DID first. It is not KERI: it imports nothing from `packages/common/src/keri`, sets no AID header, and changes nothing in forward auth.

The Hub accepts any well-formed Ed25519 `did:key` that is not a weak key (see the rules below) and makes no claim about who can produce one. A Local.Pub account's DID authentication key (a `z6Mk…` Multikey in its DID log) can be written as a `did:key`, but that key can rotate, and a rotation orphans the link. Whether any Local.Pub client or wallet will sign a Hub challenge is unknown and untested.

**Off by default.** With `CI_HUB_DID_AUTH` unset, or anything but the string `true`, all five routes answer 404 to everyone, signed in or not. The Hub reads the flag from the environment of its own process, on every request. Nothing in a running Hub changes that environment, so switching the feature on or off takes a restart (recreate the container after editing the env file). The answer is the 404 Nest gives a path no route claims, with the same status, body and headers: for origin-form requests, for every method, for HEAD, and for the absolute-form forms the twin test covers (an absolute-form target, a backslash in one, an empty host). **Two known residuals let a scanner tell a Hub that has the feature built in, flag off, from a build without it.** In an image that carries the frontend bundle, the SPA fallback (`ServeStaticModule`) decides what to exclude from `req.originalUrl`, so on a build without the routes it answers an absolute-form `GET` or `HEAD` for `/api/…` with `index.html` (200) where this Hub answers the 404. And outside `NODE_ENV=production` (a dev or local image), `/api/docs-json` lists the five routes whatever the flag says. Making the surface really absent means registering the handlers only when the flag is set at startup; that is not done (`did-sign-in-absent-surface` in `TODO.md`). `DidAuthFlagGuard` runs before `AuthGuard`. A controller built without `DidAuthService` has no such routes either, and `AuthModule` provides it (`did-auth.wiring.test.ts`).

| Route | Who | What |
|---|---|---|
| `POST /api/auth/did/challenge` `{purpose?}` | anyone; 20 a minute per client | A single-use `{challengeId, nonce, audience, purpose, expiresAt}`, kept in the cache for 120 s. `purpose` is `sign-in` (the default) or `link`; the caller chooses it, the Hub keeps it, and it is not signed. `audience` is this Hub's `urn:ci-hub:<directory id>`, the issuer forward auth already signs under. |
| `POST /api/auth/did/verify` `{challengeId, idToken}` | anyone; JSON only; 10 failures a minute per client | A linked, active person gets a session and the session cookie, or `{totpSessionId}` if they have TOTP on (finish with `/api/auth/verify-totp`). A person with a Portal link is first checked against Portal (below). A DID nobody linked: 403 `AUTH_ERROR_DID_NOT_LINKED`. Every other refusal of a proof that reaches verification, and a revoked or deleted person: the one 401 `AUTH_ERROR_DID_SIGN_IN_REFUSED`, with nothing about which check failed. A body that fails validation never reaches verification (400, below). |
| `GET /api/auth/did/links` | an interactive session | The caller's own DID links, `{links: [{did, linkedAt}]}`. |
| `POST /api/auth/did/link` `{challengeId, idToken}` | an interactive session; not the demo user; not another site; JSON only; shares verify's 10 failures a minute | Links the proven DID to the session's own person (taken from the session, never the body). The challenge must have been asked for with `purpose: link`. A proof that does not verify: 400 `AUTH_ERROR_DID_PROOF_REFUSED`, never 401. 409 `AUTH_ERROR_DID_ALREADY_LINKED` if someone else holds the DID. |
| `DELETE /api/auth/did/link` `{did}` | an interactive session; not the demo user; not another site; JSON only | Removes the caller's own link. 404 `AUTH_ERROR_DID_LINK_NOT_FOUND` otherwise, whoever else holds the DID. |

**What a client reads.** A refusal is a `TranslatableError`, so the body is `{statusCode, message, path}` and `message` is the i18n key, as on every other auth route; there is no separate `code` field. `AuthGuard` adds 401 `SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN` when there is no session at all.

| Status | `message` | When |
|---|---|---|
| 400 | `Bad Request Exception` (not an i18n key: the global validation pipe) | challenge, verify, link, unlink: the body fails validation (a missing field, an `idToken` over 4096 characters, a `challengeId` over 64, a `did` that is empty or over 200, a `purpose` that is neither). The challenge is not read, so it is not spent |
| 400 | `AUTH_ERROR_DID_PROOF_REFUSED` | link: the proof did not verify |
| 401 | `AUTH_ERROR_DID_SIGN_IN_REFUSED` | verify: the proof did not verify, or the person is revoked or gone |
| 403 | `AUTH_ERROR_DID_NOT_LINKED` | verify: the proof verified and nobody linked that DID |
| 403 | `AUTH_ERROR_NOT_ORG_MEMBER` | verify: Portal says the person left the organization |
| 403 | `AUTH_ERROR_DID_CROSS_SITE_REQUEST` | link, unlink: another site sent it |
| 403 | `AUTH_ERROR_SIGNED_IN_PERSON_REQUIRED` | list, link, unlink: not a person's own session |
| 404 | `AUTH_ERROR_DID_LINK_NOT_FOUND` | unlink |
| 409 | `AUTH_ERROR_DID_ALREADY_LINKED` | link |
| 415 | `AUTH_ERROR_DID_JSON_REQUIRED` | verify, link, unlink: the body is not `application/json` |
| 429 | `AUTH_ERROR_RATE_LIMITED` | over a limit; the body also carries `intlParams.retryAfter`, in seconds |
| 500 | `SERVER_ERROR_NOT_ALLOWED_IN_DEMO` | link, unlink: the Hub runs in demo mode. The shared demo-mode helper gives the key the default status of a `TranslatableError`, as on every route that uses it |
| 503 | `AUTH_ERROR_DID_UNAVAILABLE` | challenge: the Hub cannot read its own issuer |

The SPA signs the client out on any 401 from a path not in `SESSION_EXPIRY_EXEMPT_PATHS` (`session-expiry-policy.ts`). `/api/auth/did/verify` is on that list, because a proof that does not verify is its answer. The other routes never answer 401 except for a missing session, which is why a refused link is a 400.

**The proof** is a SIOPv2-shaped self-issued ID token, a compact JWS signed with EdDSA, at most 4096 characters:

```
header   {"alg":"EdDSA","typ":"JWT","kid":"<did>" | "<did>#<fragment>"}          (kid optional)
payload  {"iss":"<did>","sub":"<did>","aud":"<audience>","nonce":"<nonce>","iat":n,"exp":n}
```

`audience` and `nonce` are the challenge's; `iat` and `exp` are whole Unix seconds, `exp` is later than `iat`, `exp - iat` is at most 300, and a signer's clock may be 30 s off. The Hub names the contract and checks nothing else about the signer. SIOPv2's request-object transport is the planned adapter, additive to this.

**Rules, each with a test** (`did-key.test.ts`, `did-auth.service.test.ts`, `did-auth.controller.test.ts`, `did-auth.guard.test.ts`, and through the real Nest stack `did-auth.http.test.ts`):

- **Link first.** The Hub creates no person and no binding from a DID alone, and derives none from a label, a name or an email. A binding is a `federated_identity` row with issuer `did:key` and the full `did:key:z6Mk…` as subject, made by a signed-in person. `/did/verify` reads no binding while it checks the proof, and creates no person or binding afterwards, whether or not anyone linked the DID.
- **The key is the DID.** The verifying key is derived from `iss` and from nothing else; `jwk`, `jku`, `x5u` and `kid` select nothing (a `kid` must be the DID or start `<did>#`). `alg` must be `EdDSA`. `iss` must equal `sub`, and be a well-formed Ed25519 `did:key` that is not weak (no DID URL, no other key type). DIDs whose key can rotate (`did:web`, `did:webvh`, `did:scid:vh`, KERI AIDs) are refused: reading one means resolving a log.
- **Weak keys are refused.** A small-order point (the identity and the points of order 2, 4 and 8, in either sign) makes a signature verify for any message with no private key, so a DID for one is a factor nobody has to hold. A `y` of at least `2^255 - 19` is a second spelling of a point, so one key would have two DIDs. `isWeakEd25519Key` refuses all 14 small-order encodings and every `y >= 2^255 - 19` with no curve library, and `did-key.test.ts` checks the five `y` values it uses against a group-law computation. A string of 32 bytes that is not a point on the curve (about half of them) is refused too, as defence in depth: nothing verifies under such a key, and no Hub route links a DID that was typed in (a link is made from a token whose `iss` must verify under that key), so it changes no outcome here. It is **not a typo guard**: one wrong character in a `did:key` is another valid `did:key` about 46% of the time. `isEd25519CurvePoint` is a port of Companion Memory's, decides by RFC 8032 section 5.1.3, and is checked against 130 distinct encodings produced by an independent Python implementation (`__tests__/fixtures/ed25519-oncurve-vectors.json`); Memory's spec carries a subset of them. The byte-level helpers are total: anything that is not exactly 32 bytes in a `Uint8Array` is weak, not a point, and has no DID.
- **Single use, and a purpose that does not stop a relayer.** A challenge is read and deleted in one synchronous step, and spent by whatever proof reaches verification first, valid or not (a body that fails validation is answered before and spends nothing). It has a purpose, `sign-in` or `link`, fixed when it is issued, and a proof presented for the other purpose is refused. That stops a Hub page mixing the two up. **It does not stop a relayer.** The purpose is chosen by whoever calls the public challenge route, which is the relayer, and it is not among the signed claims, so the signer's wallet neither sees nor signs it. A relayer who asks for a `link` challenge, shows it to the DID's owner as a login, and redeems the signature on `/did/link` from their own session binds the owner's DID to the relayer's person. The owner's own link then fails with a 409, they cannot remove a row that is not theirs, and their DID signs in as the relayer's person. Closing that needs a signed purpose or request object and a way for a key's holder to release a link someone else made (`did-sign-in-signed-purpose` and `did-sign-in-release-link` in `TODO.md`).
- **One audience.** `aud` must be exactly this Hub's issuer, as a string. A proof made for another Hub, for Portal, or for several parties does not verify.
- **Interactive sessions only for links.** Link, unlink and list need `hubPrincipal === 'session'` (`HubSessionGuard`). The Portal push key, the host-local key and the CLI token all speak as the first operator and are refused. Link and unlink are also refused in demo mode (`DemoModeGuard`, after `HubSessionGuard` so the flag-off answer is unchanged): a link is a way in that no password change removes, and demo mode already stops the shared user changing the password, the username and TOTP.
- **A page on another origin cannot change a link.** Link and unlink are refused with 403 when the browser says another site sent them (`Sec-Fetch-Site: same-site | cross-site`) or when the request's `Origin` names another host or port than the one it was sent to (the first `X-Forwarded-Host`, else `Host`), and with 415 unless the body is `application/json`. `Sec-Fetch-Site` alone is not enough: a browser sends it only to https and loopback URLs, so a Hub reached over plain http at a LAN name never sees it. `Origin` is sent on every cross-origin POST and DELETE, and requiring JSON takes the request out of the CORS "simple" class, so a page on another origin needs a preflight, which the Hub answers for its own origins only. A request with neither header (`curl`, the `cihub` CLI, a script) passes: there is no browser to abuse. The desktop shell's origin (`tauri://localhost`) is another origin and is refused until a screen for these routes exists. A proxy that rewrites `Host` and sends no `X-Forwarded-Host` makes the Hub's own pages look cross-origin, and their link and unlink calls answer 403; Traefik, which the Hub ships behind, sends it.
- **The second factor stays.** A person with TOTP on gets `{totpSessionId}` from `/did/verify`, like a password sign-in; the DID replaces the password, not the code. The Portal sign-in routes (`/auth/portal/callback`, and the mobile and desktop session routes) create their sessions without asking for the Hub's TOTP, and no source records why; this path does not copy that.
- **Portal membership is asked, and offline it is not.** `/did/verify` runs `AuthService.assertStillOrgMember`, the check `refreshSession` makes (the refresh shares it, and with it the rules below on an unreadable or missing registration). It does not go through `admitHubPerson`, the path password and Portal SSO sign-in take. Three kinds of person:
  - A person with a link from the paired Portal is asked about that link, by its Portal subject (never the DID). "Not a member" revokes them, ends their sessions and answers 403 `AUTH_ERROR_NOT_ORG_MEMBER`; a member is marked active.
  - A person whose only Portal links are from another Portal (the Hub moved to a new one) is asked about that link, as the sweep and the refresh always have (#2178), and is revoked on a definitive "not a member". A DID is no way round a removal.
  - A person with no Portal link at all (a local password or DID-only person) has no membership to check and is not asked. The check-in sweep skips the same people.

  Nobody is revoked, and the person is let in, when Portal cannot be reached, answers with an error, or is not configured; when the Hub is not paired to an organization (a reset that unpairs it never revokes anyone); and when the registration cannot be read (an unreadable registration is "unknown", as on the password path).
- **Portal links stay Portal links.** `federated_identity` is shared, and its readers send a link's subject to Portal as a person id. `linksForCurrentPortal` now drops every `did:`-issuer link before choosing, because its "every link" fallbacks would otherwise return a DID, Portal would answer "not a member", and the sweep would revoke the person who linked it.

**What a link outlives.** Nothing that recovers a sign-in removes a link. Changing the password or the username, the operator password reset (which also turns TOTP off), and a Portal removal all end the person's sessions and leave the `did:key` row. After an operator reset, `/did/verify` for a linked DID opens a session with no second factor. Only `DELETE /did/link` removes one, and nothing but the generated API client calls these routes: no screen and no `cihub` command lists or removes one (`did-sign-in-link-surface` in `TODO.md`).

**What an unlink does not end.** A session a DID opened is an ordinary session: seven days, sliding, with no record of how it was made. `DELETE /did/link` removes the row and nothing else, so an owner who unlinks a lost or stolen key leaves any session the key already opened alive until the password or the username is changed. Changing either ends all of the person's sessions. Whether an unlink should end the person's other sessions is an open decision (`did-sign-in-link-surface`).

**What the challenge route shows.** It is anonymous. With the flag on, any caller who can reach the Hub, a tunnel or a public hostname included, learns its directory id as `audience`: a per-install identifier that lasts until a factory reset. Forward auth gives that value (`X-CI-Hub-User-Issuer`) only to apps that hold a forward-auth key, which are Companion Memory and any app whose env sets its own `CI_HUB_FORWARD_AUTH_SECRET`. An app without a key, which is every third-party app, gets the username alone. So this is a new disclosure of a stable per-install id, not a repeat of what apps already see, and the Hub security reviewer should accept it or ask for an audience that does not carry the directory id. The first call can also write: `ForwardAuthIdentityResolver.hubIssuer` inserts the `user_directory` row when a restore or a reset left none, as the first forward-auth call does, so an anonymous request can be the one that creates it.

**Not verified:** the Hub was not run end to end (no Docker or GUI session where it was written), and nothing ran against Postgres or Traefik. The HTTP test runs the real Nest stack on a real port with the users, links, cache and Portal faked. No Local.Pub client or wallet has been checked against the token, and none is known to sign one.

## Family Hub auth and Memory connect

Human dashboard login by password and by Portal SSO goes through `AuthService.admitHubPerson`; the DID sign-in does not, and makes only the membership check described under [Sign in with a DID](#sign-in-with-a-did). Each Portal `(issuer, subject)` that is a member of the paired org gets their own Hub `user` row (`operator: true`). Device-key Bearer and CLI JWT still map to the bootstrap operator.

`memory_connection` is unique on `(app_urn, hub_user_id)`. Env generation injects the newest connected key, so an app runs with the connection of the person who connected it last. Looking at the app, its Hub page or its connect gate, or choosing **Not now**, never changes that. Only a finished connect does. It revokes the previous person's key on CI Memory before the exchange mints the new one, because CI Memory revokes by app and its key rotation refuses an app with two owners. If the exchange or the store fails after that revoke, the previous connection is gone for good, so the callback lands on the dashboard with `?memoryConnect=previous_removed` and a toast that says so; a key that was minted but not stored is revoked. Disconnect is refused with `MEMORY_CONNECT_DISCONNECT_REFUSED` (403) to anyone but the person whose connection the app runs with (Companion-Hub#2080). A connected row with `hub_user_id` 0, from before connections were per person, is nobody's: it reads as connected for everyone and anyone may disconnect it. Connecting and disconnecting restart the app, so `/start` and `/disconnect` first take the app's `restart` grant, as the restart route does: `/disconnect` answers 403 `APP_ACTION_GRANT_DENIED`, and `/start`, a browser navigation, lands on `/?memoryConnect=denied`. The callback asks again before the exchange, so a grant taken away while the person is on the consent page ends the connect there, on the same marker. Both status routes report `connectedByOther` (the app page's `/status` and the app gate's `/state`). The app page shows **Memory connected by someone else**. Hermes and OpenClaw declare `hub_integration.memory` so Hub can inject `CI_SERVER_URL` / `CI_SERVER_TOKEN` from that connection.

## Per-app grants

Routes that read or mutate one app assert the operator's Portal grant through
`MarketplaceWhoIsService`: `assertSessionAction` for a single app, `assertSessionActions` for a set
(one batched WhoIs round trip — asserting in a loop costs a Portal request per app), and
`filterSessionByView` to trim a list. Both asserts no-op when the request carries no Hub session, so
API-key callers such as the `cihub` CLI are unaffected.

Apps in the `_user` store (custom apps and port exposes) exist only on this Hub, so their grants are
not read from WhoIs and nothing is cached for them. Anyone signed in may view one. A port-expose row
also gets `start`, `stop` and `uninstall`. Any other change to a `_user` app, starting or removing a
custom app included, takes an organization owner or admin: the role check `hasManagingRole` makes,
asked of the Portal fresh. When the role can't be read, the change is refused and the app stays listed.
An operator with no linked Portal identity has no role to read, and keeps the member fallback every
app gives them (`DEFAULT_MEMBER_ACTIONS`: start, stop and restart, never uninstall).
`PATCH /custom-apps/:urn` (the compose), `POST /custom-apps/:urn/image` and `PATCH /custom-apps/:urn/metadata`
assert `configure`, so editing a custom app follows the same rule. A port expose has no `configure`, so
these three refuse one for every session. A port expose changes through `PATCH /custom-apps/port-expose/:urn`.

Reading a `_user` app's settings or backups takes the verb that changes them (`local-app-reads.ts`):
`GET /apps/:urn/compose-diff` and `GET /user-config/:urn`, where a custom app keeps its env values, take
`configure`; listing and downloading its backups take `backup`. The MCP tools for the same reads ask the
same. A member keeps the app in lists, its page, its status and Open. A catalog app keeps `view` for
these reads, since an owner narrows who may see it in the Portal.

Creating a custom app takes an organization owner or admin too: `POST /custom-apps` asks
`assertSessionMayCreateCustomApp`, and MCP's `hub_create_custom_app` asks `assertActorMayCreateCustomApp`.
Both read the role with a role-only WhoIs (no app named), refuse when it can't be read, and refuse an
operator with no linked Portal identity, whose fallback has no `install`. An MCP key answers to its
creator's role; a managed key, or one nobody is recorded as creating, is refused. `GET /custom-apps/access`
tells the UI what to offer on a custom app (`customAppActionsHint`), so it shows only those controls. It
answers from the role stored at sign-in and refreshed by the hourly membership check (`user.orgRole`),
without a Portal call, and asks the Portal only when no role is stored. Every action still asks fresh,
so a role changed within the hour, or a Portal outage, can leave the UI offering what the Hub refuses.
The port-expose routes still take only a sign-in.

`/user-config/:urn` (GET, PUT, enable, disable) asserts the same verbs as its MCP tools for every app:
reading takes `view` (`configure` on a `_user` app), and every change takes `configure`.

An app's log stream (`/api/sse/app-logs`) takes the verb reading its settings takes (`settingsReadAction`),
since a container prints its env values at start. A stream sends at most 1000 lines at the start
(`logStreamLines`), as the `hub_get_app_logs` MCP tool does.

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

## Hub-wide changes

A member of the organization is view-only across the Hub. Every route that changes what applies to the
whole Hub, or reads the Hub's own log, carries `HubManagerGuard` after `AuthGuard`: user settings and
`acknowledge-welcome`, inference preferences, cloud providers, model pulls, loads and pins, hardware
rescan, ROCm state and the Ollama install, Hub Pool settings, pins, pairing and peers, app stores
(add, change, delete, pull), Tailscale connect, sync and disconnect, the Docker network repair, the
registration reset and tunnel reconnect, the Hub update and auto-updates, the factory reset, API keys
(create, change, revoke), the MCP tool runner, `GET /system/logs/download` and `/api/sse/ci-hub-logs`.
`hub-manager.guard.test.ts` lists them; add a new Hub-wide route there too. The removal check
(`POST /registration/removal-check`) takes only a sign-in: it reports the check-in the unauthenticated
status route sends anyway, and a role can't be read once the Portal has deleted the device.

The guard asks `MarketplaceWhoIsService.hubManageVerdict`:

- The operator who claimed the Hub passes whatever their organization role, and the Portal is not
  asked: the person who set the Hub up keeps it. That is the oldest operator row
  (`UserRepository.getFirstOperator`), the one `createFirstOperator` writes and the CLI acts as. A
  factory reset truncates the user table and its sessions, so the next claimer takes it over.
- Anyone else follows their role, asked of the Portal with a role-only WhoIs, never from the role
  stored at sign-in. An owner or admin passes, and a member gets 403 `HUB_MANAGE_ROLE_REQUIRED`. A yes
  is kept for a minute per person, Portal identity and organization (`HUB_MANAGER_KEPT_MS`), so one
  settings save doesn't ask once per request; a demotion counts once it runs out. A no or a failure
  is never kept.
- The claimer may also give an API key full capability (`mayGrantFull`), which otherwise takes an
  owner or admin, asked fresh.
- A role the Portal can't confirm (down, unreachable, an error answer) gets 503 `HUB_MANAGE_ROLE_UNVERIFIED`.
- Someone else with no role to ask about (the Hub isn't paired, or no linked Portal identity) gets 403.
- The CLI and the host-local key pass by name. The Portal push key, which only brokers app installs,
  and every other principal get 403.

`GET /api/hub-access` tells the UI whether to show these controls (`hubManageHint`), from the role
stored at sign-in, as `GET /custom-apps/access` does for custom apps. Settings hides the App stores,
Network, AI, MCP and Logs tabs from a member, and the Hub-wide controls on Settings, Security and System.
A member skips the device wizard: `GET /api/app-context` reports `hasCompletedOnboarding: true` for
someone `hubManageHint` turns down, as it does for a later operator whose wizard already ran.

### Hub-wide MCP tools

An MCP tool whose HTTP route carries the guard is marked `hubWide` in its registration: the model pull,
load, unload, pin and unpin tools, `hub_set_cloud_provider`, `hub_set_auto_updates`, `hub_perform_update`,
the app store add, update, delete and pull tools and `hub_get_hub_logs`. `destructive-tools.test.ts`
lists every route that carries the guard with the tools that do what it does. It fails when a guarded
route is missing from that list. A new tool that does what a guarded route does goes there and is
marked `hubWide`.

Before one runs for an `/api/mcp` key, the registry asks the guard's question about the person who
created the key (`assertMcpKeyMayManageHub`, which calls `hubManageVerdictFor`) on every call, with the
guard's answers. The claimer, owners and admins pass. A member gets 403 `HUB_MANAGE_ROLE_REQUIRED` and a
role the Portal can't confirm gets 503 `HUB_MANAGE_ROLE_UNVERIFIED`. A claimer whose access was revoked
loses the claimer's pass. A managed app key or a key with no recorded creator (minted by the CLI, or
before v0.2.70) has nobody to ask and gets 403 `HUB_MANAGE_KEY_REISSUE_REQUIRED`. The tool runner asks
about the signed-in person.

`tools/list` leaves these tools out for a key they would refuse. It reads the Hub's own records
(`storedHubManageVerdictFor`): the claimer, the creator's revoked access and the role stored for the
creator at sign-in or at the membership check after each accepted check-in. Listing never asks the Portal; with no role stored,
the tools are listed and the call decides. The 2026-07-28 handler builds a server per request with only
the tools the key may list, so there a left-out tool is unknown to `tools/call` too. A creator promoted
since their role was stored waits there for their next sign-in or the next membership check. The key
list in Security settings marks the keys these tools refuse (`hubWideBlocked` on `GET /api/api-keys`),
from the same records.

`GET /api/app-context` reports the settings named in `APP_CONTEXT_SETTINGS` (`app.dto.ts`) and nothing
else, so no key reaches it: not the Portal device or move key, the vLLM key or the cloud provider keys.
`setUserSettings` keeps the device and move keys out of `config.userSettings`; code reads them from the
top-level config. `GET /api/inference/preferences` reports a stored vLLM key as `••••••••`, and a save
that sends the mask back keeps the stored key, as cloud provider saves do.

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
- Describe a failed outbound request with `describeNetworkError` (`common/helpers/network-error.ts`), not
  `error.message`. When no address of a host accepts the connection, Node's `AggregateError` and the axios
  error around it have an empty message; the helper names each address and why it failed.
- `main.ts` raises Node's per-address connect time from 250 ms to 2 s before the app is created
  (`common/helpers/connect-attempt-timeout.ts`). Node abandons an attempt that runs out of time, so 250 ms
  failed connections that were only slow.
