import {
  getHardwareOptions,
  getPoolRoutingLogOptions,
  getResidentModelsOptions,
  listPeersOptions,
  poolStatusOptions,
} from '@/api-client/@tanstack/react-query.gen';
import { inferenceStatusOptions } from '@/lib/api-routes/named-status-routes';
import { fetchAppRuntimeMonitor, type AppRuntimeMonitorSnapshot } from '@/lib/app-runtime-monitor';
import { useQuery } from '@tanstack/react-query';

/*
 * Every query the resource dashboard reads, in one place.
 *
 * Poll intervals differ on purpose. Container stats are a `docker stats` sample and
 * are expensive, so they stay on the page's existing 60s cadence. Pool state is a
 * cheap in-memory read and is the thing an operator watches change, so it polls at
 * 15s. Hardware is effectively static and polls slowly.
 *
 * Every query is allowed to fail independently: a Hub with no pool paired still has
 * containers worth showing, and one whose inference engine is down still has peers.
 * The panels each render their own empty/error state rather than the page blanking.
 */

const CONTAINER_POLL_MS = 60_000;
const POOL_POLL_MS = 15_000;
const HARDWARE_POLL_MS = 120_000;

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
  backends?: PoolBackend[];
}

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
  lastCapabilities?: { hardwareTier?: string | null; backends?: PoolBackend[] } | null;
}

export interface PoolStatusSummary {
  enabled?: boolean;
  routingActive?: boolean;
  reason?: string;
  localNode?: PoolNodeSummary;
  peerCounts?: { total?: number; connected?: number; pending?: number; unreachable?: number; disabled?: number };
  routing?: { recorded?: number; capacity?: number; served?: number; failed?: number; failovers?: number; lastAt?: string | null };
  settings?: { poolLocalAffinity?: number; poolHealthPollSeconds?: number; poolEnabled?: boolean };
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

/** One model the engine says is in memory right now — see `models/resident`. */
export interface ResidentModelSummary {
  id: string;
  vramBytes: number | null;
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
  totalVramBytes: number | null;
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

export function useDashboardData() {
  const containers = useQuery<AppRuntimeMonitorSnapshot>({
    queryKey: ['app-resource-monitor'],
    queryFn: fetchAppRuntimeMonitor,
    refetchInterval: CONTAINER_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: CONTAINER_POLL_MS / 2,
  });

  const pool = useQuery({
    ...poolStatusOptions(),
    select: (payload) => payload as unknown as PoolStatusSummary,
    refetchInterval: POOL_POLL_MS,
    retry: false,
  });

  const peers = useQuery({
    ...listPeersOptions(),
    select: (payload) => (Array.isArray(payload) ? (payload as unknown as PoolPeerSummary[]) : []),
    refetchInterval: POOL_POLL_MS,
    retry: false,
  });

  const routingLog = useQuery({
    ...getPoolRoutingLogOptions(),
    select: (payload) => payload as unknown as { entries?: RoutingLogEntry[]; summary?: PoolStatusSummary['routing'] },
    refetchInterval: POOL_POLL_MS,
    retry: false,
  });

  const inference = useQuery({
    ...inferenceStatusOptions(),
    select: (payload) => payload as unknown as { backends?: InferenceBackendStatus[] },
    refetchInterval: POOL_POLL_MS,
    retry: false,
  });

  /*
   * Residency polls on the pool cadence, not the engine one: it is a single cheap read of
   * each engine's in-memory scheduler state (ollama's `/api/ps` returns only what is
   * resident, typically 0-3 entries), and it is the number that changes minute to minute as
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
    refetchInterval: HARDWARE_POLL_MS,
    retry: false,
  });

  return { containers, pool, peers, routingLog, inference, hardware, residency };
}

/** Peer rows worth routing to — `pending` is not a routing target yet. */
export function activePeers(peers: PoolPeerSummary[]): PoolPeerSummary[] {
  return peers.filter((peer) => peer.status === 'connected' || peer.status === 'unreachable');
}

export function peerLabel(peer: PoolPeerSummary): string {
  return peer.displayName || (peer.nodeFqdn ?? '').split('.')[0] || peer.id;
}

/**
 * Which nodes can serve each model, across the whole pool.
 *
 * Unreachable peers are excluded deliberately: `lastCapabilities` is a cached snapshot
 * of a node that is not answering, so counting it as capacity would overstate what the
 * pool can actually serve right now.
 */
export function poolModelIndex(
  local: PoolNodeSummary | undefined,
  peers: PoolPeerSummary[],
  localLabel: string,
): { model: string; nodes: string[]; backends: string[] }[] {
  const index = new Map<string, { nodes: Set<string>; backends: Set<string> }>();

  const add = (node: string, backends: PoolBackend[] | undefined) => {
    for (const backend of backends ?? []) {
      for (const model of backend.modelsLoaded ?? []) {
        const entry = index.get(model) ?? { nodes: new Set<string>(), backends: new Set<string>() };
        entry.nodes.add(node);
        entry.backends.add(backend.type);
        index.set(model, entry);
      }
    }
  };

  add(localLabel, local?.backends);
  for (const peer of peers) {
    if (peer.status !== 'connected') continue;
    add(peerLabel(peer), peer.lastCapabilities?.backends);
  }

  return [...index.entries()]
    .map(([model, entry]) => ({ model, nodes: [...entry.nodes].sort(), backends: [...entry.backends].sort() }))
    .sort((a, b) => b.nodes.length - a.nodes.length || a.model.localeCompare(b.model));
}
