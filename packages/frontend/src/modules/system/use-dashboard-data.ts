import {
  getCloudProvidersOptions,
  getHardwareOptions,
  getResidentModelsOptions,
  getMemoryOptions,
  getPoolRoutingLogOptions,
  poolStatusOptions,
  systemLoadOptions,
} from '@/api-client/@tanstack/react-query.gen';
import { inferenceStatusOptions } from '@/lib/api-routes/named-status-routes';
import { fetchAppRuntimeMonitor, type AppRuntimeMonitorSnapshot } from '@/lib/app-runtime-monitor';
import { useQuery } from '@tanstack/react-query';

/*
 * Every query the resource dashboard reads, in one place.
 *
 * THREE CADENCES, ONE PER DATA CLASS — not one interval per endpoint. Six panels
 * refreshing on six timers would put a permanent probe fan-out on an idle dashboard.
 *
 *  POOL_POLL_MS (15s)   `/pool/status` and `/pool/routing-log`. Both are documented as
 *                       cheap enough to poll: one SELECT plus in-memory counters, and a
 *                       bounded ring buffer. This is also the only data that changes on
 *                       a human timescale — it is what an operator sits and watches.
 *
 *  ENGINE_POLL_MS (60s) `/apps/resource-monitor`, `/inference/status`, `/inference/memory`.
 *                       Each one costs real work. The container snapshot is a `docker stats`
 *                       sample the backend already caches for 30s and re-samples on its own
 *                       60s timer, so polling faster returns the same bytes. `/inference/status`
 *                       is the expensive one: it health-checks all six backends with no cache
 *                       at any layer, so it must never sit on the pool cadence.
 *
 *  STATIC_POLL_MS (120s) `/inference/hardware` and `/inference/cloud-providers`. Both are
 *                       effectively fixed between restarts; they are polled at all only so a
 *                       dashboard left open overnight is not stale after a GPU driver change.
 *
 *  (none)               `/system/load`, for host CPU. The dashboard layout already polls it every
 *                       3s for the header, under the same query key, so this page subscribes to
 *                       that cache entry and adds no request of its own.
 *
 * Every query is allowed to fail independently, and `retry: false` keeps a failure visible
 * rather than hidden behind three silent retries. A Hub with no pool paired still has
 * containers worth showing; a Hub whose inference engine is down still has peers. Each
 * panel renders its own loading / failed / empty state — the page never blanks on one
 * failed request, and it never renders a failed request as a zero.
 */

const POOL_POLL_MS = 15_000;
const ENGINE_POLL_MS = 60_000;
const STATIC_POLL_MS = 120_000;

export interface PoolBackend {
  type: string;
  healthy?: boolean;
  /**
   * The engine's ON-DISK inventory, despite the name the API gives it.
   *
   * Measured on beta-max: `modelsLoaded` carried 11 entries while the engine's own
   * `/api/ps` reported zero models resident in VRAM. This is the right basis for "can
   * this node serve that model" — a model on disk can be served — but any label built
   * from it must say holds/available, never loaded or resident.
   */
  modelsLoaded?: string[];
}

/**
 * This Hub as `/pool/status` reports it.
 *
 * ⚠ There is deliberately no `containers` here, and adding one would be wrong: the endpoint does
 * not carry it. `buildLocalNodeStatus` returns inference capability only, and the local container
 * rollup exists solely inside the OUTBOUND capability payload that PEERS fetch from us. This
 * Hub's own container numbers come from `/apps/resource-monitor`, which is a different endpoint
 * on a different cadence with real server-side history.
 */
export interface PoolNodeSummary {
  nodeFqdn?: string | null;
  tailnet?: string | null;
  hardwareTier?: string | null;
  inFlightRequests?: number | null;
  tailscaleConnected?: boolean;
  capabilitiesError?: string | null;
  gpuPressure?: number | null;
  /** Which measurement produced the band — `'amd-drm'` or `'host-file'`. Absent when unmeasured. */
  gpuPressureSource?: string | null;
  backends?: PoolBackend[];
  /** What this node's own engines have been measured doing, per (backend, model). Empty after two idle hours. */
  throughput?: PoolThroughputEstimate[];
}

