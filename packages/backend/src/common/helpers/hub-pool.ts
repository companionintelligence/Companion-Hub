/** Which of the two kill switches turned Hub pooling off. `null` when it is on. */
export type HubPoolDisabledBy = 'env' | 'setting';

export interface HubPoolEnabledState {
  enabled: boolean;
  disabledBy: HubPoolDisabledBy | null;
}

/**
 * The two halves of pooling, which an operator can now switch independently.
 *
 * They are genuinely different decisions and were only ever coupled because there was one switch:
 * "stop spending my peers' GPU" (outbound) and "stop spending mine on my peers" (inbound) are the
 * two things people actually ask for, and a node that gives without taking is the normal shape of a
 * heterogeneous fleet.
 */
export type HubPoolDirection = 'outbound' | 'inbound';

export interface HubPoolDirectionalState {
  /** Whether this node may send work TO peers. */
  outbound: HubPoolEnabledState;
  /** Whether this node may serve work FOR peers. */
  inbound: HubPoolEnabledState;
}

/**
 * Environment overrides, one per switch. Read straight from `process.env` like
 * `HUB_POOL_USER_DISABLED`: the hub `.env` is loaded wholesale into the backend container
 * (`env_file` in docker-compose.prod.yml), so no compose change is needed to add one.
 *
 * None of them may be projected into `.env` by `generateSystemEnvFile`, for the reason documented
 * on {@link resolveHubPoolEnabled}: env-first precedence would make the flag permanent and the
 * operator could never switch it back from the UI.
 */
export const HUB_POOL_DISABLED_ENV_VAR = 'HUB_POOL_USER_DISABLED';
export const HUB_POOL_OUTBOUND_DISABLED_ENV_VAR = 'HUB_POOL_OUTBOUND_DISABLED';
export const HUB_POOL_INBOUND_DISABLED_ENV_VAR = 'HUB_POOL_INBOUND_DISABLED';

/**
 * Multi-Hub inference pooling kill switch. Existing pairing state is unaffected —
 * this gates whether a connected peer is treated as usable
 * (`HubPoolPeerService.hasConnectedPeers`), whether this node still answers peer
 * capability probes, and whether it accepts new pairing requests, so a disabled
 * Hub stops routing through the pool and naturally reads as unreachable to its
 * peers.
 *
 * Two switches, and the environment wins. `HUB_POOL_USER_DISABLED=true` in the hub
 * `.env` (matching the `PRIVATE_VPN_USER_DISABLED` convention) is an operator-of-the-box
 * decision that a UI toggle must not be able to undo; the persisted `hubPoolEnabled`
 * setting is the in-product switch and is opt-out, so `undefined` means on. The two are
 * reported separately rather than collapsed into one boolean precisely so the UI can say
 * "disabled in the .env" instead of showing a toggle that silently does nothing.
 *
 * Deliberately NOT projected into `.env` by `generateSystemEnvFile`: routing the setting
 * through `HUB_POOL_USER_DISABLED` would make `resolve()`'s env-first precedence apply to
 * the Hub's own persisted value, and the operator could never turn pooling back on from
 * the UI once the flag had been written to disk.
 */
export function resolveHubPoolEnabled(persistedEnabled: boolean | undefined): HubPoolEnabledState {
  if (process.env[HUB_POOL_DISABLED_ENV_VAR] === 'true') {
    return { enabled: false, disabledBy: 'env' };
  }
  if (persistedEnabled === false) {
    return { enabled: false, disabledBy: 'setting' };
  }
  return { enabled: true, disabledBy: null };
}

/** {@link resolveHubPoolEnabled} when only the yes/no answer is wanted. */
export function isHubPoolEnabled(persistedEnabled?: boolean): boolean {
  return resolveHubPoolEnabled(persistedEnabled).enabled;
}

/**
 * The effective state of each direction, and this file is the ONLY place that decides it.
 *
 * Precedence, highest first, per direction:
 *  1. `HUB_POOL_USER_DISABLED=true` — master, both directions off, `disabledBy: 'env'`.
 *  2. persisted `poolEnabled === false` — master, both directions off, `disabledBy: 'setting'`.
 *  3. `HUB_POOL_{OUTBOUND,INBOUND}_DISABLED=true` — that direction off, `'env'`.
 *  4. persisted `pool{Outbound,Inbound}Enabled === false` — that direction off, `'setting'`.
 *  5. otherwise on.
 *
 * The master short-circuits both directions rather than being folded in per-axis, so an operator
 * who turns pooling off never has to reason about what the directional switches were left at. Every
 * new switch is opt-out (`undefined` = on), so an untouched `settings.json` and an untouched `.env`
 * resolve to exactly today's behaviour on both axes.
 *
 * Callers must not re-derive any of this: `HubPoolPeerService.directions()` and
 * `PoolProxyService` both read the answer from here, and the truth table is pinned in
 * `__tests__/hub-pool.test.ts`.
 */
export function resolveHubPoolDirections(
  prefs: Pick<HubPoolPreferences, 'poolEnabled' | 'poolOutboundEnabled' | 'poolInboundEnabled'>,
): HubPoolDirectionalState {
  const master = resolveHubPoolEnabled(prefs.poolEnabled);
  if (!master.enabled) {
    return { outbound: { ...master }, inbound: { ...master } };
  }
  return {
    outbound: resolveDirection(HUB_POOL_OUTBOUND_DISABLED_ENV_VAR, prefs.poolOutboundEnabled),
    inbound: resolveDirection(HUB_POOL_INBOUND_DISABLED_ENV_VAR, prefs.poolInboundEnabled),
  };
}

