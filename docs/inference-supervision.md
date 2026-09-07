# Inference backend observation

The Hub can watch its six inference backends and the containers in its own Compose project, and
raise an alarm when something is being restarted in a loop. It is **off by default**, and it never
restarts, stops, or starts an inference backend.

## The Hub does not restart inference backends

This is a decision, not a missing feature.

The failure that motivated this work is an ollama service that systemd restarted roughly 97,000
times against a wedged NFS model directory, silently, for as long as it took someone to look. Every
design for an automatic restarter that was reviewed against that incident reproduced its shape:

- **A restart budget can reset itself.** A budget has to be keyed on something. Key it on the
  backend's identity and you have to include the base URL — and `OllamaBackend.getBaseUrl()` returns
  `resolvedUrl`, mutable state that `invalidateResolvedUrl()` flips on every failed probe as it
  re-derives the URL by trying `host.docker.internal`, then `172.17.0.1`, then `localhost`. A
  flapping backend oscillates its own key, and each oscillation hands it a fresh budget.
- **"Stop once the failure is deterministic" excluded the flagship case.** The rule proposed for it
  required the process to exit *early*. The Lucebox ROCm failure this feature was built around
  starts fine, passes `/health`, and dies inside the first generation — which on an idle node can be
  hours later. The one failure the restarter existed to stop is the one it would have restarted
  forever.
- **Something else already owns the container.** On the fleet, `ci-hub-inference-lucebox` is created
  and started by the desktop app (`packages/desktop/src-tauri/src/inference_runners.rs`). A Hub that
  stopped it would be overruled on the operator's next launch, and the operator would see an engine
  flapping between two owners with no explanation from either.

So `inferenceSupervisionMode` has exactly two values, `'off'` and `'observe'`. The union is the
guarantee: there is no value that selects a code path capable of acting on a container, the service
holds no reference to `DockerService` (which owns the mutating calls), and a test asserts that no
file in the layer so much as mentions one.

If auto-restart is ever revisited, the observation data this produces is what a real budget would
have to be designed against.

## What it observes

### Per backend

Each tick resolves, per backend, **what control plane the Hub actually has** — never assuming one,
because the six backends are genuinely not uniform:

| Target kind | What it means | Which backends land here |
|---|---|---|
| `container` | A local container whose published port matches the URL the health check probes | `lucebox` on a fleet node; `ollama`, `vllm`, `lemonade` if the operator runs the container |
| `host-process` | A daemon outside this container's PID namespace | Host ollama under systemd; `mtplx` and `dspark`, always |
| `remote` | An endpoint on another machine | `vllm` whenever `preferredVllmUrl` points across a tailnet |
| `absent` | Nothing answers and nothing matches | Any backend that is not deployed here |

Two rules matter more than the rest:

- **A remote endpoint cannot be observed locally**, and saying so is the correct answer. Without
  that gate the Hub would report on a local container named `ci-hub-vllm` because a Mac across the
  tailnet went down.
- **A name match is not enough.** The container's published host port must match the port in the
  base URL. The desktop publishes Lucebox on a *dynamic* host port (`available_host_port`), so
  `ci-hub-inference-lucebox` routinely has nothing to do with whatever answers
  `SPECULATIVE_INFERENCE_URL`. No port match downgrades to `host-process`, never up to `container`.

`mtplx` and `dspark` are permanently `host-process`: both `getDockerImage()` and
`getComposeConfig()` throw unconditionally in those backends, so neither has ever had a container to
find. They run as launchd LaunchAgents with `KeepAlive` and `ThrottleInterval`, which is already a
correct supervisor for them.

### Across the whole Compose project

The restart sweep is scoped to `com.docker.compose.project=ci-hub`, **not** to the six inference
backends, plus the inference containers by name (the desktop's `docker run` carries no Compose
labels at all).

That scope is the only reason the alarm can see the failure it was built for. The worst loop the
fleet has recorded is `hub-tailscale` at `RestartCount=11463`, respawning about every 60 seconds
through an entire measurement window with nobody aware — and `hub-tailscale` is a Hub stack service,
not an inference engine.

Two alarm rules:

- **Absolute** — a `RestartCount` at or above 50, with no history required. This is the half that
  works on a Hub that has just booted. A delta needs a baseline, and a supervisor with no memory
  across its own restarts is exactly what lets five-figure restart counts accumulate unseen.
  dockerd's counter is durable even when the observer's memory is not, so the large number *is* the
  evidence.
- **Rate** — five restarts accumulated within an hour while the Hub was watching.

Repeat alarms are spaced an hour apart, and escalate early if the count climbs another 100.

### Diagnoses

| Code | Signature | What the operator is told |
|---|---|---|
| `lucebox_rocm_legacy_image` | Image is `ghcr.io/luce-org/lucebox-hub:rocm`, GPU vendor is `amd`, and two or more SIGSEGV-shaped deaths | `assertLuceboxImageSupportsArch`'s own message, plus: the container has to be **recreated**, because starting it again reuses the image it was created with |
| `startup_dependency_failure` | Exited with a JIT/compile/import failure in the log tail | Names the failure; a deterministic one, so it fails identically every start |
| `zombie_child_processes` | Eight or more `Z`/`defunct` entries in `docker top` | They clear on a restart, which is an operator action |
| `no_weights` | Lucebox answers `/health` with no loaded model | Check `DFLASH_TARGET`/`DFLASH_DRAFT` and the models bind mount |