/**
 * How fast one engine serves one model, as `/pool/status` publishes it — mirrors the backend's
 * `PoolThroughputEstimate` in `hub-pool.types.ts`.
 *
 * ⚠ ONLY `decode` IS READ BY THIS PAGE. The prefill points are rates in the pool's own token
 * ESTIMATE (`bytes / 4` of the whole forwarded body) over Ollama's `prompt_eval_duration`, which on a
 * prefix-cached agent turn times only the uncached tail. Measured on core-2: local `qwen3.6:35b`
 * "prefilled" at 22,899.7 tok/s. That figure is fit for ranking (it compares nodes on the same
 * mistake) and unfit for an operator, who would read it as the machine's speed. `decode` is the
 * engine's own `eval_count / eval_duration`, which caching does not touch.
 */
export interface PoolThroughputEstimate {
  model: string;
  backend: string;
  prefill?: unknown[];
  decode: { tokensPerSec: number; ageMs: number } | null;
}

/**
 * Aggregate container counts a peer publishes about itself — numbers only, never names.
 *
 * `null` on the wire, and absent, both mean NOT REPORTED, and they cover every way we can fail to
 * know: a peer on a pre-container build, an operator who opted out, a sampler with no recent
 * sample, a snapshot too old to believe, a value the backend refused to clamp. All five must
 * render as "not reported". None of them may ever render as zero — `{ running: 0 }` is a peer
 * actively telling us nothing is running, which is a different fact.
 */
export interface PoolContainerRollup {
  running: number;
  stopped: number;
  total: number;
  /** Summed across containers and per-core, so a busy multi-core box legitimately exceeds 100. */
  cpuPercent: number;
  memoryBytes: number;
}

/**
 * A peer as `/pool/status` reports it — deliberately NOT as `/pool/peers` does.
 *
 * `/pool/status` returns the same rows plus the three things this dashboard needs and the
 * bare peer list does not carry: live `inFlightRequests`, the EFFECTIVE `gpuPressure` band
 * (freshness applied and clamped — the number routing actually believes, not the raw
 * self-report), and `authMode`. Reading both endpoints would also let the two lists
 * disagree mid-poll, so the dashboard reads one.
 *
 * Optional fields here mean UNKNOWN, never zero. A peer that cannot measure its GPU omits
 * `gpuPressure`; a build older than the switch omits `acceptingWork` (which meant yes).
 * Coalescing either to a number would state a fact the peer never sent.
 */
export interface PoolPeerSummary {
  id: string;
  nodeFqdn?: string | null;
  displayName?: string | null;
  direction?: string;
  status?: string;
  enabled?: boolean;
  consecutiveFailures?: number;
  lastSeenAt?: string | null;
  /** What THIS Hub has forwarded to the peer and not yet finished reading — our counter, not its load. */
  inFlightRequests?: number | null;
  gpuPressure?: number | null;
  authMode?: string;
  /**
   * The current run of failed health probes, or `null` while they succeed. Process-local on the
   * backend, so a restart clears it until the next probe fails. Only `kind` is read here.
   */
  probeFailure?: { kind?: string; since?: string; action?: string | null } | null;
  /**
   * The peer's clamped, freshness-gated container rollup, or `null` for "not reported".
   *
   * Read this, never `lastCapabilities.containers`. The raw blob is what the remote machine sent;
   * this is what our backend was willing to believe after rejecting hostile values and stale
   * snapshots, and the two disagreeing is precisely when the difference matters.
   */
  containers?: PoolContainerRollup | null;
  /**
   * The peer's throughput two ways: what THIS Hub timed it doing (`observed`), and what it said about
   * itself (`advertised`, already clamped by the backend). Either list may be empty — evidence is
   * forgotten after two idle hours — and an older Hub omits the key entirely.
   */
  throughput?: { observed?: PoolThroughputEstimate[]; advertised?: PoolThroughputEstimate[] } | null;
  /**
   * The peer's verbatim self-report, cached at the last successful probe.
   *
   * ⚠ UNCLAMPED AND NOT FRESHNESS-GATED. `toPublicPeer` strips only the token columns, so this
   * whole jsonb blob ships to the browser exactly as the peer wrote it. Where a clamped sibling
   * field exists — `containers`, `gpuPressure` — read the sibling. Anything taken from here must
   * be range-checked and age-checked at the point of use.
   */
  lastCapabilities?: {
    hardwareTier?: string | null;
    acceptingWork?: boolean;
    backends?: PoolBackend[];
    inFlightRequests?: number;
    gpuPressure?: number;
    gpuPressureSource?: string;
    containers?: PoolContainerRollup;
    updatedAt?: string;
  } | null;
}

