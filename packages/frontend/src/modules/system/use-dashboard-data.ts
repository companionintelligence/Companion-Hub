import {
  getCloudProvidersOptions,
  getHardwareOptions,
  getMemoryOptions,
  getPoolRoutingLogOptions,
  poolStatusOptions,
} from '@/api-client/@tanstack/react-query.gen';
import { inferenceStatusOptions } from '@/api-client/routes/named-status-routes';
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

export interface PoolNodeSummary {
  nodeFqdn?: string | null;
  tailnet?: string | null;
  hardwareTier?: string | null;
  inFlightRequests?: number | null;
  tailscaleConnected?: boolean;
  capabilitiesError?: string | null;
  gpuPressure?: number | null;
  backends?: PoolBackend[];
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
  inFlightRequests?: number | null;
  gpuPressure?: number | null;
  authMode?: string;
  lastCapabilities?: { hardwareTier?: string | null; acceptingWork?: boolean; backends?: PoolBackend[] } | null;
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
}

export interface InferenceBackendStatus {
  type: string;
  running?: boolean;
  healthy?: boolean;
  url?: string;
  modelsLoaded?: number;
}

/** The eleven fields of `/inference/memory`, all measured in MB. */
export interface MemoryBudgetSummary {
  totalVramMb?: number;
  totalRamMb?: number;
  systemReservedRamMb?: number;
  dockerOverheadMb?: number;
  appContainerBudgetMb?: number;
  modelBudgetVramMb?: number;
  modelBudgetRamMb?: number;
  modelUsedVramMb?: number;
  modelUsedRamMb?: number;
  pinnedVramMb?: number;
  pinnedRamMb?: number;
}

export interface CloudProviderSummary {
  provider: string;
  enabled?: boolean;
  configured?: boolean;
  defaultModel?: string | null;
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

  return { containers, pool, routingLog, inference, memory, hardware, cloudProviders };
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
  const rows: MemoryBudgetRow[] = [
    {
      kind: 'vram',
      total: budget.totalVramMb ?? 0,
      budget: budget.modelBudgetVramMb ?? 0,
      used: budget.modelUsedVramMb ?? 0,
      pinned: budget.pinnedVramMb ?? 0,
    },
    {
      kind: 'ram',
      total: budget.totalRamMb ?? 0,
      budget: budget.modelBudgetRamMb ?? 0,
      used: budget.modelUsedRamMb ?? 0,
      pinned: budget.pinnedRamMb ?? 0,
    },
  ];

  return rows.filter((row) => row.total > 0);
}

/** Share of a budget that is in use, 0-100, or `null` when there is no budget to be a share of. */
export function budgetPercent(used: number, budget: number): number | null {
  if (!Number.isFinite(budget) || budget <= 0) return null;

  return Math.min(100, Math.max(0, Math.round((used / budget) * 100)));
}