The Lucebox diagnosis deliberately does **not** match on a `gfx*` architecture string. Nothing in
this repo produces one at runtime: `HardwareProfile.gpu` has no LLVM-target field, and
`LuceboxComposeOptions.gpuArch` is an input nothing ever fills. An arch-based rule would never have
fired on the seven fleet nodes it was aimed at. The image tag, the vendor, and a repeated segfault
are evidence that exists.

## Relationship to `ServingQuarantine`

`backends/serving-quarantine.ts` is the other "stop trusting a thing that keeps failing" mechanism
in the inference module. The two are deliberately orthogonal and must not be merged:

| | `ServingQuarantine` | this observer |
|---|---|---|
| Subject | one (backend, model) pair | one backend *process* |
| Evidence | real request outcomes (5xx, failed load) | health polls + container inspect |
| Effect | withholds a model from routing, 60 s doubling to 15 min | none; writes an event and a report |
| Recovery | any success clears it, backoff included | health returns |

The hard rule, which survives even though this observer takes no action: **a quarantine strike must
never cause a restart.** Fleet node core-4 answers `/api/tags` 200 for `gemma3:1b` while every
`/api/generate` returns 500. Restarting ollama for that would fail identically forever — it is the
97,000 pattern with a different cause. Quarantine already handles it correctly by routing around the
model. Conversely, nothing here clears a quarantine: a restart is not evidence a model can load,
only serving it is.

## Where the alarm goes

`HostTelemetryService.recordEvent('error', 'inference-observer', …)`, which persists to
`host_event_log`, and the Hub logger. A crash loop nobody sees is the failure mode being fixed, so
the event survives a reboot — an operator who comes back to a box that has been looping for a week
needs the record, not a log line that rotated away.

Telemetry is injected `@Optional()` (following `AppRuntimeMonitorService`), so the logger is written
unconditionally; a missing provider cannot swallow the one thing this layer is for.

## Turning it on

Settings, both optional:

```jsonc
{
  "inferenceSupervisionMode": "observe",     // 'off' (default) | 'observe'
  "inferenceSupervisionPollSeconds": 30      // 10-300
}
```

Environment kill switch, which wins over the setting and follows the `HUB_POOL_USER_DISABLED`
convention:

```
CI_HUB_INFERENCE_SUPERVISION_DISABLED=true
```

It is deliberately **not** projected into `.env` by `generateSystemEnvFile`, for the same reason
given on `resolveHubPoolEnabled`: env-first precedence applied to the Hub's own persisted value
would make the flag permanent and the setting could never be switched back on from the UI.

### Why the default is `off`

`'observe'` is cheap but not inert. Each tick calls `healthCheck()` on all six backends, which
bypasses the 20-second `OWN_INVENTORY_TTL_MS` cache `HubPoolPeerService` maintains precisely because
that fan-out is expensive, and `OllamaBackend`'s health check mutates the shared `resolvedUrl` that
the live request path reads through `getBaseUrl()`. On a node whose host ollama is down, one tick
costs three fallback probes plus a `/api/tags` timeout, and the URL cache is discarded again on
every failure.

Only `'off'` costs a deployed Hub nothing: `onModuleInit` reads one setting and returns without
arming a timer, issuing a Docker call, running a health check, or touching hardware detection. A
peerless single-node Hub therefore behaves exactly as it did before this shipped. There is a test
that asserts each of those.

Turning the setting off stops the poll at the next tick, so an operator does not have to restart the
Hub to stop the polling. Turning it back on takes effect at the next Hub restart — deliberately
asymmetric, because the direction that has to be immediate is the one that stops work.

## Reading the report

```
GET /api/inference/supervision      (AuthGuard)
```

Per backend: base URL, target kind and ref, the plain-language reason it is or is not observable,
health, consecutive unhealthy observations, `RestartCount` and restarts since first seen,
diagnoses with remediation, and the last captured log tail. Plus every container in the Compose
project the daemon is looping.

There is no companion `POST`. The Hub takes no action on a backend, so there is none to offer.

## Limits, stated plainly

- **A host-process crash loop faster than about twice the poll interval is invisible.** The
  ~97,000-restart ollama was a systemd unit cycling well inside a minute; at a 30-second poll the
  transitions alias out and the backend simply reads as steadily unhealthy, which the status page
  already said. Container loops are caught by `RestartCount`, which is a counter rather than a
  sample, so it does not alias. There is no equivalent counter for a host daemon.
- **Remote endpoints are reported, never observed.** Their process, restarts, and logs belong to
  another host.
- **`mtplx` and `dspark` cannot be observed beyond HTTP health.** They have no Docker path, and the
  Hub has no access to the host's launchd.
- **The frontend does not render this yet.** The route exists; the generated API client is
  regenerated after merge, so the settings card is a follow-up.
