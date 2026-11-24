/**
 * Where should a training job run? Pure ranking, no I/O, so it can be unit tested and reused by a
 * controller later.
 *
 * Mirrors Hub Pool's inference ranking on purpose (hub-pool-proxy.service.ts `rankCandidates`):
 *  - an ordered failover list, not a single pick,
 *  - a node with unmeasured counters ranks as mid-load, never idle (`UNKNOWN_PEER_LOAD = 1`),
 *  - the local node gets a head start from a `localAffinity` setting,
 *  - ties fall to GPU pressure, then hardware tier, then a stable key.
 *
 * What differs from inference routing, and why:
 *  - Training is long and heavy, so some facts are hard constraints, not score terms: memory,
 *    framework, image, and where the data lives. A node that fails one is rejected with a reason
 *    instead of ranked last. A stale snapshot makes free memory unknowable, so it is rejected too;
 *    the neutral-when-unknown rule applies only to the load counters of a fresh snapshot.
 *  - Training must stay out of the way of chat. Inference load on a node counts against it, weighted
 *    by priority: an interactive job ignores it, a nightly job pays double.
 *  - Data moves to nothing by default. A request pinned to its data's node is rejected everywhere
 *    else unless remote offload is explicitly allowed, and then remote nodes pay a transfer penalty.
 */

export type PlacementPriority = 'interactive' | 'normal' | 'nightly_idle';
export type PlacementImage = 'cpu' | 'cuda' | 'rocm';

export interface PlacementNode {
  /** `local` for this Hub, otherwise the peer's tailnet name. */
  key: string;
  isLocal: boolean;
  acceptingTraining: boolean;
  /** Hardware class as Hub Pool reports it: high, medium, low, cpu-only, insufficient. */
  tier?: string;
  freeMemoryMb: number | null;
  hasGpu: boolean;
  images: readonly PlacementImage[];
  frameworks: readonly string[];
  activeTrainingJobs: number | null;
  inferenceInFlight: number | null;
  /** 0 (idle) to 1 (saturated), null when unmeasured. */
  gpuPressure: number | null;
  /** Age of the snapshot on our clock. null for the local node, which is always live. */
  snapshotAgeMs: number | null;
}

export interface PlacementRequest {
  requiredMemoryMb: number;
  device: 'cpu' | 'gpu' | 'any';
  /** Images the job ships, any one of which will do. */
  images: readonly PlacementImage[];
  framework: string;
  priority: PlacementPriority;
  /** Node key that holds the job's data, or null when the data is reachable everywhere. */
  dataHome: string | null;
  allowRemoteOffload: boolean;
}

export interface PlacementOptions {
  localAffinity: number;
  staleAfterMs: number;
  pressureWeight: number;
  /** Score cost per in-flight inference request on the node, by job priority. */
  inferenceWeight: Readonly<Record<PlacementPriority, number>>;
  /** Added to every remote node when the job is allowed to leave its data's node. */
  remotePenalty: number;
}

export const DEFAULT_PLACEMENT_OPTIONS: PlacementOptions = {
  localAffinity: 1,
  staleAfterMs: 60_000,
  pressureWeight: 1,
  inferenceWeight: { interactive: 0, normal: 0.5, nightly_idle: 2 },
  remotePenalty: 1,
};

export type RejectReason =
  | 'not_accepting'
  | 'framework_unsupported'
  | 'no_compatible_image'
  | 'no_gpu'
  | 'memory_unknown'
  | 'insufficient_memory'
  | 'data_pinned';

export interface RankedNode {
  key: string;
  score: number;
  pressure: number;
}

export interface PlacementResult {
  /** Best first. Walk it for failover. Empty means nothing can run the job right now. */
  candidates: RankedNode[];
  rejected: Array<{ key: string; reason: RejectReason }>;
}

/** Unknown is never optimistic. Same neutral value Hub Pool uses for a stale queue depth. */
const UNKNOWN_LOAD = 1;
const UNKNOWN_PRESSURE = 1;

const TIER_RANK: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2, 'cpu-only': 3, insufficient: 4 };
const UNKNOWN_TIER_RANK = 2;
/** Local is never out-ranked on hardware; local versus peer is decided by `localAffinity`. */
const LOCAL_TIER_RANK = -1;

function isStale(node: PlacementNode, opts: PlacementOptions): boolean {
  return node.snapshotAgeMs !== null && node.snapshotAgeMs > opts.staleAfterMs;
}

function rejectionFor(node: PlacementNode, req: PlacementRequest, opts: PlacementOptions): RejectReason | null {
  if (!node.acceptingTraining) return 'not_accepting';
  if (!node.frameworks.includes(req.framework)) return 'framework_unsupported';
  if (!req.images.some((img) => node.images.includes(img))) return 'no_compatible_image';
  if (req.device === 'gpu' && !node.hasGpu) return 'no_gpu';
  if (req.dataHome !== null && node.key !== req.dataHome && !req.allowRemoteOffload) return 'data_pinned';
  // Memory is a hard constraint, so a stale or missing figure rejects rather than ranks neutral.
  if (node.freeMemoryMb === null || isStale(node, opts)) return 'memory_unknown';
  if (node.freeMemoryMb < req.requiredMemoryMb) return 'insufficient_memory';
  return null;
}

export function rankNodesForJob(req: PlacementRequest, nodes: readonly PlacementNode[], options: Partial<PlacementOptions> = {}): PlacementResult {
  const opts: PlacementOptions = { ...DEFAULT_PLACEMENT_OPTIONS, ...options };
  const rejected: PlacementResult['rejected'] = [];
  const ranked: Array<RankedNode & { tierRank: number }> = [];

  for (const node of nodes) {
    const reason = rejectionFor(node, req, opts);
    if (reason) {
      rejected.push({ key: node.key, reason });
      continue;
    }

    const trainingLoad = node.activeTrainingJobs ?? UNKNOWN_LOAD;
    const inferenceLoad = node.inferenceInFlight ?? UNKNOWN_LOAD;
    const pressure = node.gpuPressure ?? UNKNOWN_PRESSURE;

    let score = trainingLoad + opts.inferenceWeight[req.priority] * inferenceLoad + opts.pressureWeight * pressure;
    if (node.isLocal) score -= opts.localAffinity;
    else if (req.dataHome !== null && node.key !== req.dataHome) score += opts.remotePenalty;

    ranked.push({
      key: node.key,
      score,
      pressure,
      tierRank: node.isLocal ? LOCAL_TIER_RANK : (TIER_RANK[node.tier ?? ''] ?? UNKNOWN_TIER_RANK),
    });
  }

  ranked.sort((a, b) => a.score - b.score || a.pressure - b.pressure || a.tierRank - b.tierRank || a.key.localeCompare(b.key));

  return { candidates: ranked.map(({ key, score, pressure }) => ({ key, score, pressure })), rejected };
}