function resolveDirection(envVar: string, persisted: boolean | undefined): HubPoolEnabledState {
  if (process.env[envVar] === 'true') {
    return { enabled: false, disabledBy: 'env' };
  }
  if (persisted === false) {
    return { enabled: false, disabledBy: 'setting' };
  }
  return { enabled: true, disabledBy: null };
}

/**
 * Message for a 503 refusing a peer because pooling is off here. Names the switch that is actually
 * responsible: an operator told "set HUB_POOL_USER_DISABLED" when the real cause is the UI toggle
 * would go looking in the wrong file.
 */
export function describeHubPoolDisabled(disabledBy: HubPoolDisabledBy | null): string {
  return disabledBy === 'setting'
    ? 'Hub pooling is disabled on this node (turned off in Settings → Network → Hub Pool)'
    : `Hub pooling is disabled on this node (${HUB_POOL_DISABLED_ENV_VAR})`;
}

/**
 * Why this node is refusing a peer's *work* while still being in the pool.
 *
 * Deliberately worded apart from {@link describeHubPoolDisabled}: the master switch means "I have
 * left the pool" and answers 503 on the capability probe so peers mark this node unreachable, while
 * these two mean "I am still here, still using you, just not serving right now" — which is a live,
 * healthy node the peer must keep polling. The 503 on `/local/*` exists only so a request already
 * in flight against a cached snapshot fails over instead of hanging.
 */
export function describeHubPoolInboundRefused(reason: HubPoolInboundRefusal): string {
  return reason === 'peer_disabled'
    ? 'This node is not exchanging work with your node right now (the operator disabled this peer here)'
    : 'This node is not accepting pooled work right now (inbound pooling is switched off here)';
}

/** Which of the two finer switches is refusing a peer's work. Never the master, which 503s instead. */
export type HubPoolInboundRefusal = 'inbound_disabled' | 'peer_disabled';

/**
 * The head start the local node gets over a peer, in queued requests.
 *
 * This is a real advantage, not favouritism: a follow-up turn served here reuses the prompt prefix
 * and KV cache the previous turn left resident, while the same turn sent to a peer re-processes the
 * whole prompt cold. One queued request is roughly what that re-processing costs, so work only
 * leaves this node once a peer is at least that much emptier. Higher values make handoff rarer
 * (stickier to local).
 *
 * At 0 the pool ranks purely by queue depth, with one documented exception: an *exact* score tie
 * still goes to local, because `LOCAL_TIER_RANK` beats every peer tier. That is the right
 * behaviour — a free local node has no hop and a warm cache — but it is a tie-break, not a
 * handicap, so "0 = pure least-loaded" overstated it and this says what actually happens.
 */
export const DEFAULT_POOL_LOCAL_AFFINITY = 1;
/**
 * Stays at 0 for now, deliberately.
 *
 * A negative floor ("this node is the weak one — prefer the peer") is the one thing the scale
 * cannot express, and the formula already handles it: `peerScore = peerLoad + affinity` sorts
 * negatives correctly with no ranking change at all. What blocks it is the rollback direction. The
 * bounds are build constants, so a Hub that saved -5 and then rolls back one build would have
 * persisted a value the older build rejects, and the settings-parse hardening that degrades such a
 * value to the default fixes forwards, not backwards. Widen this one release after that degrade is
 * on every fleet node; nobody has asked to prefer peers over local, so waiting costs nothing.
 */
export const MIN_POOL_LOCAL_AFFINITY = 0;
/** Above this the local node effectively never hands off, which is indistinguishable from disabling the pool — use the kill switch for that instead. */
export const MAX_POOL_LOCAL_AFFINITY = 20;

/**
 * The GPU-pressure band a node is assumed to be at when nothing could measure it.
 *
 * Deliberately not 0, and for exactly the reason `UNKNOWN_PEER_LOAD` is not 0: the pool must never
 * be able to make a node MORE attractive by failing to report. On this fleet most nodes cannot
 * measure at all (the signal is AMD-only), so "unmeasured" is the common case, not the exception —
 * if it read as idle the default deployment would route every tie to whichever machine knows least
 * about itself. Mid-band is the only honest answer to "I don't know".
 */
export const UNKNOWN_PRESSURE = 1;

/** Bands run 0 (idle) to 3 (saturated), matching the shape NVIDIA's PAIR publishes. */
export const MAX_PRESSURE_BAND = 3;

/**
 * A peer's self-reported band, reduced to something the ranker may use, or `null` for "unmeasured".
 *
 * This runs on the READ path, not only where the value is written, because `last_capabilities` is
 * free-form jsonb a paired peer fully controls and rows can predate any write-side check. `-5`,
 * `99`, `1.5`, `'low'`, `null`, `NaN` and a missing key all land on `null` here, which every caller
 * then reads as {@link UNKNOWN_PRESSURE}. Same never-optimistic rule `tierRank` already applies to
 * an unrecognised `hardwareTier`.
 */
export function clampPressureBand(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= MAX_PRESSURE_BAND ? raw : null;
}

/**
 * Whether a peer's cached capability snapshot is recent enough to believe.
 *
 * Judged on `lastSeenAt`, stamped by OUR clock when the probe succeeded, never on the peer's own
 * `capabilities.updatedAt` — comparing another machine's clock to ours would read skew as staleness
 * (or, worse, staleness as freshness). Extracted here so the queue-depth reader and the pressure
 * reader cannot drift apart on what "stale" means; they are two fields of one snapshot.
 */
export function isCapabilitiesSnapshotFresh(lastSeenAt: string | null, freshnessMs: number, now: number = Date.now()): boolean {
  const observedAt = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
  return Number.isFinite(observedAt) && now - observedAt <= freshnessMs;
}

