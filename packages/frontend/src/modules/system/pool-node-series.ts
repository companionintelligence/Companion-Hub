import { parseHubTimestamp } from '@/components/ui/dense/dense';
import type {
  LoadState,
  PoolNodeSummary,
  PoolPeerSummary,
  PoolStatusSummary,
  PoolThroughputEstimate,
  RoutingLogEntry,
  RoutingLogPage,
} from '@/modules/system/use-dashboard-data';
import { estimatedPromptTokens, isUnplaced, peerLabel } from '@/modules/system/use-dashboard-data';

/*
 * The pool's live view, as pure functions.
 *
 * Everything here exists because the Hub publishes CAPABILITY, not TELEMETRY. A peer answers
 * "what can I serve and how busy am I right now"; nothing anywhere returns a peer's history.
 * So the only per-node trend this product can honestly draw is one THIS BROWSER watched
 * accumulate while the page was open, and the accumulation rules matter more than the drawing:
 *
 *   - a poll that FAILED appends nothing, so the line stops rather than dropping to zero;
 *   - a node absent from a poll that succeeded appends `null`, so the line BREAKS rather than
 *     interpolating across time we never sampled;
 *   - samples are deduped on the fetch timestamp, because React re-renders far more often than
 *     the query refetches and a second sample of the same payload manufactures a flat run that
 *     looks like measured idleness.
 *
 * The one number that moves fast enough to be worth this is `inFlightRequests`: the load service
 * holds it for the WHOLE request including token streaming, so a 40-second generation reads 1 for
 * 40 seconds and a 15s poll catches it. Container CPU, hardware and model inventories are all
 * behind 20-90s server caches and would draw a staircase of the poll rather than of the machine.
 */

/** Samples kept per node: 40 x 15s poll ≈ 10 minutes of watched time. */
export const POOL_SAMPLE_LIMIT = 40;

/**
 * A peer's self-reported in-flight count is a remote machine's claim about itself, arriving
 * through free-form jsonb. Same ceiling reasoning as the backend's container clamps: above this
 * it is not a busy node, it is a broken or hostile one.
 */
const MAX_REPORTED_IN_FLIGHT = 10_000;

/** How many health polls a peer's self-report stays trusted for. Mirrors `CAPABILITIES_FRESHNESS_POLLS`. */
const CAPABILITIES_FRESHNESS_POLLS = 3;

/** Default used when `/pool/status` did not report the operator's poll interval. */
const DEFAULT_HEALTH_POLL_SECONDS = 30;

/**
 * One poll of `/pool/status`, reduced to the only field worth a time axis.
 *
 * `inFlight` maps node key to that poll's count. A key with `null`, or a key absent from the
 * map entirely, means the poll succeeded and that node reported no counter — which renders as
 * a break in the line, never as zero.
 */
export interface PoolSample {
  /** The query's `dataUpdatedAt`. Both the x-position and the dedupe key. */
  at: number;
  inFlight: Record<string, number | null>;
}

export interface PoolSampleWindow {
  samples: PoolSample[];
}

export const EMPTY_SAMPLE_WINDOW: PoolSampleWindow = { samples: [] };

/**
 * Add one observed poll to the window, or return the window untouched.
 *
 * Returns the SAME object reference when the sample is rejected, so a `useState` updater can be
 * called on every render and React still bails out of the re-render.
 *
 * Rejects a sample whose timestamp is not strictly newer than the newest one held. That is the
 * dedupe rule, and it is a timestamp rule rather than a deep-equality one on purpose: two polls
 * 15s apart that both read 0 are two real observations and both belong on the axis, while one
 * payload re-read by three components in the same tick is one observation.
 */
export function appendPoolSample(window: PoolSampleWindow, sample: PoolSample, limit = POOL_SAMPLE_LIMIT): PoolSampleWindow {
  if (!Number.isFinite(sample.at)) return window;

  const newest = window.samples.at(-1);
  if (newest && sample.at <= newest.at) return window;

  const samples = [...window.samples, sample];

  return { samples: samples.length > limit ? samples.slice(samples.length - limit) : samples };
}

/**
 * One node's watched in-flight series, aligned to the window's shared time axis.
 *
 * `null` is a gap — the poll landed but this node was not in it (a peer that had not been paired
 * yet, or one that has since been removed). Callers must break the line there rather than joining
 * across it: the node was not idle during that minute, it was not observed.
 */
export function nodeInFlightSeries(window: PoolSampleWindow, nodeKey: string): (number | null)[] {
  return window.samples.map((sample) => {
    const value = sample.inFlight[nodeKey];

    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  });
}

/** How many of a series' points are real observations. Below 2 there is no trend to draw. */
export function observedPointCount(series: (number | null)[]): number {
  return series.filter((point) => point !== null).length;
}

/**
 * Y-axis for a small-integer COUNT — in-flight requests, decisions per bucket.
 *
 * Deliberately not `computeCpuChartScale`, which floors its ceiling at 100 because Docker CPU
 * percentages legitimately exceed one core. Feeding a 0-3 request count through that axis draws
 * every real value as a flat line hugging the baseline — visually identical to no data, which is
 * exactly the "wide empty box with one thin spike" this page is being fixed for.
 *
 * The floor is 1, not 0: an axis of height zero cannot be drawn, and a genuinely idle node should
 * read as a flat line along the bottom of a 0-1 axis rather than as a divide-by-zero.
 */
export function computeCountChartScale(values: (number | null | undefined)[]): { max: number; ticks: number[] } {
  const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const dataMax = finite.length > 0 ? Math.max(...finite) : 0;
  const max = Math.max(1, Math.ceil(dataMax));

  if (max <= 4) {
    return { max, ticks: Array.from({ length: max + 1 }, (_, tick) => tick) };
  }

  // Four bands above 4, rounded up so the top tick is the axis maximum rather than near it.
  const step = Math.ceil(max / 4);
  const ceiling = step * 4;
  return { max: ceiling, ticks: [0, step, step * 2, step * 3, ceiling] };
}

