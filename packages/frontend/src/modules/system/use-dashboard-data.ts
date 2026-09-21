import {
  getCloudProvidersOptions,
  getHardwareOptions,
  getResidentModelsOptions,
  getMemoryOptions,
  getPoolRoutingLogOptions,
  poolStatusOptions,
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
   * The peer's clamped, freshness-gated container rollup, or `null` for "not reported".
   *
   * Read this, never `lastCapabilities.containers`. The raw blob is what the remote machine sent;
   * this is what our backend was willing to believe after rejecting hostile values and stale
   * snapshots, and the two disagreeing is precisely when the difference matters.
   */
  containers?: PoolContainerRollup | null;
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
  };
}

export interface RoutingLogEntry {
  at: string;
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
  pin?: unknown;
  /**
   * Token counts, attached once the backend's response finished — `null`/absent while pending,
   * and forever when the dialect never reported one (most entries, today: see
   * `response-usage-tap.ts` on the backend for exactly which two shapes are recognised). Never a
   * proxy for a real count — no estimate from `durationMs` or byte lengths, matching the same
   * rule `workload-coverage.tsx` states for the per-workload tile this feeds `tokensByModel` for.
   */
  usage?: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null;
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
  gpu?: { available?: boolean; vendor?: string; model?: string; vramMb?: number; unifiedMemory?: boolean; runtimeAvailable?: boolean };
  npu?: { available?: boolean; model?: string };
  ram?: { totalMb?: number; availableMb?: number };
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

/** Both queries must have arrived for the panel to be honest; either failing fails the panel. */
export function combineLoadState(...states: LoadState[]): LoadState {
  return { pending: states.some((state) => state.pending), failed: states.some((state) => state.failed) };
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
    select: (payload) => payload as unknown as { entries?: RoutingLogEntry[]; summary?: PoolStatusSummary['routing'] },
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

  return { containers, pool, routingLog, inference, memory, residency, hardware, cloudProviders };
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
  connected: number;
  unreachable: number;
  reachableModels: number;
  /** Models no local backend holds — the only number that says what pooling actually buys this node. */
  exclusiveModels: number;
  /** Sum over connected peers, or `null` when not one of them reported the counter. */
  peerInFlight: number | null;
}

/**
 * Where OUR OUTBOUND work actually went, as label→count.
 *
 * ⚠ `entry.node` DOES NOT MEAN THE SAME THING IN EVERY ROW, which is why this cannot just count
 * them. The field's doc on `hub-pool-routing-log.service.ts` states it: for `outbound` it is the
 * node that served the request (`'local'` for this one, `null` when nothing did); for `inbound`
 * it is the peer that SENT us work.
 *
 * Counting every row made two false claims at once — a peer that gave us work charted as having
 * done work for us (and on a fleet where every peer is inbound, those rows dominate), and each
 * request nobody would take credited to the local node via `?? 'local'`.
 *
 * `unplacedLabel` is passed in rather than hardcoded so the caller can translate it.
 */
export function routingByNode(entries: RoutingLogEntry[], unplacedLabel: string): Map<string, number> {
  const byNode = new Map<string, number>();
  let unplaced = 0;

  for (const entry of entries) {
    if (entry.direction !== 'outbound') continue;

    const node = entry.node?.split('.')[0];

    if (!node) {
      unplaced += 1;
      continue;
    }

    byNode.set(node, (byNode.get(node) ?? 0) + 1);
  }

  // Counted under its own label rather than folded into a node or dropped: "we tried and nobody
  // took it" is a real outcome, and the one most worth seeing.
  if (unplaced > 0) byNode.set(unplacedLabel, unplaced);

  return byNode;
}

/**
 * Total tokens per model, summed from routing-log entries that actually carry a usage frame.
 *
 * Most entries carry none — capture only recognises Ollama's native NDJSON trailer and an
 * OpenAI-style `usage` object (opted into on the proxy's behalf for streamed requests), and only
 * for OUTBOUND work this Hub itself placed. An entry with no `usage.totalTokens` contributes
 * nothing to any model's total. Unlike {@link routingByNode}'s `unplacedLabel`, there is no
 * "unmeasured" bucket here: absence is the expected common case for most requests today, not an
 * operator-facing gap worth a row of its own — the partial coverage is visible instead in how much
 * smaller this sum reads than `RoutingActivity.served`.
 */
export function tokensByModel(entries: RoutingLogEntry[]): Map<string, number> {
  const byModel = new Map<string, number>();

  for (const entry of entries) {
    if (entry.direction !== 'outbound' || !entry.model) continue;
    const total = entry.usage?.totalTokens;
    if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) continue;
    byModel.set(entry.model, (byModel.get(entry.model) ?? 0) + total);
  }