/**
 * The pressure band this node will actually rank a peer at, or `null` when nothing is known.
 *
 * Mirrors {@link clampPressureBand} and `PoolProxyService.peerLoad` in one place so `/pool/status`
 * shows the operator the number routing actually believes, rather than the raw jsonb.
 *
 * `forwardedInFlight` is the floor, and it is the whole anti-gaming story: the band is otherwise
 * purely self-reported, so a peer that pins `gpuPressure: 0` forever would win every tie forever.
 * What we have handed it and not yet finished reading is the one part of its GPU load we can
 * observe ourselves — a peer running three of our requests is not at band 0 whatever it claims.
 * Taking the larger of the two (rather than the sum) is the same reasoning as `peerLoad`: both
 * numbers describe the same work from different vantage points.
 *
 * A stale snapshot discards the peer's claim but keeps the floor, again exactly as `peerLoad` does.
 */
export function effectivePeerPressureBand(params: { reported: unknown; snapshotFresh: boolean; forwardedInFlight: number }): number | null {
  const claimed = params.snapshotFresh ? clampPressureBand(params.reported) : null;
  const floor = Math.min(MAX_PRESSURE_BAND, Math.max(0, Math.trunc(params.forwardedInFlight) || 0));
  if (claimed === null && floor === 0) {
    return null;
  }
  return Math.max(claimed ?? 0, floor);
}

/**
 * The coarse, name-free container picture a node publishes to its paired peers.
 *
 * Counts and aggregate resources ONLY, and that is the disclosure decision rather than a first
 * cut: a peer learns how loaded a box is and never which applications it runs. Model ids are
 * already shared by name because models are what the pool OFFERS — a peer cannot rank us without
 * them. Containers are not offered to anyone, so every field here is a number.
 *
 * Scope is the containers THIS HUB MANAGES — the compose projects `AppRuntimeMonitorService`
 * already samples — never the whole Docker daemon. A container someone started by hand outside
 * compose is invisible to the sampler and is therefore absent from these totals.
 *
 * `stopped` is defined as `total - running`, so the two always sum. Docker's own state enum is
 * wider than that (`created`, `restarting`, `paused`, `removing`, `dead`), and everything that is
 * not `running` lands in `stopped` because the question a health signal answers is "how much of
 * this box is doing work". Note also that `docker compose down` REMOVES containers, so a torn-down
 * app contributes nothing at all rather than counting as stopped.
 */
export interface PoolContainerRollup {
  /** Containers in Docker's `running` state. */
  running: number;
  /** Containers that exist but are not running — `total - running`, see the note above. */
  stopped: number;
  /** Containers the reporting node manages, running or not. */
  total: number;
  /** Summed CPU percentage across those containers. Per-core, so a busy multi-core box exceeds 100. */
  cpuPercent: number;
  /** Summed resident memory across those containers, in bytes. */
  memoryBytes: number;
}

/** Above this a "count" is a typo or a lie; no Hub manages ten thousand containers. */
export const MAX_REPORTED_CONTAINERS = 10_000;
/** 100% x 1024 cores. Nothing this fleet runs has more, and a larger figure is not a busy box, it is a broken one. */
export const MAX_REPORTED_CONTAINER_CPU_PERCENT = 102_400;
/** 1 PiB of resident memory. Same reasoning as the CPU ceiling. */
export const MAX_REPORTED_CONTAINER_MEMORY_BYTES = 2 ** 50;

function clampCount(raw: unknown, max: number): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= max ? raw : null;
}

function clampGauge(raw: unknown, max: number): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= max ? raw : null;
}

/**
 * A peer's self-reported container rollup, reduced to something an operator surface may render, or
 * `null` for "not reported".
 *
 * Runs on the READ path, exactly like {@link clampPressureBand} and for the same reason:
 * `last_capabilities` is free-form jsonb that a paired peer fully controls, and rows can predate
 * any write-side check we add. A peer is a remote machine, so `-1`, `1.5`, `NaN`, `Infinity`,
 * `'lots'`, an array, and a missing key all land on `null` here rather than on a dashboard.
 *
 * All-or-nothing, deliberately: one bad field rejects the whole object instead of being replaced
 * with a plausible substitute. A rollup whose count survived and whose memory figure did not is a
 * half-truth that reads as fact, and there is no honest value to put in the gap — `null` says "not
 * reported", which is the only thing we actually know. `running` or `stopped` exceeding `total` is
 * rejected on the same grounds; the exact sum is NOT required, so a future build that buckets the
 * wider state enum differently degrades to a believable rollup rather than to nothing.
 *
 * Never maps a rejected value to 0. Zero is a claim ("nothing is running here") and this function
 * only ever sees values it could not believe.
 */
export function clampContainerRollup(raw: unknown): PoolContainerRollup | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const reported = raw as Record<string, unknown>;
  const running = clampCount(reported.running, MAX_REPORTED_CONTAINERS);
  const stopped = clampCount(reported.stopped, MAX_REPORTED_CONTAINERS);
  const total = clampCount(reported.total, MAX_REPORTED_CONTAINERS);
  const cpuPercent = clampGauge(reported.cpuPercent, MAX_REPORTED_CONTAINER_CPU_PERCENT);
  const memoryBytes = clampGauge(reported.memoryBytes, MAX_REPORTED_CONTAINER_MEMORY_BYTES);
  if (running === null || stopped === null || total === null || cpuPercent === null || memoryBytes === null) {
    return null;
  }
  if (running > total || stopped > total) {
    return null;
  }
  return { running, stopped, total, cpuPercent, memoryBytes };
}