// ── Node cards ───────────────────────────────────────────────────────────────

/** The container rollup a node reports, or `null` for "not reported". Never zeros. */
export interface NodeContainers {
  running: number;
  stopped: number;
  total: number;
  cpuPercent: number;
  memoryBytes: number;
}

/** The per-app container sample `/apps/resource-monitor` returns, reduced to what a rollup needs. */
export interface LocalContainerSource {
  /**
   * ⚠ THE PER-APP TOTALS ARE DELIBERATELY NOT READ by {@link localContainerRollup}. They fold in
   * the Hub's own Node process, which the container count excludes — so summing them puts the two
   * halves of the rollup on different populations and makes the local card incomparable with the
   * peer cards beside it. Kept on the type because callers pass the whole snapshot row.
   */
  cpuPercent: number;
  memoryUsageBytes: number;
  containers: { containerId: string; state: string; cpuPercent: number; memoryUsageBytes: number }[];
}

/**
 * This Hub's own container rollup, in the same shape a peer publishes about itself.
 *
 * Built from `/apps/resource-monitor` because `/pool/status.localNode` carries no container
 * numbers at all — the local rollup exists only inside the capability payload peers fetch from
 * US. Reading `localNode.containers` would draw this machine as permanently "not reported" while
 * it runs a dozen containers.
 *
 * `undefined` in, `null` out: the snapshot has not arrived (or the request failed), which is "not
 * reported", not "nothing running". An empty apps array IS a measurement and rolls up to zeros.
 *
 * `stopped` is `total - running`, matching the peer-side definition exactly, so the two cards'
 * numbers mean the same thing. Docker's state enum is wider than running/stopped and everything
 * that is not `running` lands in `stopped`, because the question is "how much of this box is
 * doing work".
 */
/**
 * Marks the synthetic entry the Hub adds for its own Node process on a host where the backend is
 * not containerised. It is a process, not a container — mirrors `PROCESS_RUNTIME_ID_PREFIX` in
 * `app-runtime-monitor.service.ts`, which is what every peer's rollup filters on.
 */
const PROCESS_RUNTIME_ID_PREFIX = 'pid:';

export function localContainerRollup(apps: LocalContainerSource[] | undefined): NodeContainers | null {
  if (!apps) return null;

  /*
   * ⚠ LEAF CONTAINERS, AND THE `pid:` ENTRY EXCLUDED — because this number sits on a card beside
   * numbers a PEER published about itself, and the whole point of the grid is comparing them.
   *
   * `AppRuntimeMonitorService.containerRollup` — the canonical rollup every peer sends — flatMaps
   * to leaf containers and drops the synthetic `pid:` entry the Hub adds for its own Node process
   * on a non-containerised host. Its comment gives the reason: summing per-app totals "would count
   * a process the container count excludes and put the two halves of this payload on different
   * populations".
   *
   * Summing `app.cpuPercent` here did exactly that. The local card read one container higher than a
   * peer would report for the identical machine, and its CPU and memory included the Hub's own API
   * process. Two cards side by side, silently measuring different things.
   */
  const containers = apps.flatMap((app) => app.containers ?? []).filter((container) => !container.containerId.startsWith(PROCESS_RUNTIME_ID_PREFIX));

  const running = containers.filter((container) => container.state === 'running').length;
  const cpuPercent = containers.reduce((sum, c) => sum + (Number.isFinite(c.cpuPercent) ? c.cpuPercent : 0), 0);
  const memoryBytes = containers.reduce((sum, c) => sum + (Number.isFinite(c.memoryUsageBytes) ? c.memoryUsageBytes : 0), 0);

  return {
    running,
    stopped: containers.length - running,
    total: containers.length,
    cpuPercent: Number(cpuPercent.toFixed(2)),
    memoryBytes,
  };
}

/**
 * What one node card renders. Assembled here rather than in the component because local and peer
 * nodes are the same card built from DIFFERENT and partly incompatible measurements, and every
 * one of those asymmetries has an obvious wrong answer that looks fine on screen.
 */
export interface PoolNodeCard {
  /** Stable React key and sample-window key. `'local'` for this Hub, the peer row id otherwise. */
  key: string;
  label: string;
  local: boolean;
  fqdn: string | null;
  direction: string | null;
  /** `'local' | 'connected' | 'pending' | 'unreachable' | 'disabled'`. */
  status: string;
  hardwareTier: string | null;
  backends: { type: string; healthy: boolean | null; models: number }[];
  /** Models this node holds on disk across its HEALTHY backends — what it could actually serve. */
  /**
   * Models the node holds, or NULL when we could not ask.
   *
   * ⚠ NOT 0 FOR AN UNREACHABLE PEER. A count of zero is a claim that the node holds nothing; a
   * peer we cannot reach has told us nothing, and the engine chips on the same card still render
   * its LAST KNOWN per-engine counts from cache. Encoding "unknown" as 0 put those two on the same
   * card contradicting each other — `ollama 2` above, `Models held 0` below.
   */
  models: number | null;
  /**
   * The in-flight counter, and what it counts — which is NOT the same quantity on the two kinds
   * of card. See {@link inFlightMeaning}.
   */
  inFlight: number | null;
  inFlightMeaning: 'local-engines' | 'forwarded-by-us';
  /** The peer's OWN engine load, clamped and freshness-gated, or `null`. Absent on the local card. */
  peerReportedInFlight: number | null;
  /** Effective 0-3 band as routing believes it, or `null` for unmeasured. 0 is a real measurement. */
  pressureBand: number | null;
  pressureSource: string | null;
  containers: NodeContainers | null;
  lastSeenAt: string | null;
  consecutiveFailures: number | null;
  capabilitiesError: string | null;
  /**
   * Time to first byte for requests this node served in the window, or `null` when it served none.
   * See {@link firstByteByNode} for what is excluded and why.
   */
  firstByte: FirstByteStats | null;
  /** The freshest generation rate anyone measured for this node, or `null`. See {@link latestDecode}. */
  decode: DecodeReading | null;
  /** How the peer authenticates to us (`signed` | `bearer`). Absent on the local card and on older Hubs. */
  authMode?: string | null;
  /** The kind of the peer's current run of failed probes, or `null` while its probes succeed. */
  probeFailure?: string | null;
  /**
   * The peer's own `acceptingWork` flag from its last snapshot: `false` when it has switched inbound
   * off or disabled us, which the proxy skips it on. `null` when it never said (an older build, which
   * never refuses) or there is no snapshot. Absent on the local card.
   */
  acceptingWork?: boolean | null;
}

