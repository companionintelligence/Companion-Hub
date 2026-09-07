/**
 * Constants and pure resolution for inference-backend *observation*.
 *
 * ## The Hub never restarts an inference backend
 *
 * This module deliberately has no `'supervise'` mode, and nothing downstream of it can restart,
 * stop, or rewrite the restart policy of anything. That is not an omission that a later change
 * should quietly fill in — it is the feature. The incident this whole layer exists for is an
 * ollama service that systemd restarted ~97,000 times against a wedged NFS model directory, and
 * every restart-capable design reviewed for it reintroduced the same shape:
 *
 * - A lifetime restart budget keyed on a fingerprint that includes the backend's base URL resets
 *   *itself*, because {@link import('@/modules/inference/backends/ollama.backend').OllamaBackend}
 *   rediscovers `resolvedUrl` by probing and flips it on every failed health check. A flapping
 *   backend therefore oscillates its own fingerprint and is handed a fresh budget on every flip.
 * - A "stop restarting once the failure is deterministic" rule that requires the process to exit
 *   *early* structurally excludes the Lucebox ROCm case (see {@link LUCEBOX_ROCM_LEGACY_IMAGE}'s
 *   contract): that container starts, passes `/health`, and dies inside the first generation,
 *   which can be hours later.
 * - On the fleet the Lucebox container is created and started by the desktop app
 *   (`packages/desktop/src-tauri/src/inference_runners.rs`). A Hub that stopped it would be
 *   fighting a component that starts it again on next launch, and the operator would see an engine
 *   that flaps between two owners with no explanation on either side.
 *
 * So the mode enum below has exactly two members and the union type is the guarantee: there is no
 * value a caller can pass that selects a code path capable of acting on a container.
 *
 * ## What observation is for
 *
 * Telling someone. A crash loop nobody sees is the failure mode being fixed — the fleet report
 * records `hub-tailscale` at `RestartCount=11463`, respawning every ~60 s through an entire
 * measurement window, with nobody aware. See {@link ABSOLUTE_RESTART_ALARM} for why that number
 * specifically is catchable by a Hub that has only just booted.
 */

/**
 * Observation modes. `'off'` runs no timer and issues no probe of any kind; `'observe'` polls,
 * classifies, diagnoses and raises alarms, and still touches nothing.
 *
 * There is no third member. See the module comment.
 */
export const INFERENCE_SUPERVISION_MODES = ['off', 'observe'] as const;

export type InferenceSupervisionMode = (typeof INFERENCE_SUPERVISION_MODES)[number];

/**
 * Default `'off'`, and this is the one setting in the group that is opt-IN rather than opt-out.
 *
 * `'observe'` is cheap but it is not free, and more importantly it is not *inert*: each tick calls
 * `healthCheck()` on all six backends, bypassing the 20 s `OWN_INVENTORY_TTL_MS` cache that
 * `HubPoolPeerService` maintains precisely because that fan-out is expensive, and `OllamaBackend`'s
 * health check mutates the shared `resolvedUrl` it hands the live request path through
 * `getBaseUrl()`. On a node whose host ollama is down, one tick costs three fallback probes plus a
 * `/api/tags` timeout, and the URL cache is discarded again on every failure.
 *
 * A peerless single-node Hub that never opts in must therefore pay nothing at all: no timer, no
 * Docker call, no probe, no boot work. That is asserted directly in
 * `__tests__/backend-supervisor.service.test.ts`.
 */
export const DEFAULT_INFERENCE_SUPERVISION_MODE: InferenceSupervisionMode = 'off';

/** Seconds between observation ticks while the mode is `'observe'`. */
export const DEFAULT_SUPERVISION_POLL_SECONDS = 30;
/**
 * Floor. Below this the health fan-out (six backends, several of them with multi-second HTTP
 * timeouts) can take longer than the interval, and ticks would stack.
 */
export const MIN_SUPERVISION_POLL_SECONDS = 10;
/** Ceiling. Past this the restart-delta window stops being a useful rate measurement. */
export const MAX_SUPERVISION_POLL_SECONDS = 300;

/**
 * Environment kill switch, following the `HUB_POOL_USER_DISABLED` / `PRIVATE_VPN_USER_DISABLED`
 * convention in {@link import('./hub-pool')}: the hub `.env` is loaded wholesale into the backend
 * container, so no compose change is needed to add one, and an operator-of-the-box decision must
 * win over a persisted setting.
 *
 * Deliberately NOT projected into `.env` by `generateSystemEnvFile`, for the same reason given
 * there: env-first precedence applied to the Hub's own persisted value would make the flag
 * permanent, and the setting could never be switched back on from the UI.
 */