/**
 * Whatever can hand the pool an already-collected container rollup for THIS node.
 *
 * `AppRuntimeMonitorService` is the only implementation and lives in `AppsModule`, which the pool
 * module does not (and should not) import: the edge would close a second Nest cycle and drag the
 * entire apps graph — marketplace, queue, registration, portal — into the pool's. So the pool
 * resolves this token through `ModuleRef` with `strict: false`, the same lazy-lookup shape
 * `AppsService` uses for `TunnelHealthService` and `HubAccessService` for the auth resolver.
 *
 * The token and the interface live here, in a leaf helper with no imports of its own, so that
 * `AppsModule` can provide them without importing anything from `modules/hub-pool`.
 */
export const POOL_CONTAINER_SAMPLER = 'POOL_CONTAINER_SAMPLER';

export interface PoolContainerSampler {
  /**
   * The last ALREADY-COLLECTED sample, or `null` when there is nothing recent enough to publish.
   *
   * Must never probe: this is called on the route answering every peer's health poll. `null` is
   * what a node that has not sampled yet, or whose sampling is failing, reports — and the pool
   * turns that into an omitted key, never into zeros.
   */
  containerRollup(now?: number): PoolContainerRollup | null;
}

/**
 * How much the 0-3 GPU-pressure band contributes to a candidate's score.
 *
 * Zero, deliberately, and that is not timidity: at 0 the pressure key is not in the comparator at
 * all and the score term vanishes, so ranking is bit-for-bit what the previous build produced on
 * every node — measured or not. The band is unvalidated on real fleet hardware, and the honest
 * order is to ship the measurement, watch `/pool/status` for a week, then flip the default.
 *
 * At 1 this is PAIR verbatim (`pending + pressure`), which is what lets the pool move work off a
 * node whose queue is empty but whose GPU is committed to something that never came through the
 * pool — ComfyUI, a direct `ollama run`, another orchestrator on a shared host engine.
 */
export const DEFAULT_POOL_PRESSURE_WEIGHT = 0;
export const MIN_POOL_PRESSURE_WEIGHT = 0;
/** Above 3 one band outweighs the entire 0-3 scale plus a full queue, which is a kill switch spelled badly. */
export const MAX_POOL_PRESSURE_WEIGHT = 3;

/**
 * The per-node prompt ceiling: the largest estimated prompt, in tokens, this node should SERVE for
 * the pool while another candidate can take the request instead.
 *
 * It exists because prefill on a CPU-bound node slows as the context grows, and no other routing
 * control can see prompt size. Measured on fzzy, 2026-09-17, which serves `qwen3-coder:30b` entirely
 * on CPU: a 40 KB (~10.6k-token) streamed turn prefilled at ~123 tok/s and answered in 103 s, while a
 * 184 KB (~46k-token) turn produced no first byte inside its 922 s body-sized budget and was
 * cancelled — below the 50 tok/s floor that budget assumes. core-6, a GPU node, served the same turn
 * in 268 s. Pins are `prefer`-only and the ranker weighs queue depth and tier, so until this an
 * operator had no way to say "not the long ones".
 *
 * A preference, like a pin, never a refusal: when every candidate is over its ceiling the request is
 * placed anyway, because a slow answer beats a 502. That is also why it is applied by the ENTRY node
 * rather than by the serving node refusing work — only the entry node knows whether there was
 * anywhere else to send it.
 *
 * `null` (the default) is no ceiling, and so is an absent key on the wire, so an untouched node and a
 * peer on an older build route exactly as before.
 */
export const HUB_POOL_MAX_PROMPT_TOKENS_ENV_VAR = 'HUB_POOL_MAX_PROMPT_TOKENS';
/**
 * Below this nearly every agent request is over the ceiling — a system prompt and a few tool schemas
 * already are — which is "stop serving the pool" spelled badly, and a dropped `000` from `16000` is
 * the likelier explanation. Inbound pooling has its own switch for the first case.
 */
export const MIN_POOL_MAX_PROMPT_TOKENS = 1024;
/** 2^20: past the longest context window any engine on this fleet offers, so a higher ceiling could never exclude anything. */
export const MAX_POOL_MAX_PROMPT_TOKENS = 1_048_576;

/**
 * A ceiling as this build will believe it, or `null` for "no ceiling".
 *
 * Runs on the READ path for the same reason {@link clampPressureBand} does: a peer's advertised
 * value is free-form jsonb it controls. Anything but an in-range integer reads as no ceiling. There
 * is no anti-gaming concern to answer here — a ceiling can only get its own node LESS work, which
 * `acceptingWork: false` already allows — so the clamp exists to stop a malformed value from
 * excluding a node, not out of distrust.
 */
export function clampPromptCeiling(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= MIN_POOL_MAX_PROMPT_TOKENS && raw <= MAX_POOL_MAX_PROMPT_TOKENS ? raw : null;
}

/** This node's effective prompt ceiling, and which of the two sources set it. */
export interface HubPoolPromptCeilingState {
  maxPromptTokens: number | null;
  setBy: 'env' | 'setting' | null;
}

/**
 * The effective local ceiling. `HUB_POOL_MAX_PROMPT_TOKENS` wins over the persisted setting, like
 * every other `HUB_POOL_*` override, and is reported apart from it so a settings surface can say
 * "the .env sets this" instead of showing a value that appears to do nothing.
 *
 * An unparseable or out-of-range env value is ignored rather than guessed at: quietly excluding this
 * node from long prompts because of a typo in `.env` is the worse failure, and the setting (or no
 * ceiling) still applies. Like the kill switches, never projected into `.env` by
 * `generateSystemEnvFile` — env-first precedence would make the stored value unchangeable afterwards.
 */