function countModels(backends: { healthy?: boolean; modelsLoaded?: string[] }[] | undefined): number {
  return (backends ?? []).filter((backend) => backend.healthy !== false).reduce((sum, backend) => sum + (backend.modelsLoaded?.length ?? 0), 0);
}

function describeBackends(backends: { type: string; healthy?: boolean; modelsLoaded?: string[] }[] | undefined) {
  return (backends ?? []).map((backend) => ({
    type: backend.type,
    healthy: typeof backend.healthy === 'boolean' ? backend.healthy : null,
    models: backend.modelsLoaded?.length ?? 0,
  }));
}

/**
 * A peer's self-reported queue depth, or `null`.
 *
 * Three separate reasons to refuse it, and all three render identically as "not reported":
 * the peer never sent one, the value is not a believable count, or the snapshot it came in is
 * older than the backend's own freshness window and therefore describes a peer that may have
 * been busy ten minutes ago. This is the one field read out of the raw `lastCapabilities` jsonb,
 * which the peer fully controls and which `toPublicPeer` does not clamp — so it is clamped here.
 */
export function peerReportedInFlight(peer: PoolPeerSummary, healthPollSeconds: number | undefined, now: number): number | null {
  const raw = (peer.lastCapabilities as { inFlightRequests?: unknown } | null | undefined)?.inFlightRequests;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_REPORTED_IN_FLIGHT) return null;

  const pollSeconds = typeof healthPollSeconds === 'number' && healthPollSeconds > 0 ? healthPollSeconds : DEFAULT_HEALTH_POLL_SECONDS;
  // `lastSeenAt` comes out of a zoneless Postgres column — see `parseHubTimestamp`.
  const parsed = parseHubTimestamp(peer.lastSeenAt);
  if (!Number.isFinite(parsed)) return null;

  return now - parsed <= pollSeconds * CAPABILITIES_FRESHNESS_POLLS * 1000 ? raw : null;
}

/**
 * Every node in the pool as one uniform list of cards — this Hub first, then its peers.
 *
 * Three asymmetries are resolved here, each of which is a bug the moment it is resolved in a
 * component that treats "a node is a node":
 *
 * 1. CONTAINERS. `/pool/status.localNode` carries none — the local rollup is only ever built for
 *    the OUTBOUND capability payload peers fetch. This Hub's own container numbers come from
 *    `/apps/resource-monitor`, so they are passed in separately. A card that read
 *    `localNode.containers` would draw a busy machine as permanently "not reported".
 *
 * 2. IN-FLIGHT. `localNode.inFlightRequests` is work OUR engines are serving. `peer.inFlightRequests`
 *    is work WE FORWARDED THERE and have not finished reading — a local counter about a remote node,
 *    permanently 0 on a Hub that only receives. Two quantities, so two labels; `inFlightMeaning`
 *    carries which one this card holds.
 *
 * 3. CONTAINERS AND PRESSURE ON A PEER come from the clamped, freshness-gated sibling fields, never
 *    from the raw `lastCapabilities` blob that ships alongside them.
 */