export const INFERENCE_SUPERVISION_DISABLED_ENV_VAR = 'CI_HUB_INFERENCE_SUPERVISION_DISABLED';

/** Which switch turned observation off. `null` when it is on. */
export type InferenceSupervisionDisabledBy = 'env' | 'setting';

export interface InferenceSupervisionState {
  mode: InferenceSupervisionMode;
  disabledBy: InferenceSupervisionDisabledBy | null;
}

/**
 * Resolve the effective mode. The environment wins, and the two are reported separately rather
 * than collapsed into one value so the operator surface can say "disabled in the .env" instead of
 * showing a setting that silently does nothing.
 */
export function resolveInferenceSupervisionMode(persistedMode: InferenceSupervisionMode | undefined): InferenceSupervisionState {
  if (process.env[INFERENCE_SUPERVISION_DISABLED_ENV_VAR] === 'true') {
    return { mode: 'off', disabledBy: 'env' };
  }
  const mode = persistedMode ?? DEFAULT_INFERENCE_SUPERVISION_MODE;
  return { mode, disabledBy: mode === 'off' ? 'setting' : null };
}

/** Clamp a persisted poll interval into the supported range. */
export function clampSupervisionPollSeconds(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return DEFAULT_SUPERVISION_POLL_SECONDS;
  }
  return Math.min(Math.max(Math.round(seconds), MIN_SUPERVISION_POLL_SECONDS), MAX_SUPERVISION_POLL_SECONDS);
}

/**
 * The Hub's own Docker Compose project name, as written by
 * `DockerReadFacade.getHubRuntimeStats()` and by the compose files. The restart sweep is scoped to
 * this label rather than to the inference backends, which is the only reason it can see the
 * failure it was built for — `hub-tailscale` is a Hub stack service, not an inference engine.
 */
export const HUB_COMPOSE_PROJECT = 'ci-hub';

/**
 * Restarts accumulated *while this Hub was watching* that mean dockerd is looping a container.
 * Five in the alarm window is well past any legitimate transient: a healthy container restarts on
 * deploy and on host reboot, not five times an hour.
 */
export const EXTERNAL_RESTART_ALARM = 5;

/**
 * Absolute `RestartCount` that is an alarm on its own, with no history required.
 *
 * This is the half that would have caught the real incident. A delta-based alarm needs a baseline,
 * and a Hub that has just started has none — which is exactly the "supervisor with no memory across
 * its own restarts" property that let 97,000 restarts accumulate unnoticed. dockerd's
 * `RestartCount` is itself durable, so a container at 11,463 is legible on the very first sweep
 * after boot, before any delta exists. Fifty is far above anything an ordinary lifetime produces
 * and far below the counts these loops reach within a day.
 */
export const ABSOLUTE_RESTART_ALARM = 50;

/**
 * Minimum spacing between repeat alarms for the same container, so a loop that persists for a week
 * writes ~168 event-log rows rather than one per tick. A loop that keeps *growing* still re-alarms
 * sooner — see `evaluateRestartLoop`.
 */
export const RESTART_ALARM_REPEAT_MS = 60 * 60_000;

/** Growth since the last alarm that re-alarms before {@link RESTART_ALARM_REPEAT_MS} has elapsed. */
export const RESTART_ALARM_ESCALATION_STEP = 100;

/**
 * How long a restart delta is allowed to accumulate before the baseline is re-anchored. Without
 * this, a container that restarts twice a month reaches five eventually and reads as a loop.
 */
export const RESTART_ALARM_WINDOW_MS = 60 * 60_000;

/**
 * How long the GPU vendor is cached inside the observer.
 *
 * `HardwareInspectorService.getProfile()` re-runs the full `detect()` chain (nvidia-smi, rocm-smi,
 * system_profiler, `docker info`, each with its own timeout) whenever the discrete-GPU profile is
 * incomplete, which is common. The vendor is the only field the Lucebox diagnosis needs, it does
 * not change without a reboot, and it is read lazily — only once a legacy-image Lucebox container
 * has actually been seen — so no node without that container ever pays for it.
 */
export const SUPERVISION_GPU_VENDOR_TTL_MS = 30 * 60_000;