export function resolvePoolMaxPromptTokens(
  persisted: number | null | undefined,
  envValue: string | undefined = process.env[HUB_POOL_MAX_PROMPT_TOKENS_ENV_VAR],
): HubPoolPromptCeilingState {
  const fromEnv = envValue?.trim() ? clampPromptCeiling(Number(envValue.trim())) : null;
  if (fromEnv !== null) {
    return { maxPromptTokens: fromEnv, setBy: 'env' };
  }
  const fromSetting = clampPromptCeiling(persisted);
  return fromSetting === null ? { maxPromptTokens: null, setBy: null } : { maxPromptTokens: fromSetting, setBy: 'setting' };
}

/**
 * How long a local engine's health answer is reused for placement before the next pooled request
 * triggers a fresh probe.
 *
 * Every pooled request used to run six live health probes before ranking, each with a 5 s
 * transport timeout. On a node whose firewall drops (rather than refuses) the Hub container's SYN
 * to an engine port, that put a flat 5.0 s in front of every request entering the node — measured
 * pool TTFT 5035–5200 ms on four of fifteen fleet nodes against 22–100 ms once the port answered —
 * for engines that were never going to be candidates. The snapshot moves that wait off the request
 * path: a request reads the last answer, and the probe that refreshes it runs behind the caller.
 *
 * The value only changes WHEN an engine's answer is read, never what the answer means: with every
 * probe answering, the candidate list is the one the live probes produced, in the same order. The
 * cost is that an engine coming up, going down, or clearing a quarantine on its own is seen up to
 * one TTL late — failover already covers the second, and the first two are rare next to a request.
 *
 * Zero, deliberately, the same way `DEFAULT_POOL_PRESSURE_WEIGHT` is: at 0 the snapshot is not
 * consulted at all and every request probes live, so a node that takes this image without an
 * operator touching the setting ranks byte for byte as the build before the snapshot existed — the
 * 5 s stall included. The snapshot is validated one node at a time: PATCH
 * `poolProbeSnapshotTtlMs` to 10000 on the canary, measure it against a node still at 0, and flip
 * this default once the fleet has seen it. 10 s sits under the 20 s this node's own inventory is
 * already cached for when it answers a peer's health poll, so a local candidate is never staler
 * than the same node's advertisement to the rest of the pool.
 */
export const DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS = 0;
/** `0` disables the snapshot; there is no shorter TTL worth having, because a request would then pay the probe anyway. */
export const MIN_POOL_PROBE_SNAPSHOT_TTL_MS = 0;
/** Five minutes: past this an engine that came up is invisible to the pool for longer than an operator will wait before restarting things. */
export const MAX_POOL_PROBE_SNAPSHOT_TTL_MS = 300_000;

/**
 * How many requests the node that last served a prompt prefix may have in flight — counting the one
 * being placed — and still be preferred for the next request carrying the same prefix.
 *
 * Prefill dominates an agent turn on this fleet. Measured on core-2 through the pool proxy,
 * 2026-09-20: OpenClaw's first turn was 44,340 prompt tokens, 258 output, 100.8 s wall, and Ollama's
 * journal put `prompt processing` at 67.34 s (608 tok/s). The agent's second model call in the same
 * turn (44,630 tokens, same prefix) got only a partial cache hit — `cached n_tokens = 15958`, 28,672
 * tokens re-prefilled in 63 s — because the four Ollama slots (`OLLAMA_NUM_PARALLEL=4`, fleet-wide)
 * are shared with other traffic and the pool had no notion of which node held a session's prefix.
 * Affinity remembers the node and engine that last served each prefix and moves them to the front
 * of the ranked list while their queue is shorter than this, because past that point waiting behind
 * the queue costs more than the ~60 s of re-prefill it would save.
 *
 * A preference, never a rule: the remembered node is moved to the front of the list the ranker built,
 * so a node the pool excluded is never resurrected, an operator pin still wins, and failover is what
 * it was. Zero, deliberately, the same way `DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS` and
 * `DEFAULT_POOL_PRESSURE_WEIGHT` are: at 0 no prefix is hashed or remembered and ranking is byte for
 * byte the build before affinity existed, so the canary node that PATCHes
 * `poolPrefixAffinityMaxInFlight` to 2 can be measured against a node that took the same image and
 * nothing else. 2 is the value to validate at: the remembered node takes the request when it is idle
 * or has one other request in flight, and hands it on when it has two or more.
 */
export const DEFAULT_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT = 0;
/** `0` turns affinity off; the request being placed always counts, so there is no lower value that would ever prefer anything. */
export const MIN_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT = 0;
/** Same bound as `MAX_POOL_LOCAL_AFFINITY`: past this queue depth the wait behind it dwarfs any prefill saved. */
export const MAX_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT = 20;

/**
 * Whether placement reads each Ollama candidate's advertised slot count (`inferenceOllamaSlots`, the
 * operator's statement of its `OLLAMA_NUM_PARALLEL`) and puts a candidate whose queue already fills
 * its slots behind every candidate that still has one free.
 *
 * Queue depth alone cannot see this. Ollama serves `OLLAMA_NUM_PARALLEL` requests at once and queues
 * the rest behind them, so two in flight is a full engine on a 2-slot node and half of one on a
 * 4-slot node, and the ranker scores both the same. Measured 2026-09-21 (fleet-qa B5 cell, 4-way
 * bursts): the nodes moved to 2 slots queued requests behind Ollama for 5–10 s to the first token —
 * beta-max 0.47 s → 9.0 s — while 4-slot nodes sat idle, and the fleet aggregate at c=4 fell
 * 14–16 %. A full node is demoted, never removed: failover still reaches it, a pin still applies
 * within each group, and when every candidate is full nothing moves — see `applySlotPlacement`.
 *
 * Zero, deliberately, the same way `DEFAULT_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT` and
 * `DEFAULT_POOL_PRESSURE_WEIGHT` are: at 0 no slot count is read and ranking is byte for byte the
 * build before slots existed, so the canary node that PATCHes `poolSlotAwareness` to 1 can be
 * measured against a node that took the same image and nothing else. There is no weight to tune —
 * a slot is either free or it is not — so the knob is a switch that keeps the numeric shape of the
 * others.
 */