export function poolNodeCards(
  local: PoolNodeSummary | undefined,
  peers: PoolPeerSummary[],
  options: {
    localLabel: string;
    localContainers: NodeContainers | null;
    healthPollSeconds?: number;
    now: number;
    /** From {@link firstByteByNode}. Absent reads as "no node served anything in the window". */
    firstByte?: Map<string, FirstByteStats>;
  },
): PoolNodeCard[] {
  const cards: PoolNodeCard[] = [];
  const firstByteFor = (key: string | null | undefined) => (key ? (options.firstByte?.get(key) ?? null) : null);

  if (local) {
    cards.push({
      key: 'local',
      label: options.localLabel,
      local: true,
      fqdn: local.nodeFqdn ?? null,
      direction: null,
      status: 'local',
      hardwareTier: local.hardwareTier ?? null,
      backends: describeBackends(local.backends),
      // A Hub that could not read its own engines sends `backends: []` beside the error, and counting
      // that empty list said "0 models" about engines nobody asked.
      models: local.capabilitiesError ? null : countModels(local.backends),
      inFlight: typeof local.inFlightRequests === 'number' ? local.inFlightRequests : null,
      inFlightMeaning: 'local-engines',
      peerReportedInFlight: null,
      pressureBand: typeof local.gpuPressure === 'number' ? local.gpuPressure : null,
      pressureSource: local.gpuPressureSource ?? null,
      containers: options.localContainers,
      lastSeenAt: null,
      consecutiveFailures: null,
      capabilitiesError: local.capabilitiesError ?? null,
      firstByte: firstByteFor(LOCAL_NODE_KEY),
      decode: latestDecode(local.throughput),
    });
  }

  for (const peer of [...peers].sort((a, b) => peerLabel(a).localeCompare(peerLabel(b)))) {
    cards.push({
      key: peer.id,
      label: peerLabel(peer),
      local: false,
      fqdn: peer.nodeFqdn ?? null,
      direction: peer.direction ?? null,
      // Operator-disabled outranks the lifecycle status: routing will not use this node whatever
      // its socket says, and a green "connected" card for a peer taken out of service is a lie.
      status: peer.enabled === false ? 'disabled' : (peer.status ?? 'pending'),
      hardwareTier: peer.lastCapabilities?.hardwareTier ?? null,
      backends: describeBackends(peer.lastCapabilities?.backends),
      // A peer that is not connected holds only a cached inventory; counting it presents capacity
      // that has stopped answering as live.
      // null, not 0 — see `models` on the card type. The chips beside it show cached counts.
      // A connected peer with no snapshot is unknown too: that is every peer between approval and
      // its first probe, and one whose cache was cleared when it answered 401/403 while its row
      // stays connected. The proxy skips it for the same reason, so a "0" there was a healthy-looking
      // zero about a node nobody could ask.
      models: peer.status === 'connected' && peer.lastCapabilities ? countModels(peer.lastCapabilities.backends) : null,
      inFlight: typeof peer.inFlightRequests === 'number' ? peer.inFlightRequests : null,
      inFlightMeaning: 'forwarded-by-us',
      peerReportedInFlight: peerReportedInFlight(peer, options.healthPollSeconds, options.now),
      pressureBand: typeof peer.gpuPressure === 'number' ? peer.gpuPressure : null,
      pressureSource: null,
      // `null` AND absent both mean "not reported" — the backend always sets the key and writes
      // `null` for a stale, rejected or withheld rollup, so a truthiness check that let `null`
      // through would render five zeros the peer never sent.
      containers: peer.containers ?? null,
      lastSeenAt: peer.lastSeenAt ?? null,
      consecutiveFailures: typeof peer.consecutiveFailures === 'number' ? peer.consecutiveFailures : null,
      capabilitiesError: null,
      // The routing log names a peer by FQDN; its first label is the key both sides agree on.
      firstByte: firstByteFor(peer.nodeFqdn?.split('.')[0]),
      decode: latestDecode([...(peer.throughput?.observed ?? []), ...(peer.throughput?.advertised ?? [])]),
      authMode: peer.authMode ?? null,
      probeFailure: peer.probeFailure?.kind ?? null,
      acceptingWork: typeof peer.lastCapabilities?.acceptingWork === 'boolean' ? peer.lastCapabilities.acceptingWork : null,
    });
  }

  return cards;
}

/** A generation rate, and whose. */
export interface DecodeReading {
  tokensPerSec: number;
  model: string;
  ageMs: number;
}

/**
 * The freshest decode (generation) rate in a node's throughput evidence, or `null`.
 *
 * Freshest rather than fastest or averaged: the evidence is per (backend, model), and a node that
 * generated at 40 tok/s on a 7B an hour ago and at 11 tok/s on a 27B a minute ago is, right now, an
 * 11 tok/s node for the work it is being given. The model is carried with the rate so the reader
 * can tell which of those they are looking at.
 *
 * DECODE ONLY. The prefill points in the same estimate are divided by the whole prompt's size on
 * turns the engine served mostly from its prefix cache, and read 13,000-34,000 tok/s — see
 * `PoolThroughputEstimate`. They are never shown.
 */
export function latestDecode(estimates: PoolThroughputEstimate[] | null | undefined): DecodeReading | null {
  let best: DecodeReading | null = null;

  for (const estimate of estimates ?? []) {
    const decode = estimate?.decode;
    if (!decode || !Number.isFinite(decode.tokensPerSec) || decode.tokensPerSec <= 0 || !Number.isFinite(decode.ageMs)) continue;
    if (best === null || decode.ageMs < best.ageMs) {
      best = { tokensPerSec: decode.tokensPerSec, model: estimate.model, ageMs: decode.ageMs };
    }
  }

  return best;
}

/** One poll's in-flight reading for every node on screen, ready for {@link appendPoolSample}. */
export function sampleInFlight(cards: PoolNodeCard[]): Record<string, number | null> {
  return Object.fromEntries(cards.map((card) => [card.key, card.inFlight]));
}

// ── Routing activity ─────────────────────────────────────────────────────────

/**
 * One time bucket of routing decisions, oldest first.
 *
 * `served + failed + pending` is every decision placed in the minute. The rest are SUBSETS of those
 * rows, counted here so that every figure the page states "in the last 30 minutes" is summed from the
 * same bins — the rail, the bars and the verdict can then never disagree about the same half hour.
 */
export interface RoutingBucket {
  /** Bucket start, ms since epoch. */
  at: number;
  served: number;
  /** Settled without an answer. Never includes a request still waiting — see `pending`. */
  failed: number;
  /**
   * Placed and still waiting for a first byte. Its own figure because it is not a failure YET: a
   * 40k-token agent turn waits 5-6 minutes for prefill (beta-max, `qwen3.8:27b`, 39,668 tokens: first
   * byte at 370,941 ms), and counting it as failed for that whole wait painted a red bar under a
   * request that went on to succeed.
   */
  pending: number;
  /** Outbound decisions with no candidate at all — see `isUnplaced`. */
  unplaced: number;
  /** Decisions where at least one node was tried and rejected before the one that answered (or none did). */
  failovers: number;
  /** The subset of `failed` that ended because the caller hung up, not because routing failed. */
  clientClosed: number;
  /** The subset of `failed` that took at least a first-byte budget to fail — see {@link isOverBudgetFailure}. */
  overBudget: number;
  /** Engine-reported prompt tokens on rows placed in this minute. Rows with no usage frame add nothing. */
  promptTokens: number;
  /** Engine-reported output tokens, likewise. */
  completionTokens: number;
}

const EMPTY_BUCKET: Omit<RoutingBucket, 'at'> = {
  served: 0,
  failed: 0,
  pending: 0,
  unplaced: 0,
  failovers: 0,
  clientClosed: 0,
  overBudget: 0,
  promptTokens: 0,
  completionTokens: 0,
};

/** A bucket with nothing in it, at `at`. Exported for callers and tests that build buckets by hand. */
export function emptyRoutingBucket(at: number): RoutingBucket {
  return { at, ...EMPTY_BUCKET };
}