  return byModel;
}

export function poolReach(peers: PoolPeerSummary[], local: PoolNodeSummary | undefined): PoolReach {
  const connected = peers.filter((peer) => peer.status === 'connected' && peer.enabled !== false);
  const servable = (backends: PoolBackend[] | undefined) =>
    (backends ?? []).filter((backend) => backend.healthy !== false).flatMap((backend) => backend.modelsLoaded ?? []);

  const reachable = new Set(connected.flatMap((peer) => servable(peer.lastCapabilities?.backends)));
  const localModels = new Set(servable(local?.backends));
  const reported = connected.filter((peer) => typeof peer.inFlightRequests === 'number');

  return {
    connected: connected.length,
    unreachable: peers.filter((peer) => peer.status === 'unreachable').length,
    reachableModels: reachable.size,
    exclusiveModels: [...reachable].filter((model) => !localModels.has(model)).length,
    // No peer reporting the counter is "unknown", not "idle" — the panel must render a dash.
    peerInFlight: reported.length === 0 ? null : reported.reduce((sum, peer) => sum + (peer.inFlightRequests ?? 0), 0),
  };
}

/** One row of the model-memory budget: how much of a pool of memory models may use, and how much they hold. */
export interface MemoryBudgetRow {
  kind: 'vram' | 'ram';
  total: number;
  budget: number;
  used: number;
  pinned: number;
  /**
   * `true` when an engine holding a model in this pool could not be sized, so `used` is a floor.
   * A caller rendering `used` must say so: the remainder is NOT known to be free.
   */
  incomplete: boolean;
  /** The engines whose figures `used` is built from, in the order the backend lists them. */
  engines: ModelMemoryUsageEntrySummary[];
}

/**
 * The memory budget as bars, or the reason there are none.
 *
 * `totalVramMb` is 0 on every unified-memory machine BY DESIGN — the backend forces it to
 * zero when `gpu.unifiedMemory` is set and routes all model memory into the RAM counters,
 * because there is no separate pool of video memory to budget. Rendering an empty VRAM
 * meter there would read as "this machine has no GPU", which is the opposite of true. So a
 * zero total drops the row and the panel says why instead.
 */
export function memoryBudgetRows(budget: MemoryBudgetSummary | undefined): MemoryBudgetRow[] {
  if (!budget) return [];
  const engines = budget.usage?.backends ?? [];
  const enginesIn = (pool: 'vram' | 'ram') => engines.filter((entry) => entry.pool === pool);
  const rows: MemoryBudgetRow[] = [
    {
      kind: 'vram',
      total: budget.totalVramMb ?? 0,
      budget: budget.modelBudgetVramMb ?? 0,
      used: budget.modelUsedVramMb ?? 0,
      pinned: budget.pinnedVramMb ?? 0,
      incomplete: enginesIn('vram').some((entry) => entry.source === 'unmeasured'),
      engines: enginesIn('vram'),
    },
    {
      kind: 'ram',
      total: budget.totalRamMb ?? 0,
      budget: budget.modelBudgetRamMb ?? 0,
      used: budget.modelUsedRamMb ?? 0,
      pinned: budget.pinnedRamMb ?? 0,
      incomplete: enginesIn('ram').some((entry) => entry.source === 'unmeasured'),
      engines: enginesIn('ram'),
    },
  ];

  return rows.filter((row) => row.total > 0);
}

/** Share of a budget that is in use, 0-100, or `null` when there is no budget to be a share of. */
export function budgetPercent(used: number, budget: number): number | null {
  if (!Number.isFinite(budget) || budget <= 0) return null;

  return Math.min(100, Math.max(0, Math.round((used / budget) * 100)));
}