export const DEFAULT_POOL_SLOT_AWARENESS = 0;
/** `0` is off. */
export const MIN_POOL_SLOT_AWARENESS = 0;
/** `1` is on; there is no stronger form, because the demotion is already a whole ordering step rather than a weight. */
export const MAX_POOL_SLOT_AWARENESS = 1;

/** How often each `connected`/`unreachable` peer is probed for capabilities. */
export const DEFAULT_POOL_HEALTH_POLL_SECONDS = 30;
/** Below this the probes cost more than the routing accuracy they buy, and an 8s probe timeout would start overlapping ticks. */
export const MIN_POOL_HEALTH_POLL_SECONDS = 10;
/** Above this a peer can be down for over 15 minutes (three strikes) before it stops being offered as a candidate. */
export const MAX_POOL_HEALTH_POLL_SECONDS = 300;

/**
 * How many health polls a peer's capability snapshot stays trusted for, after which its
 * self-reported load is discarded and it ranks as mid-load. Matches the three strikes that mark a
 * peer unreachable — a peer still `connected` but two polls behind is exactly the case this covers.
 * Expressed in polls rather than milliseconds so it tracks a retuned poll interval automatically.
 */
export const CAPABILITIES_FRESHNESS_POLLS = 3;

/** Operator-editable pool tuning, resolved against the DEFAULT_POOL_* constants. */
export interface HubPoolPreferences {
  /** The persisted half of the kill switch only — pass it through {@link resolveHubPoolEnabled} to get the effective state. */
  poolEnabled: boolean;
  /**
   * The persisted half of the outbound switch only. Absent in `settings.json` means on, and the
   * master switch above overrides it — resolve both through {@link resolveHubPoolDirections}.
   */
  poolOutboundEnabled: boolean;
  /** The persisted half of the inbound switch only. Same resolution rule as `poolOutboundEnabled`. */
  poolInboundEnabled: boolean;
  poolLocalAffinity: number;
  poolHealthPollSeconds: number;
  /**
   * Refuse the legacy bearer-token branch outright, on the guard AND on the outbound client.
   *
   * The explicit "no downgrade path" switch, and DEFAULT FALSE because turning it on across a
   * mixed-version fleet is an outage: any peer that has not yet completed the bearer→signed upgrade
   * stops authenticating in both directions the moment it is set. Flip it once
   * `GET /inference/pool/status` shows every peer with `authMode: 'signed'`.
   */
  poolRequireSignedPeers: boolean;
  /**
   * Publish this node's aggregate container counts and resource totals to paired peers.
   *
   * DEFAULT TRUE, so an untouched settings.json starts reporting on upgrade, and it is the operator
   * who opts OUT. The trade is real and goes this way for two reasons. The audience is not the
   * internet: it is machines this operator personally approved into a pairing, mutually
   * authenticated, that already receive this node's hardware tier, queue depth and the NAMES of
   * every model it holds — five aggregate numbers are strictly less revealing than the inventory
   * already on that wire. And defaulting off would leave every peer reading "not reported" until
   * each operator flips a switch on each node, which is indistinguishable from an old build and
   * makes the fleet view the field exists for permanently empty on an upgraded fleet.
   *
   * Off does not send zeros. It OMITS the key, which is the same thing a pre-container build sends
   * and reads as "we cannot tell you" — see `PoolPeerCapabilities.containers`.
   */
  poolShareContainerStats: boolean;
  /** How heavily the GPU-pressure band counts in candidate ranking. 0 (the default) keeps ranking byte-identical to the pre-pressure build. */
  poolPressureWeight: number;
  /**
   * The persisted prompt ceiling only, `null` for none. `HUB_POOL_MAX_PROMPT_TOKENS` overrides it, so
   * resolve the two through {@link resolvePoolMaxPromptTokens} rather than reading this as effective.
   */
  poolMaxPromptTokens: number | null;
  /** How long a local engine's health answer is reused for placement; `0` (the default) probes live on every request. See {@link DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS}. */
  poolProbeSnapshotTtlMs: number;
  /** The queue depth up to which the node that last served a prompt prefix is preferred for it, counting the request being placed; `0` (the default) turns affinity off. See {@link DEFAULT_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT}. */
  poolPrefixAffinityMaxInFlight: number;
  /** Whether an Ollama candidate whose queue fills its advertised slots is placed behind every candidate with a free one; `0` (the default) keeps slots out of ranking entirely. See {@link DEFAULT_POOL_SLOT_AWARENESS}. */
  poolSlotAwareness: number;
  /**
   * Operator routing overrides, newest last. Empty (the default) means the ranker decides alone and
   * routing is byte-identical to a build without pinning — see {@link resolvePinFor}.
   */
  poolPins: HubPoolPin[];
  /**
   * Hand every app this Hub's own proxy (`/api/inference/pool`) as its inference endpoint even
   * when no peer is paired, instead of the backend's direct URL.
   *
   * DEFAULT TRUE. With the direct URL, each app talks to the engine on its own and none of them
   * can see the others: measured 2026-09-17, one app's hourly heartbeat asked for a second model
   * at a 64k window and evicted the 27B every other app was using, three to six reloads per tick.
   * Through the proxy every request crosses one place that knows what is resident, what the card
   * holds, and what the operator pinned — {@link InferenceRouterService.prepareTrackedModel} — and
   * a single-node Hub degrades to exactly the direct call (`proxyLocalOnlyRequest` tries this
   * node's own engines in order). Off restores the pre-proxy behaviour: direct URL unless a peer
   * is connected. Takes effect the next time an app's environment is generated.
   */
  poolRouteAppsAlways: boolean;
}