/** Every decision placed in a bucket, whatever became of it. */
export function bucketTotal(bucket: RoutingBucket): number {
  return bucket.served + bucket.failed + bucket.pending;
}

/**
 * The share of `budgetMs` a failed row's duration must reach to count as past it. Not 1.0: a row
 * that died on its node's timer settles a few ms over the budget, but one clock read either side of
 * a GC pause should not decide which bucket it falls in.
 */
const OVER_BUDGET_SHARE = 0.95;

/**
 * `true` for a settled failure that took at least one first-byte budget to fail — how an agent turn
 * placed on a node too slow for its prompt fails on this fleet, and something "Failed" alone did not
 * separate from nodes refusing the work outright.
 *
 * The proxy gives each candidate `budgetMs` to send headers and aborts at exactly that ("No response
 * headers within 329000ms"), so a failure that waited on a deadline carries `status: null` and a
 * `durationMs` at or past the budget. Excluded: a caller hanging up (`clientClosed`), and failures
 * that were over sooner — core-2's nine refusals at 23:51, 307 s against a 780 s budget.
 *
 * Named "past budget", not "timed out", on purpose. `durationMs` is the whole request's, and the row
 * does not say how each candidate failed, so nine slow refusals can add up past one budget with no
 * node timing out — rare against the 300 s floor, but possible, and this must not claim a deadline
 * it cannot see. What it does say is true either way: the caller waited longer than any one node was
 * allowed to take, and got nothing.
 */
export function isOverBudgetFailure(entry: RoutingLogEntry): boolean {
  if (entry.outcome === 'served' || entry.outcome === 'pending' || entry.clientClosed === true) return false;
  if (entry.status !== null && entry.status !== undefined) return false;
  if (typeof entry.budgetMs !== 'number' || entry.budgetMs <= 0 || typeof entry.durationMs !== 'number') return false;

  return entry.durationMs >= OVER_BUDGET_SHARE * entry.budgetMs;
}

/** A finite, positive usage figure or 0. `null` is the common case (no usage frame) and contributes nothing. */
function usageCount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Routing decisions over time, binned from the log's OWN timestamps.
 *
 * This is the one genuine history the pool exposes: the routing log is a bounded ring (200 rows by default) in which
 * every record carries the wall-clock instant of the decision, so the shape of the last N minutes
 * is measured rather than watched. It needs no browser accumulation and survives a page reload.
 *
 * It is still a record of DECISIONS, not of work in progress. A bucket counts requests that were
 * ROUTED in that minute; a generation that started there and ran for four more contributes to the
 * one bucket and nothing else. That is why this is drawn as bars over completed intervals and
 * never as a load curve.
 *
 * Buckets are emitted contiguously, so a minute in which nothing was routed is a real zero rather
 * than a missing bar — an interval the log covers and in which nothing happened IS a measurement.
 */
export function routingBuckets(entries: RoutingLogEntry[], options: { now: number; bucketMs: number; buckets: number }): RoutingBucket[] {
  const { now, bucketMs, buckets } = options;
  if (bucketMs <= 0 || buckets <= 0) return [];

  const newest = Math.floor(now / bucketMs) * bucketMs;
  const oldest = newest - (buckets - 1) * bucketMs;
  const counts = new Map<number, RoutingBucket>();

  for (const entry of entries) {
    const at = parseHubTimestamp(entry.at);
    if (!Number.isFinite(at)) continue;

    const bucket = Math.floor(at / bucketMs) * bucketMs;
    if (bucket < oldest || bucket > newest) continue;

    const slot = counts.get(bucket) ?? emptyRoutingBucket(bucket);
    // Three-way, matching `routingActivity`: anything neither served nor still waiting is a failure,
    // so an outcome string this page does not know is never silently read as fine.
    if (entry.outcome === 'served') slot.served += 1;
    else if (entry.outcome === 'pending') slot.pending += 1;
    else slot.failed += 1;

    if (isUnplaced(entry)) slot.unplaced += 1;
    if ((entry.failedOverFrom?.length ?? 0) > 0) slot.failovers += 1;
    if (entry.clientClosed === true && entry.outcome !== 'served' && entry.outcome !== 'pending') slot.clientClosed += 1;
    if (isOverBudgetFailure(entry)) slot.overBudget += 1;
    slot.promptTokens += usageCount(entry.usage?.promptTokens);
    slot.completionTokens += usageCount(entry.usage?.completionTokens);
    counts.set(bucket, slot);
  }

  return Array.from({ length: buckets }, (_, index) => {
    const at = oldest + index * bucketMs;

    return counts.get(at) ?? emptyRoutingBucket(at);
  });
}

/**
 * `true` when the log this page holds may be MISSING decisions from the window, so a count summed
 * over it is a floor rather than a total.
 *
 * Two ways rows go missing, and the summary says which has happened: the ring EVICTED them
 * (`totalRecorded > recorded` — it is 200 rows by default and drops the oldest silently), or the ring
 * holds more than the unpaged request returned (`matched > entries.length` — a Hub with
 * `HUB_POOL_ROUTING_LOG_SIZE` raised still serves the newest 200 by default). Either is only a
 * problem for the window if the OLDEST row held is inside it: if the page reaches back past the start
 * of the window, everything in the window is on the page, whatever was dropped before it.
 *
 * Replaces a check for "200 entries held", which mirrored the backend's default capacity by hand and
 * so fired on every busy Hub whether or not the window was affected, and never on a Hub whose ring
 * had been raised.
 */
export function routingWindowPartial(log: RoutingLogPage | undefined, options: { now: number; windowMs: number }): boolean {
  const entries = log?.entries ?? [];
  const recorded = log?.summary?.recorded;
  const totalRecorded = log?.summary?.totalRecorded;
  const evicted = typeof totalRecorded === 'number' && typeof recorded === 'number' && totalRecorded > recorded;
  const paged = typeof log?.matched === 'number' && log.matched > entries.length;
  if (!evicted && !paged) return false;

  // Newest first, so the last row held is the oldest.
  const oldestHeld = parseHubTimestamp(entries.at(-1)?.at);

  return !Number.isFinite(oldestHeld) || oldestHeld > options.now - options.windowMs;
}