/** One half of pooling and what is holding it off. `disabledBy: 'env'` is not a toggle the UI can offer to flip. */
export interface PoolDirectionState {
  enabled?: boolean;
  disabledBy?: 'env' | 'setting' | null;
}

/** A stored routing override, with the resolved answer to "is it actually doing anything". */
export interface PoolPinSummary {
  scope?: string;
  model?: string;
  targetKind?: string;
  peerId?: string;
  mode?: string;
  nodeFqdn?: string | null;
  targetAvailable?: boolean;
}

export interface PoolStatusSummary {
  enabled?: boolean;
  disabledBy?: 'env' | 'setting' | null;
  directions?: { outbound?: PoolDirectionState; inbound?: PoolDirectionState };
  routingActive?: boolean;
  reason?: string;
  localNode?: PoolNodeSummary;
  peers?: PoolPeerSummary[];
  peerCounts?: { total?: number; connected?: number; pending?: number; unreachable?: number; disabled?: number };
  pins?: PoolPinSummary[];
  routing?: { recorded?: number; capacity?: number; served?: number; failed?: number; failovers?: number; lastAt?: string | null };
  settings?: {
    poolEnabled?: boolean;
    poolOutboundEnabled?: boolean;
    poolInboundEnabled?: boolean;
    poolLocalAffinity?: number;
    poolHealthPollSeconds?: number;
    poolRequireSignedPeers?: boolean;
    poolPressureWeight?: number;
    /**
     * Default on. When on, apps are handed this Hub's pool proxy even with no peer connected, so
     * their calls reach the routing log; when off, a peerless Hub hands them their engines directly.
     * See `unloggedCalls`.
     */
    poolRouteAppsAlways?: boolean;
  };
}

export interface RoutingLogEntry {
  at: string;
  /**
   * When anything on the row last changed. While a row is `pending` that is its last failover hop —
   * the moment the node now holding it started on it, and started its own header deadline — which
   * is why `waitingNow` reads it. Absent on a Hub predating the field.
   */
  updatedAt?: string;
  direction: string;
  path?: string;
  model?: string | null;
  node?: string | null;
  backend?: string | null;
  outcome?: string;
  status?: number | null;
  durationMs?: number | null;
  attempt?: number;
  candidates?: number;
  failedOverFrom?: string[];
  /**
   * `true` when the app closed its connection before any candidate answered. Such a row still names
   * the node it was waiting on, which is what keeps it out of {@link isUnplaced} and the `bad`
   * "unplaced" fault in `triage.ts` — a caller that left is not a routing or capacity problem. Absent on a Hub predating the flag.
   */
  clientClosed?: boolean;
  /**
   * Why the row stopped at a node that answered with an error about the REQUEST rather than serving
   * it: `signature` labels the engine's message, or is `client-error` for a 4xx relayed on its status.
   * Present on outbound rows only; `null`/absent on every other row and on a Hub predating the field.
   * Read through `isRefused`, which also reads the status, so neither gap makes a refusal look served.
   *
   * With `basis: 'node'` it is the opposite: the node answered 200 with output that was cut off
   * (`truncated-upstream`) or only placeholder tokens (`degenerate-output`). The node's fault, never
   * the app's — read through `outputFault`, and never shown as a refusal.
   */
  requestError?: { signature?: string; basis?: string; confirms?: string | null } | null;
  /** Why a failed row failed, in a few words: a status, a deadline, an error code or an output fault. Absent on a Hub predating it. */
  reason?: string | null;
  /** Each candidate passed over before the one that answered, with what it answered. Absent on a Hub predating it. */
  attempts?: { node: string; backend?: string; status: number | null; reason: string }[];
  /**
   * Time to the end of the response body, where `durationMs` stops at the first headers. `null` until
   * the body is over and on a row that relayed none; absent on a Hub predating it.
   */
  totalMs?: number | null;
  pin?: unknown;
  /**
   * Token counts, attached once the backend's response finished — `null`/absent while pending,
   * and forever when the dialect never reported one (most entries, today: see
   * `response-usage-tap.ts` on the backend for exactly which two shapes are recognised). Never a
   * proxy for a real count — no estimate from `durationMs` or byte lengths. A row with none is
   * "not reported", which is why the token figures built from it say how many rows reported.
   */
  usage?: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null;
  /**
   * Whether the caller asked for a streamed response. It decides what `durationMs` measured: for a
   * stream, the wait for the first frame; for a non-streamed request, response headers arrive only
   * after the WHOLE generation, so its `durationMs` is not a first-byte time at all. `null`/absent on
   * a row recorded before the body was read, and on a Hub predating the field.
   */
  stream?: boolean | null;
  /** UTF-8 size of the forwarded body. `/ 4` is the pool's own prompt-size estimate. */
  bodyBytes?: number | null;
  /** The header deadline this request was placed under, in ms. */
  budgetMs?: number | null;
  /** The throughput half of the decision; read only for its `estimatedTokens`, never its rates. */
  throughput?: { estimatedTokens?: number } | null;
}