/**
 * How long a row that has just pinned a peer's key keeps honouring that peer's bearer token while
 * waiting for evidence the peer really did upgrade.
 *
 * Derived from the poll cadence rather than fixed, so an operator who slowed the health poll to its
 * 300s maximum still gets four polls' worth of chances before the pinning is rolled back and
 * retried. The 10-minute floor is what a default-cadence fleet gets.
 */
export function bearerUpgradeGraceMs(poolHealthPollSeconds: number): number {
  return Math.max(600_000, poolHealthPollSeconds * 1000 * 4);
}

const MAX_FQDN_LENGTH = 253;
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Canonicalizes a peer node FQDN, or returns `null` when the value is anything
 * but a bare multi-label hostname.
 *
 * A peer FQDN is both the unique key of its `hub_pool_peer` row and the host
 * this Hub interpolates into `https://<fqdn>/api/inference/pool/...` on every
 * handshake and health call, and pairing requests arrive unauthenticated — so a
 * value carrying a scheme, credentials, port, path, query or fragment would let
 * the requester choose where those calls (and the token they carry) go. Only the
 * MagicDNS shape Tailscale actually hands out is accepted; IP literals are
 * refused as well, since the tailnet name is the trust anchor and an address
 * bypasses the hostname-based TLS check.
 */
export function normalizePeerFqdn(raw: string): string | null {
  // A single trailing dot is the legal absolute-DNS form of the same name; anything else
  // (empty labels, leading dots) falls out of the per-label check below.
  const candidate = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!candidate || candidate.length > MAX_FQDN_LENGTH) {
    return null;
  }

  const labels = candidate.split('.');
  if (labels.length < 2 || !labels.every((label) => HOSTNAME_LABEL.test(label))) {
    return null;
  }
  // `1.2.3.4` and `12345.67890` pass the label check but are addresses, not names.
  if (/^\d+$/.test(labels[labels.length - 1] as string)) {
    return null;
  }

  return candidate;
}

/**
 * Headers a reverse proxy in front of the Hub adds and a caller cannot remove.
 *
 * `cf-ray` is already the Hub's established "arrived through the Cloudflare tunnel" signal (see
 * `AuthController.isTunnelRequest`); the rest are the same marker under Cloudflare's other names.
 * `x-forwarded-for` is deliberately NOT in this list — it is caller-controlled, so its presence
 * proves nothing on its own and callers handle it with their own rules (`internalOriginRefusal` in
 * `request-origin.ts` walks every hop; {@link callerSourceIp} treats it as one more reason not to
 * trust `req.ip`).
 */
export const TUNNEL_MARKER_HEADERS = ['cf-ray', 'cf-connecting-ip', 'cf-visitor', 'true-client-ip'] as const;

/**
 * The caller's own address, or `undefined` when this Hub cannot honestly say what it is.
 *
 * `request.ip` is NOT the caller behind Traefik or the Cloudflare tunnel: it is the proxy's own
 * private address, because Express `trust proxy` is left unset by default (`HUB_TRUST_PROXY`, see
 * main.ts, and the same caveat is written on `InternalNetworkGuard` and `internalOriginRefusal`). A
 * "per-source" rate limit keyed on that value is keyed on ONE value for every caller in the world —
 * a global limit wearing a per-source costume. For the pairing PIN that is worse than useless: the
 * PIN's real defence is its own attempt ceiling, and a global lockout would hand any caller that
 * can reach the tunnel a way to stop the operator pairing at all, which is exactly the failure mode
 * `HubPoolPairingPinService` says it is avoiding.
 *
 * So the address is returned only in the two cases where it really is the caller's:
 *   - `HUB_TRUST_PROXY` is set — Express has resolved the forwarded chain, so `request.ip` IS the
 *     client, and this becomes the meaningful defence-in-depth the variable exists to enable.
 *   - the request carries no proxy provenance at all — nothing sat in front of it, so `request.ip`
 *     is the client. This is the LAN and tailnet case, which is how pool peers actually arrive.
 *
 * Otherwise: `undefined`, and the caller keys its limiter on whatever else it has. Refusing to
 * guess is the point — a wrong key is not a weaker limit, it is a different limit on a different
 * thing.
 */