/** Headline counts for the activity feed, over the entries actually held. */
export interface RoutingActivity {
  total: number;
  served: number;
  failed: number;
  /** Placed on a node and still waiting for its first byte — minutes, for an agent turn on a self-hosted engine. */
  pending: number;
  failovers: number;
  inbound: number;
  outbound: number;
  /** Outbound requests with no candidate at all. Distinct from `failed`: nothing was even tried at a node. */
  unplaced: number;
  /**
   * Sum of `usage.totalTokens` over held entries that actually carry one — a real, partial count,
   * not an estimate standing in for the entries that don't (see `RoutingLogEntry.usage`). Reads
   * far below `served` today: most served requests still have no usage frame at all.
   */
  tokensServed: number;
}

/**
 * What the held log says, counted once.
 *
 * `unplaced` counts outbound rows that had NO CANDIDATE — see `isUnplaced`. A row where every
 * candidate was tried and failed has no serving node either, and used to be counted here; it is a
 * `failed` row now, and only that. The two send an operator to different settings: "we had no
 * candidate to ask" is about which models the pool holds, "we asked nine nodes and all nine
 * refused" is about why they could not answer.
 */
export function routingActivity(entries: RoutingLogEntry[]): RoutingActivity {
  const activity: RoutingActivity = {
    total: entries.length,
    served: 0,
    failed: 0,
    pending: 0,
    failovers: 0,
    inbound: 0,
    outbound: 0,
    unplaced: 0,
    tokensServed: 0,
  };

  for (const entry of entries) {
    if (entry.outcome === 'served') activity.served += 1;
    else if (entry.outcome === 'pending') activity.pending += 1;
    else activity.failed += 1;

    if ((entry.failedOverFrom?.length ?? 0) > 0) activity.failovers += 1;

    const totalTokens = entry.usage?.totalTokens;
    if (typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens > 0) {
      activity.tokensServed += totalTokens;
    }

    if (entry.direction === 'inbound') {
      activity.inbound += 1;
      continue;
    }

    activity.outbound += 1;
    if (isUnplaced(entry)) activity.unplaced += 1;
  }

  return activity;
}

/** The key {@link firstByteByNode} files this Hub's own engines under — the same key its node card uses. */
export const LOCAL_NODE_KEY = 'local';

/** The node a routing row's work ran on, as a short key: `'local'` for this Hub, else the peer's first DNS label. */
function servingNodeKey(entry: RoutingLogEntry): string | null {
  // An inbound row's `node` is the peer that SENT the work; our own engine served it.
  if (entry.direction === 'inbound') return LOCAL_NODE_KEY;
  if (!entry.node) return null;

  return entry.node === LOCAL_NODE_KEY ? LOCAL_NODE_KEY : entry.node.split('.')[0] || null;
}

/** The request waiting longest for its first byte, and how many are waiting. */
export interface WaitingNow {
  count: number;
  oldest: {
    /** How long the node now holding it has had it — the current ATTEMPT, not the request. See {@link waitingNow}. */
    ageMs: number;
    node: string | null;
    budgetMs: number | null;
    estTokens: number | null;
    /** Nodes that had it and gave up before this one. Their waits are not in `ageMs`. */
    failovers: number;
  } | null;
}

/**
 * When the node now holding a pending row started on it: the row's last failover hop, or its
 * placement when it has never failed over.
 *
 * `updatedAt` is that hop because nothing else moves it while a row is pending: the proxy's
 * `routingLog.update` bumps it when it hands the row to the next candidate, and the next writes
 * are the settle and the usage frame, which take it out of `pending`. It is read only for a row
 * that HAS failed over, so a future write that bumps it for some other reason on a first attempt
 * cannot reset that attempt's clock; and never earlier than `at`, so a Hub predating the field (or
 * a skewed one) falls back to timing from placement, which is what this page did before.
 */
function attemptStartedAt(entry: RoutingLogEntry): number {
  const placed = parseHubTimestamp(entry.at);
  if ((entry.failedOverFrom?.length ?? 0) === 0) return placed;
  const hop = parseHubTimestamp(entry.updatedAt);

  return Number.isFinite(hop) && hop > placed ? hop : placed;
}

/**
 * Requests placed on a node and still waiting for their first byte, right now.
 *
 * The question an operator watching an agent turn actually has — "is anything stuck, where, and for
 * how long against what deadline" — and until this it was answerable only by finding the one amber
 * row in the feed. The oldest wait is the one that matters: it is the one closest to its budget.
 *
 * ⚠ The age is the CURRENT ATTEMPT's, not the request's. The proxy gives every candidate a fresh
 * header deadline (`fetchWithConnectTimeout` starts its own `setTimeout(budget)` per forward) and
 * moves the pending row to the next node without touching `at`. Timed from `at`, a request that
 * failed over read as the new node's wait plus every earlier node's: core-2, 2026-09-26, a turn core-7
 * held for its whole 329 s budget went to core-14 at 23:55:50, and 39 seconds later this said
 * "waiting 6m 8s of 5m 29s on core-14" — past the budget, on the node that had only just taken it.
 * That is the trap `firstByteByNode` avoids by excluding failed-over rows; here the row cannot be
 * excluded (it is the one still waiting), so it is timed from its last hop instead.
 *
 * What it still includes: for a LOCAL candidate the Hub runs residency arbitration before the
 * engine's timer starts (a 27B reload measured ~168 s on core-6), so a request waiting on this Hub
 * behind a reload reads that much older than its deadline does. Nothing on the row marks where
 * the reload ended; the error is on the side of warning early, never late.
 *
 * `node` is the short key (`'local'` for this Hub) — the caller translates it for display.
 */