/**
 * `GET /pool/routing-log`'s summary block — the ring's own account of itself, which the page needs
 * to tell a complete half hour from a truncated one (see `routingWindowPartial`).
 */
export interface RoutingLogSummary {
  /** Rows the ring holds now. */
  recorded?: number;
  /** The ring's size for this process — 200 by default, up to 10,000 with `HUB_POOL_ROUTING_LOG_SIZE`. */
  capacity?: number;
  /** Rows recorded since this process started, evicted or not. Above `recorded` means the ring has dropped rows. */
  totalRecorded?: number;
  /** Placement time of the oldest row still in the ring. */
  oldestAt?: string | null;
  clientClosed?: number;
  /** When this process's log began — the Hub's own start time, as close as this page can get to one. */
  startedAt?: string;
}

/**
 * One page of the routing log.
 *
 * `matched` is how many rows the ring holds; the page without a `limit` is the newest 200 of them.
 * `matched > entries.length` therefore means the RING is bigger than the page — a Hub running with
 * `HUB_POOL_ROUTING_LOG_SIZE` raised — and what was left out is older placements.
 */
export interface RoutingLogPage {
  entries?: RoutingLogEntry[];
  summary?: RoutingLogSummary;
  matched?: number;
}

/**
 * An outbound request no node was even asked to serve: the ranking produced NO candidate.
 *
 * ⚠ NOT "an outbound row with no node", which is what every reader tested until this. The proxy
 * writes `node: null` in two different places for two different facts: when there is no candidate
 * at all (`candidates: 0` — no peer holds the model, or pooling is off for it), and when EVERY
 * candidate was tried and failed (`settle` after the failover loop, `candidates: 9, attempt: 9`).
 * Reading both as "unplaced" put core-2 in red for eighteen hours over one agent turn that nine
 * nodes had each tried and dropped — a row whose own feed line read "Unplaced · +9 tried", which
 * contradicts itself. The two send an operator to opposite places: one to which models the pool
 * holds, the other to why nine nodes could not answer.
 *
 * A Hub predating `candidates` gets the old test minus what we can rule out: a row that failed
 * over was tried, and a caller that hung up was waiting on a node.
 */
export function isUnplaced(entry: RoutingLogEntry): boolean {
  if (entry.direction !== 'outbound') return false;
  if (typeof entry.candidates === 'number') return entry.candidates === 0;

  return !entry.node && !(entry.failedOverFrom?.length ?? 0) && !entry.clientClosed;
}

/**
 * The pool's estimate of a request's prompt size, in tokens, or `null`.
 *
 * The routing decision's own `estimatedTokens` when it recorded one, else `bodyBytes / 4` — the same
 * arithmetic the backend uses, so the two never disagree. It is the size of the WHOLE forwarded body
 * (system prompt, tools, history), which is what the engine has to prefill on a cold cache.
 */
export function estimatedPromptTokens(entry: RoutingLogEntry): number | null {
  const recorded = entry.throughput?.estimatedTokens;
  if (typeof recorded === 'number' && Number.isFinite(recorded) && recorded > 0) return recorded;
  if (typeof entry.bodyBytes === 'number' && Number.isFinite(entry.bodyBytes) && entry.bodyBytes > 0) return Math.round(entry.bodyBytes / 4);

  return null;
}

export interface InferenceBackendStatus {
  type: string;
  running?: boolean;
  healthy?: boolean;
  url?: string;
  modelsLoaded?: number;
}