export function callerSourceIp(
  request: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  trustProxy: string | undefined = process.env.HUB_TRUST_PROXY,
): string | undefined {
  if (!request.ip) {
    return undefined;
  }
  if (trustProxy?.trim()) {
    return request.ip;
  }
  const headers = request.headers ?? {};
  for (const header of TUNNEL_MARKER_HEADERS) {
    if (headers[header]) {
      return undefined;
    }
  }
  return headers['x-forwarded-for'] ? undefined : request.ip;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual node pinning
//
// An operator's routing preference: "send this model to core-1", "keep everything here". Stored in
// `HubPoolPreferences` (settings.json) rather than a table, and read on the request path like every
// other pool setting, so a change takes effect on the next request with no app restart and no
// per-request database read on the inference hot path.
// ─────────────────────────────────────────────────────────────────────────────

/** A pin's reach: the pool-wide fallback, or one exact model id. */
export type PoolPinScope = 'default' | 'model';

/**
 * How hard a pin binds — `prefer` and nothing else, and that is a decision rather than a first
 * increment.
 *
 * A hard `require` was designed and cut. With a default-scope `require` pin at a peer, every app
 * still discovers *this* node's model list from `proxyLocalOnlyRequest` (`/v1/models`, `/api/tags`)
 * and then gets an unfailoverable 502 for every model the peer does not have — embeddings included,
 * because `CI_OLLAMA_EMBED_HOST` points at the same pool URL. It also converts a peer outage into a
 * 15-second hang per request for the whole 90 s-15 min window before the
 * unreachable threshold trips, while the pin still reads as healthy on the status card. `prefer`
 * covers every use case anyone has asked for and cannot take inference down.
 */
export type PoolPinMode = 'prefer';

/** The only mode there is. Named so the DTO, the service default and the UI cannot drift. */
export const DEFAULT_POOL_PIN_MODE: PoolPinMode = 'prefer';
export const POOL_PIN_MODES = ['prefer'] as const;
export const POOL_PIN_SCOPES = ['default', 'model'] as const;
export const POOL_PIN_TARGET_KINDS = ['local', 'peer'] as const;

/** Model ids are long (`hf.co/org/repo:Q4_K_M`); this is a sanity bound on what lands in settings.json, not a grammar. */
export const MAX_PINNED_MODEL_LENGTH = 200;
/**
 * How many pins settings.json will hold. Pins are rewritten as one array by a read-modify-write of
 * the whole settings file, so the list has to stay small; one pin per model an operator actually
 * cares about is well inside this.
 */
export const MAX_POOL_PINS = 64;

/** Where a pin points. `local` is this node — which has no peer row, which is why a peer column could never have expressed it. */
export type PoolPinTargetKind = 'local' | 'peer';

/**
 * An operator's routing preference for one model, or for everything.
 *
 * Deliberately NOT a table row: a pin has no lifecycle of its own, and an FK to `hub_pool_peer`
 * would have made a remote peer's `handleRemoteUnpair` silently delete this operator's routing
 * policy. A pin whose target is gone is a `filter` that matches nothing — see `applyPin` — so a
 * dangling reference costs a no-op and a warning on the status card, not an error.
 */
export interface HubPoolPin {
  scope: PoolPinScope;
  /** Set exactly when `scope === 'model'`. Stored verbatim: model ids are case-sensitive and contain `:` and `/`. */
  model?: string;
  targetKind: PoolPinTargetKind;
  /** Set exactly when `targetKind === 'peer'`; the `hub_pool_peer.id` uuid. */
  peerId?: string;
  mode: PoolPinMode;
}

/**
 * Whether two engine model ids name the same model.
 *
 * Ollama treats `name` and `name:latest` as one model and apps say either: the Hub hands every app
 * `EMBEDDINGS_MODEL=nomic-embed-text` while every engine's inventory lists `nomic-embed-text:latest`,
 * so a verbatim comparison sent OpenClaw's every memory write to `502 No pool node currently has
 * model "nomic-embed-text"` while the engine one hop away served `:latest` fine. Only the implicit
 * `:latest` tag is folded; everything else stays verbatim and case-sensitive, as the pin docs promise.
 * The tag is the part after the last `:` that follows the last `/`, so `Qwen/Qwen3.5-9B` (no tag)
 * and `host:5000/ns/model` (colon in the host) are handled the way Ollama parses them.
 */
export function sameModelId(a: string, b: string): boolean {
  return a === b || withLatestTag(a) === withLatestTag(b);
}

/** Whether an inventory (`modelsLoaded`, `unservableModels`) lists the model an app asked for. */
export function inventoryListsModel(listed: readonly string[] | undefined, requested: string): boolean {
  return (listed ?? []).some((id) => sameModelId(id, requested));
}

/** One spelling per model for keying state by model, under the same folding {@link sameModelId} compares with. */
export function canonicalModelId(id: string): string {
  return withLatestTag(id);
}

function withLatestTag(id: string): string {
  const slash = id.lastIndexOf('/');
  const colon = id.lastIndexOf(':');
  return colon > slash ? id : `${id}:latest`;
}

/**
 * The pin that governs `model`, or `null`.
 *
 * A model pin wins over the default pin and they never stack: two pins for one request would need a
 * precedence rule between two operator decisions that both say "this node", and the model-specific
 * one is unambiguously the more specific intent. Comparison is verbatim and case-sensitive, because
 * candidate matching is `modelsLoaded.includes(model)` in both `probeLocalCandidates` and
 * `peerCandidates` — normalizing here would make pins that look right silently never match.
 */
export function resolvePinFor(pins: readonly HubPoolPin[] | undefined, model: string): HubPoolPin | null {
  if (!pins?.length) {
    return null;
  }
  return pins.find((pin) => pin.scope === 'model' && pin.model === model) ?? pins.find((pin) => pin.scope === 'default') ?? null;
}

/** Whether two pins address the same thing — the identity an upsert replaces on, standing in for the unique index a table would have had. */
export function samePinTarget(a: Pick<HubPoolPin, 'scope' | 'model'>, b: Pick<HubPoolPin, 'scope' | 'model'>): boolean {
  return a.scope === b.scope && (a.scope === 'default' || a.model === b.model);
}

/** Upsert by `(scope, model)`, preserving list order so the settings card does not reshuffle under an edit. */
export function upsertPoolPin(pins: readonly HubPoolPin[], pin: HubPoolPin): HubPoolPin[] {
  const existing = pins.findIndex((candidate) => samePinTarget(candidate, pin));
  if (existing === -1) {
    return [...pins, pin];
  }
  const next = [...pins];
  next[existing] = pin;
  return next;
}

/** Remove the pin addressing `(scope, model)`. Returns the same array identity when nothing matched, so a no-op DELETE never rewrites settings.json. */
export function removePoolPin(pins: readonly HubPoolPin[], scope: PoolPinScope, model?: string): HubPoolPin[] {
  const next = pins.filter((pin) => !samePinTarget(pin, { scope, model }));
  return next.length === pins.length ? [...pins] : next;
}