export function waitingNow(entries: RoutingLogEntry[], now: number): WaitingNow {
  let count = 0;
  let oldest: WaitingNow['oldest'] = null;

  for (const entry of entries) {
    if (entry.outcome !== 'pending') continue;
    count += 1;

    const started = attemptStartedAt(entry);
    if (!Number.isFinite(started)) continue;
    const ageMs = Math.max(0, now - started);
    if (oldest === null || ageMs > oldest.ageMs) {
      oldest = {
        ageMs,
        node: servingNodeKey(entry),
        budgetMs: typeof entry.budgetMs === 'number' && entry.budgetMs > 0 ? entry.budgetMs : null,
        estTokens: estimatedPromptTokens(entry),
        failovers: entry.failedOverFrom?.length ?? 0,
      };
    }
  }

  return { count, oldest };
}

/** Time to first byte over a window, for one node. */
export interface FirstByteStats {
  count: number;
  p50Ms: number;
  maxMs: number;
  /** The prompt-size estimate of the request behind `maxMs`, so a slow figure carries its excuse. */
  maxEstTokens: number | null;
}

/**
 * `true` when a row's `durationMs` IS a time to first byte: served, streamed, and never failed over.
 * Shared by {@link firstByteByNode} and {@link inferenceFromHere} so the two cannot drift apart on
 * which rows count — the reasons for each exclusion are on `firstByteByNode`.
 */
export function isFirstByteSample(entry: RoutingLogEntry): boolean {
  if (entry.outcome !== 'served' || entry.stream !== true || (entry.failedOverFrom?.length ?? 0) > 0) return false;

  return typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) && entry.durationMs >= 0;
}

/**
 * Time to first byte per serving node, over the window — the number that says which node is slow.
 *
 * Only rows where `durationMs` IS a first-byte time are counted, and that excludes more than it
 * looks like it should:
 *
 *   - served only. A failure's duration is how long it took to fail.
 *   - `stream === true` only. A non-streamed request gets response headers after the WHOLE
 *     generation, so its duration is completion time; mixing the two would make a node that happened
 *     to get non-streamed work look minutes slower than its neighbours.
 *   - no failover. `durationMs` runs from the proxy receiving the request, so a row that reached the
 *     second node after the first timed out carries the first node's wait too — core-2's 399,710 ms
 *     row is core-14's answer plus core-7's failure.
 *
 * This Hub's own engines are one entry, `'local'`, built from BOTH directions: outbound rows we
 * placed on ourselves and inbound rows peers placed on us are the same engine answering.
 */
export function firstByteByNode(entries: RoutingLogEntry[], options: { now: number; windowMs: number }): Map<string, FirstByteStats> {
  const samples = new Map<string, { ms: number; estTokens: number | null }[]>();
  const since = options.now - options.windowMs;

  for (const entry of entries) {
    if (!isFirstByteSample(entry)) continue;

    const at = parseHubTimestamp(entry.at);
    if (!Number.isFinite(at) || at < since || at > options.now) continue;

    const key = servingNodeKey(entry);
    if (!key) continue;

    const list = samples.get(key) ?? [];
    list.push({ ms: entry.durationMs as number, estTokens: estimatedPromptTokens(entry) });
    samples.set(key, list);
  }

  const stats = new Map<string, FirstByteStats>();
  for (const [key, list] of samples) {
    const sorted = [...list].sort((a, b) => a.ms - b.ms);
    const slowest = sorted.at(-1);
    // Nearest-rank median: a figure one of these requests actually took, never an average of two.
    const median = sorted[Math.ceil(sorted.length / 2) - 1];
    if (!slowest || !median) continue;
    stats.set(key, { count: sorted.length, p50Ms: median.ms, maxMs: slowest.ms, maxEstTokens: slowest.estTokens });
  }

  return stats;
}

// ── Inference from this Hub ──────────────────────────────────────────────────

/**
 * The span {@link routingBuckets} covers, as `[from, to)`, or `null` for no buckets.
 *
 * Anything else that states a figure "in the last 30 minutes" reads its window from here, so it
 * counts exactly the rows the rail and the per-minute bars count, and never re-reads the clock.
 */
export function bucketWindow(buckets: RoutingBucket[], bucketMs: number): { from: number; to: number } | null {
  const first = buckets[0];
  const last = buckets.at(-1);
  if (!first || !last || bucketMs <= 0) return null;

  return { from: first.at, to: last.at + bucketMs };
}

/** What this Hub's own callers asked the pool for over one window. See {@link inferenceFromHere}. */
export interface OwnInference {
  /** Every request that entered the pool at this Hub and was placed in the window. */
  requests: number;
  served: number;
  /** Settled without an answer — anything neither served nor still waiting, as `routingActivity` counts it. */
  failed: number;
  /**
   * The part of `failed` where the caller hung up first — split out as the rail splits it, because
   * this tile's callers are this Hub's own apps, the ones most likely to give up on a long prefill.
   */
  clientClosed: number;
  /** The part of `failed` that took a whole first-byte budget to fail. See {@link isOverBudgetFailure}. */
  overBudget: number;
  pending: number;
  failovers: number;
  /** Served requests whose response carried a usage frame. The denominator is `served`: only a served request can. */
  usageReported: number;
  promptTokens: number;
  completionTokens: number;
  /** Over served, streamed, never-failed-over requests only — see {@link isFirstByteSample}. `null` when there were none. */
  firstByte: { count: number; p50Ms: number; p90Ms: number | null } | null;
  /** Most-requested models first. `tokens` is `null` when none of that model's requests reported usage. */
  models: { model: string; requests: number; tokens: number | null }[];
  /** Distinct models asked for, so a caller can say how many the list above left out. */
  modelCount: number;
}

/**
 * The fewest samples at which a nearest-rank p90 is not simply the slowest request: `ceil(0.9 × n)`
 * equals `n` for every n up to 9, so below ten "p90" would be the maximum under another name.
 */