/**
 * One engine's share of the budget's used figure, and how it was established.
 *
 * `source` is the point. `process` is what nvidia-smi / rocm-smi read for the engine's process
 * — the only measurement; `engine` is the engine's own accounting (Ollama's `/api/ps`), used
 * when no process was read; `registry` is the Hub's bookkeeping of what its router loaded
 * (used only when the engine could not be asked); and `unmeasured` is an engine that is
 * holding a model nothing on the node can size — its `usedMb` is `null`, and the used figure
 * it is missing from is a floor, not the total.
 */
export interface ModelMemoryUsageEntrySummary {
  backend: string;
  models?: string[];
  pool?: 'vram' | 'ram';
  usedMb?: number | null;
  source?: 'engine' | 'process' | 'registry' | 'unmeasured';
}

/** The fields of `/inference/memory`, all measured in MB, plus where the used figures came from. */
export interface MemoryBudgetSummary {
  totalVramMb?: number;
  totalRamMb?: number;
  systemReservedRamMb?: number;
  dockerOverheadMb?: number;
  appContainerBudgetMb?: number;
  modelBudgetVramMb?: number;
  modelBudgetRamMb?: number;
  /** What every engine on the node holds now — not what this Hub loaded. See {@link ModelMemoryUsageEntrySummary}. */
  modelUsedVramMb?: number;
  modelUsedRamMb?: number;
  pinnedVramMb?: number;
  pinnedRamMb?: number;
  usage?: { sampledAt?: string; backends?: ModelMemoryUsageEntrySummary[] };
}

export interface CloudProviderSummary {
  provider: string;
  enabled?: boolean;
  configured?: boolean;
  defaultModel?: string | null;
}

/**
 * One model an engine says is in memory right now — `GET /api/inference/models/resident`.
 *
 * `engineGpuBytes` is deliberately NOT called VRAM. It is the bytes the engine's scheduler
 * assigned to its GPU backend, which on a unified-memory APU is largely host RAM reached
 * through GTT. Measured on beta-max: ollama reported 7319 MiB for a model on a card whose
 * total VRAM is 2048 MB. Naming it VRAM would repeat, one level down, the very mistake this
 * route was built to correct.
 */
export interface ResidentModelSummary {
  id: string;
  engineGpuBytes: number | null;
  totalBytes: number | null;
  expiresAt: string | null;
  contextLength: number | null;
  quantization: string | null;
}

export interface BackendResidencySummary {
  backend: string;
  source: 'measured' | 'implicit' | 'unsupported' | 'unreachable';
  /** `null` for `unsupported`/`unreachable` — the engine was not asked, so it holds no opinion. */
  models: ResidentModelSummary[] | null;
  error?: string;
}

export interface ResidencyReportSummary {
  backends: BackendResidencySummary[];
  residentCount: number;
  sampledAt: string;
}

export interface HardwareSummary {
  gpu?: {
    available?: boolean;
    vendor?: string;
    model?: string;
    /** ⚠ On a unified-memory machine this is HOST RAM, not a carve-out: core-1 reports 31 G beside a 96 GiB BIOS VRAM split. */
    vramMb?: number;
    unifiedMemory?: boolean;
    /** Whether the GPU runtime is usable from INSIDE the Hub container — false on every fleet node, whose engines run on the host. */
    runtimeAvailable?: boolean;
    /** Whether the HOST has a working ROCm stack — what the host engines actually use. Absent off AMD and on older Hubs. */
    hostRocmAvailable?: boolean;
  };
  npu?: { available?: boolean; model?: string };
  /** `usedMb`/`sampledAt` arrive with a live (Linux MemAvailable) sample; older Hubs send neither. */
  ram?: { totalMb?: number; availableMb?: number; usedMb?: number; sampledAt?: string };
  cpu?: { arch?: string; cores?: number; model?: string };
  os?: { platform?: string; name?: string; version?: string };
  tier?: string;
  effectiveInferenceMemoryMb?: number;
}

/**
 * What a panel needs to tell its three states apart.
 *
 * `pending`, not `isLoading`: an errored query has `isLoading === false` and `data`
 * undefined, so a skeleton keyed off `isLoading` would render forever on a failed fetch.
 */
export interface LoadState {
  pending: boolean;
  failed: boolean;
}

export function loadState(query: { isPending: boolean; isError: boolean }): LoadState {
  return { pending: query.isPending, failed: query.isError };
}

