import type { PoolNodeSummary, PoolPeerSummary, RoutingLogEntry } from '@/modules/system/use-dashboard-data';
import { peerLabel } from '@/modules/system/use-dashboard-data';

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
  cpuPercent: number;
  memoryUsageBytes: number;
  containers: { state: string }[];
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
export function localContainerRollup(apps: LocalContainerSource[] | undefined): NodeContainers | null {
  if (!apps) return null;

  let running = 0;
  let total = 0;
  let cpuPercent = 0;
  let memoryBytes = 0;

  for (const app of apps) {
    cpuPercent += Number.isFinite(app.cpuPercent) ? app.cpuPercent : 0;
    memoryBytes += Number.isFinite(app.memoryUsageBytes) ? app.memoryUsageBytes : 0;
    for (const container of app.containers ?? []) {
      total += 1;
      if (container.state === 'running') running += 1;
    }
  }

  return { running, stopped: total - running, total, cpuPercent, memoryBytes };
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
  models: number;
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
  const parsed = peer.lastSeenAt ? Date.parse(peer.lastSeenAt.includes('T') ? peer.lastSeenAt : `${peer.lastSeenAt.replace(' ', 'T')}Z`) : Number.NaN;
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
  options: { localLabel: string; localContainers: NodeContainers | null; healthPollSeconds?: number; now: number },
): PoolNodeCard[] {
  const cards: PoolNodeCard[] = [];

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
      models: countModels(local.backends),
      inFlight: typeof local.inFlightRequests === 'number' ? local.inFlightRequests : null,
      inFlightMeaning: 'local-engines',
      peerReportedInFlight: null,
      pressureBand: typeof local.gpuPressure === 'number' ? local.gpuPressure : null,
      pressureSource: local.gpuPressureSource ?? null,
      containers: options.localContainers,
      lastSeenAt: null,
      consecutiveFailures: null,
      capabilitiesError: local.capabilitiesError ?? null,
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
      models: peer.status === 'connected' ? countModels(peer.lastCapabilities?.backends) : 0,
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
    });
  }

  return cards;
}

/** One poll's in-flight reading for every node on screen, ready for {@link appendPoolSample}. */
export function sampleInFlight(cards: PoolNodeCard[]): Record<string, number | null> {
  return Object.fromEntries(cards.map((card) => [card.key, card.inFlight]));
}

// ── Routing activity ─────────────────────────────────────────────────────────

/** One time bucket of routing decisions, oldest first. */
export interface RoutingBucket {
  /** Bucket start, ms since epoch. */
  at: number;
  served: number;
  failed: number;
}

/**
 * Routing decisions over time, binned from the log's OWN timestamps.
 *
 * This is the one genuine history the pool exposes: the routing log is a 200-entry ring in which
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
  const counts = new Map<number, { served: number; failed: number }>();

  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at)) continue;

    const bucket = Math.floor(at / bucketMs) * bucketMs;
    if (bucket < oldest || bucket > newest) continue;

    const slot = counts.get(bucket) ?? { served: 0, failed: 0 };
    if (entry.outcome === 'served') slot.served += 1;
    else slot.failed += 1;
    counts.set(bucket, slot);
  }

  return Array.from({ length: buckets }, (_, index) => {
    const at = oldest + index * bucketMs;
    const slot = counts.get(at);

    return { at, served: slot?.served ?? 0, failed: slot?.failed ?? 0 };
  });
}

/** Headline counts for the activity feed, over the entries actually held. */
export interface RoutingActivity {
  total: number;
  served: number;
  failed: number;
  failovers: number;
  inbound: number;
  outbound: number;
  /** Outbound attempts no node took. Distinct from `failed`: nothing was even tried at a node. */
  unplaced: number;
}

/**
 * What the held log says, counted once.
 *
 * `unplaced` counts OUTBOUND rows with no serving node — the case `routingByNode` buckets under
 * its own label rather than crediting to `local`. It is deliberately not folded into `failed`:
 * "we asked four nodes and all four refused" and "we had no candidate to ask" send an operator to
 * different settings.
 */
export function routingActivity(entries: RoutingLogEntry[]): RoutingActivity {
  const activity: RoutingActivity = { total: entries.length, served: 0, failed: 0, failovers: 0, inbound: 0, outbound: 0, unplaced: 0 };

  for (const entry of entries) {
    if (entry.outcome === 'served') activity.served += 1;
    else activity.failed += 1;

    if ((entry.failedOverFrom?.length ?? 0) > 0) activity.failovers += 1;

    if (entry.direction === 'inbound') {
      activity.inbound += 1;
      continue;
    }

    activity.outbound += 1;
    if (!entry.node) activity.unplaced += 1;
  }

  return activity;
}