const P90_MIN_SAMPLES = 10;

/** Nearest-rank percentile of an ascending list: a figure one of these requests actually took. */
function nearestRank(sorted: number[], share: number): number | undefined {
  return sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)];
}

function hasUsage(entry: RoutingLogEntry): boolean {
  const usage = entry.usage;
  if (!usage) return false;

  return [usage.promptTokens, usage.completionTokens, usage.totalTokens].some((value) => typeof value === 'number' && Number.isFinite(value));
}

/**
 * Requests that ENTERED THE POOL AT THIS HUB over `[from, to)`: `outbound` rows only.
 *
 * The routing log writes `outbound` for every call `PoolProxyService.proxyRequest` handles, and
 * `inbound` for work a peer forwarded to our engines (`hub-pool-routing-log.service.ts`). Who can
 * make an outbound call is whoever `InferenceAccessGuard` admits: anything whose address is private
 * — this Hub's apps, but also any machine on its LAN or tailnet, since Tailscale's 100.64.0.0/10 is
 * private to it — with no key read at all, and an `inference` API key from anywhere else. So this
 * counts traffic that entered here wherever the pool served it, not "this Hub's apps", and leaves
 * out every peer's traffic that merely ran on our hardware. Calls that never reach `proxyRequest`
 * are not in the log at all; see {@link unloggedCalls}.
 *
 * Tokens are summed exactly as `routingBuckets` sums them, and only outbound rows ever carry usage,
 * so the totals equal Pool activity's 30-minute token chips.
 */
export function inferenceFromHere(entries: RoutingLogEntry[], window: { from: number; to: number }, topModels = 5): OwnInference {
  const own: OwnInference = {
    requests: 0,
    served: 0,
    failed: 0,
    clientClosed: 0,
    overBudget: 0,
    pending: 0,
    failovers: 0,
    usageReported: 0,
    promptTokens: 0,
    completionTokens: 0,
    firstByte: null,
    models: [],
    modelCount: 0,
  };
  const firstBytes: number[] = [];
  const byModel = new Map<string, { requests: number; tokens: number | null }>();

  for (const entry of entries) {
    if (entry.direction !== 'outbound') continue;
    const at = parseHubTimestamp(entry.at);
    if (!Number.isFinite(at) || at < window.from || at >= window.to) continue;

    own.requests += 1;
    if (entry.outcome === 'served') own.served += 1;
    else if (entry.outcome === 'pending') own.pending += 1;
    else {
      own.failed += 1;
      // The same two splits `routingBuckets` makes, so this tile and the rail describe a failure alike.
      if (entry.clientClosed === true) own.clientClosed += 1;
      if (isOverBudgetFailure(entry)) own.overBudget += 1;
    }
    if ((entry.failedOverFrom?.length ?? 0) > 0) own.failovers += 1;

    if (entry.outcome === 'served' && hasUsage(entry)) own.usageReported += 1;
    own.promptTokens += usageCount(entry.usage?.promptTokens);
    own.completionTokens += usageCount(entry.usage?.completionTokens);
    if (isFirstByteSample(entry)) firstBytes.push(entry.durationMs as number);

    // Named even when nothing served it: which model a failing caller asked for is the lead.
    if (entry.model) {
      const slot = byModel.get(entry.model) ?? { requests: 0, tokens: null };
      slot.requests += 1;
      const total = entry.usage?.totalTokens;
      if (typeof total === 'number' && Number.isFinite(total) && total > 0) slot.tokens = (slot.tokens ?? 0) + total;
      byModel.set(entry.model, slot);
    }
  }

  const sorted = firstBytes.sort((a, b) => a - b);
  const p50 = nearestRank(sorted, 0.5);
  const p90 = nearestRank(sorted, 0.9);
  own.firstByte =
    p50 === undefined ? null : { count: sorted.length, p50Ms: p50, p90Ms: sorted.length >= P90_MIN_SAMPLES && p90 !== undefined ? p90 : null };

  own.modelCount = byModel.size;
  own.models = [...byModel.entries()]
    .map(([model, slot]) => ({ model, ...slot }))
    .sort((a, b) => b.requests - a.requests || (b.tokens ?? 0) - (a.tokens ?? 0) || a.model.localeCompare(b.model))
    .slice(0, Math.max(0, topModels));

  return own;
}

/**
 * Which of this Hub's inference calls never reach the routing log, so a count built from it is not
 * the whole of what was asked here.
 *
 * - `none`: both app-facing routes go through `proxyRequest`, which writes a row for every call.
 * - `v1`: `/api/inference/v1/{chat/completions,embeddings}` serve from the local router WITHOUT a row
 *   whenever `hasConnectedPeers()` is false (pooling off, or no peer row `connected`; the per-peer
 *   switch is not consulted). Apps handed `/api/inference/pool/*` — every app while
 *   `poolRouteAppsAlways` is on, its default — are still logged; `HUB_INFERENCE_URL` callers,
 *   editors and SDKs on `/v1` are not.
 * - `apps`: the same, and the switch is off, so apps were handed their engines directly and nothing
 *   they send passes through this Hub at all.
 * - `unknown`: pool status failed or has not answered, so which of the above holds cannot be said.
 *
 * An absent `poolRouteAppsAlways` reads as its default, on: the backend fills the default in before
 * it serialises, so absence only comes from a build that predates the switch.
 */
export type UnloggedCalls = 'none' | 'v1' | 'apps' | 'unknown';

export function unloggedCalls(pool: PoolStatusSummary | undefined, state: LoadState): UnloggedCalls {
  if (state.failed || !pool) return 'unknown';

  const peerConnected = pool.enabled !== false && (pool.peers ?? []).some((peer) => peer.status === 'connected');
  if (peerConnected) return 'none';

  return pool.settings?.poolRouteAppsAlways === false ? 'apps' : 'v1';
}