export function useDashboardData() {
  const containers = useQuery<AppRuntimeMonitorSnapshot>({
    queryKey: ['app-resource-monitor'],
    queryFn: fetchAppRuntimeMonitor,
    refetchInterval: ENGINE_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: ENGINE_POLL_MS / 2,
    retry: false,
  });

  const pool = useQuery({
    ...poolStatusOptions(),
    select: (payload) => payload as unknown as PoolStatusSummary,
    refetchInterval: POOL_POLL_MS,
    retry: false,
  });

  const routingLog = useQuery({
    ...getPoolRoutingLogOptions(),
    select: (payload) => payload as unknown as RoutingLogPage,
    refetchInterval: POOL_POLL_MS,
    retry: false,
  });

  // Six uncached backend health probes per call. Never move this to the pool cadence.
  const inference = useQuery({
    ...inferenceStatusOptions(),
    select: (payload) => payload as unknown as { backends?: InferenceBackendStatus[] },
    refetchInterval: ENGINE_POLL_MS,
    retry: false,
  });

  const memory = useQuery({
    ...getMemoryOptions(),
    select: (payload) => payload as unknown as MemoryBudgetSummary,
    refetchInterval: ENGINE_POLL_MS,
    retry: false,
  });

  /*
   * Residency sits on the POOL cadence, not the engine one. It is a single cheap read of each
   * engine's in-memory scheduler state — ollama's `/api/ps` returns only what is resident,
   * typically 0-3 entries — and it is the number that actually moves minute to minute as
   * models load and expire.
   */
  const residency = useQuery({
    ...getResidentModelsOptions(),
    select: (payload) => payload as unknown as ResidencyReportSummary,
    refetchInterval: POOL_POLL_MS,
    retry: false,
  });

  const hardware = useQuery({
    ...getHardwareOptions(),
    select: (payload) => payload as unknown as HardwareSummary,
    refetchInterval: STATIC_POLL_MS,
    retry: false,
  });

  const cloudProviders = useQuery({
    ...getCloudProvidersOptions(),
    select: (payload) => (Array.isArray(payload) ? (payload as unknown as CloudProviderSummary[]) : []),
    refetchInterval: STATIC_POLL_MS,
    retry: false,
  });

  /*
   * No interval of its own, on purpose. `layout.tsx` observes this exact key at 3s for the header's
   * disk banner, so this observer reads that cache entry as it refreshes. Giving it an interval here
   * would add a second timer for the same bytes. `cpuLoad` is `si.currentLoad()`: host-wide on a
   * native Linux Hub, the VM's on Docker Desktop.
   */
  const systemLoad = useQuery({
    ...systemLoadOptions(),
    retry: false,
  });

  return { containers, pool, routingLog, inference, memory, residency, hardware, cloudProviders, systemLoad };
}

/**
 * A stable React key per routing record.
 *
 * Routing records carry no server-side id, and the log is a ring buffer that grows at the
 * head — so the array index is the one thing that is NOT stable: every new request shifts
 * every existing row's index and remounts the table. Keys are built from the record's own
 * content instead, with an occurrence counter to break the tie when a node genuinely served
 * two identical requests within the same millisecond.
 */
export function routingLogKeys(entries: RoutingLogEntry[]): string[] {
  const seen = new Map<string, number>();

  return entries.map((entry) => {
    const base = [entry.at, entry.direction, entry.node ?? '', entry.model ?? '', entry.backend ?? '', entry.status ?? ''].join('|');
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);

    return occurrence === 0 ? base : `${base}#${occurrence}`;
  });
}

export function peerLabel(peer: PoolPeerSummary): string {
  return peer.displayName || (peer.nodeFqdn ?? '').split('.')[0] || peer.id;
}

/**
 * Which nodes can serve each model, across the whole pool.
 *
 * Only `connected` peers count. `lastCapabilities` is a cached snapshot taken the last time
 * a peer answered, so an unreachable node still lists models it can no longer serve;
 * counting those would overstate what the pool can do right now, which is the one question
 * this table exists to answer. A peer the operator has switched off (`enabled === false`) is
 * excluded for the same reason — routing will not send it work, so it is not capacity.
 */
export function poolModelIndex(
  local: PoolNodeSummary | undefined,
  peers: PoolPeerSummary[],
  localLabel: string,
): { model: string; nodes: string[]; backends: string[]; local: boolean }[] {
  const index = new Map<string, { nodes: Set<string>; backends: Set<string>; local: boolean }>();

  const add = (node: string, backends: PoolBackend[] | undefined, isLocal: boolean) => {
    for (const backend of backends ?? []) {
      // An unhealthy backend still reports the models it holds, but it cannot serve them.
      if (backend.healthy === false) continue;
      for (const model of backend.modelsLoaded ?? []) {
        const entry = index.get(model) ?? { nodes: new Set<string>(), backends: new Set<string>(), local: false };
        entry.nodes.add(node);
        entry.backends.add(backend.type);
        entry.local = entry.local || isLocal;
        index.set(model, entry);
      }
    }
  };

  add(localLabel, local?.backends, true);
  for (const peer of peers) {
    if (peer.status !== 'connected' || peer.enabled === false) continue;
    add(peerLabel(peer), peer.lastCapabilities?.backends, false);
  }

  return [...index.entries()]
    .map(([model, entry]) => ({ model, nodes: [...entry.nodes].sort(), backends: [...entry.backends].sort(), local: entry.local }))
    .sort((a, b) => b.nodes.length - a.nodes.length || a.model.localeCompare(b.model));
}

export interface PoolReach {
  /** Connected peers the operator has not disabled. */
  connected: number;
  /** Unreachable peers the operator has not disabled — a disabled peer counts as disabled, whatever its socket says. */
  unreachable: number;
  /** Peers with a failed probe in their current run, leaving out the ones the operator has disabled. */
  probeFailures: number;
  reachableModels: number;
  /** Models no local backend holds — the only number that says what pooling actually buys this node. */
  exclusiveModels: number;
  /** This Hub's forwarded-and-open requests, summed over every peer that reports the counter; `null` when none does. */
  peerInFlight: number | null;
}

export function poolReach(peers: PoolPeerSummary[], local: PoolNodeSummary | undefined): PoolReach {
  const connected = peers.filter((peer) => peer.status === 'connected' && peer.enabled !== false);
  const servable = (backends: PoolBackend[] | undefined) =>
    (backends ?? []).filter((backend) => backend.healthy !== false).flatMap((backend) => backend.modelsLoaded ?? []);

  const reachable = new Set(connected.flatMap((peer) => servable(peer.lastCapabilities?.backends)));
  const localModels = new Set(servable(local?.backends));
  // Every peer that reports the counter, not only connected ones: it is THIS Hub's count of work it
  // sent there, still true after the peer dropped or was disabled, and the reach drawing badges each
  // of them — a total over fewer peers than the badges beside it would disagree with them.
  const reported = peers.filter((peer) => typeof peer.inFlightRequests === 'number');

  return {
    connected: connected.length,
    // Disabled outranks the socket, as `connected` above and the node cards already have it: a peer
    // the operator took out of routing is not reach this Hub has lost. Counting it here made the
    // rail say "1 unreachable" beside a drawing and legend that showed it disabled.
    unreachable: peers.filter((peer) => peer.status === 'unreachable' && peer.enabled !== false).length,
    // Same rule, same reason: a peer that is switched off and also down is not a fault on this Hub.
    probeFailures: peers.filter((peer) => (peer.consecutiveFailures ?? 0) > 0 && peer.enabled !== false).length,
    reachableModels: reachable.size,
    exclusiveModels: [...reachable].filter((model) => !localModels.has(model)).length,
    // No peer reporting the counter is "unknown", not "idle" — the panel must render a dash.
    peerInFlight: reported.length === 0 ? null : reported.reduce((sum, peer) => sum + (peer.inFlightRequests ?? 0), 0),
  };
}

/**
 * Host RAM in use, in MB, or `null` when the profile has no RAM figures at all.
 *
 * `usedMb` is what the Hub measured at the same instant as `availableMb`; a Hub that predates
 * it still sends `totalMb` and `availableMb`, so the difference is the fallback. Either way
 * the honest denominator is "RAM in use", not "RAM not available" — the two only coincide
 * when the sample is live, which is exactly the case `usedMb` marks.
 */
export function hostRamUsedMb(hardware: HardwareSummary | undefined): number | null {
  const ram = hardware?.ram;
  if (typeof ram?.usedMb === 'number') return Math.max(0, ram.usedMb);
  if (typeof ram?.totalMb === 'number' && typeof ram?.availableMb === 'number') return Math.max(0, ram.totalMb - ram.availableMb);
  return null;
}
