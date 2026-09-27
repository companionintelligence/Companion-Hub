import { describe, expect, it } from 'vitest';

import {
  appendPoolSample,
  computeCountChartScale,
  EMPTY_SAMPLE_WINDOW,
  firstByteByNode,
  latestDecode,
  localContainerRollup,
  nodeInFlightSeries,
  observedPointCount,
  peerReportedInFlight,
  poolNodeCards,
  type PoolSampleWindow,
  routingActivity,
  routingBuckets,
  routingWindowPartial,
  sampleInFlight,
  waitingNow,
} from './pool-node-series';
import type { PoolNodeSummary, PoolPeerSummary, RoutingLogEntry } from './use-dashboard-data';

/*
 * The pool view's rules, tested away from React.
 *
 * Almost every case here asserts that something is NOT recorded or NOT drawn: a re-read of the
 * same payload, a poll that failed, a peer that vanished from the list, a container rollup that
 * arrived as `null`. Each has an obvious wrong answer — record it anyway, or render 0 — that
 * would look entirely normal on screen, and three shipped bugs on this page were exactly that.
 */

const window = (...ats: number[]): PoolSampleWindow => ({
  samples: ats.map((at) => ({ at, inFlight: { local: 1 } })),
});

describe('appendPoolSample', () => {
  it('records a poll that is newer than the newest one held', () => {
    const next = appendPoolSample(EMPTY_SAMPLE_WINDOW, { at: 1_000, inFlight: { local: 2 } });

    expect(next.samples).toEqual([{ at: 1_000, inFlight: { local: 2 } }]);
  });

  it('refuses a repeat of the same fetch, so re-renders cannot manufacture a flat run', () => {
    // React re-renders far more often than the query refetches. Counting each render as an
    // observation draws measured idleness out of nothing at all.
    const first = appendPoolSample(EMPTY_SAMPLE_WINDOW, { at: 1_000, inFlight: { local: 3 } });
    const again = appendPoolSample(first, { at: 1_000, inFlight: { local: 3 } });

    expect(again).toBe(first);
    expect(again.samples).toHaveLength(1);
  });

  it('refuses a fetch timestamp that went backwards', () => {
    const held = window(2_000);

    expect(appendPoolSample(held, { at: 1_500, inFlight: {} })).toBe(held);
  });

  it('refuses a sample with no usable timestamp rather than inventing a position for it', () => {
    expect(appendPoolSample(EMPTY_SAMPLE_WINDOW, { at: Number.NaN, inFlight: { local: 1 } })).toBe(EMPTY_SAMPLE_WINDOW);
  });

  it('drops the oldest sample once the window is full, keeping the most recent', () => {
    let held: PoolSampleWindow = EMPTY_SAMPLE_WINDOW;
    for (let at = 1; at <= 5; at += 1) held = appendPoolSample(held, { at, inFlight: { local: at } }, 3);

    expect(held.samples.map((sample) => sample.at)).toEqual([3, 4, 5]);
  });
});

describe('nodeInFlightSeries', () => {
  it('reads one node out of the shared time axis', () => {
    const held: PoolSampleWindow = {
      samples: [
        { at: 1, inFlight: { local: 0, 'peer-a': 2 } },
        { at: 2, inFlight: { local: 1, 'peer-a': 3 } },
      ],
    };

    expect(nodeInFlightSeries(held, 'peer-a')).toEqual([2, 3]);
  });

  it('gaps a poll a node was absent from, rather than reading it as idle', () => {
    // A peer paired mid-session was not idle before it existed, and one that has been removed
    // is not idle now. Both are "not observed", and a zero here would be a claim.
    const held: PoolSampleWindow = {
      samples: [
        { at: 1, inFlight: { local: 1 } },
        { at: 2, inFlight: { local: 1, 'peer-a': 4 } },
      ],
    };

    expect(nodeInFlightSeries(held, 'peer-a')).toEqual([null, 4]);
  });

  it('gaps an explicit null, which is a poll that landed with no counter for the node', () => {
    const held: PoolSampleWindow = { samples: [{ at: 1, inFlight: { 'peer-a': null } }] };

    expect(nodeInFlightSeries(held, 'peer-a')).toEqual([null]);
  });

  it('counts only real observations, so a series of gaps is not a trend', () => {
    expect(observedPointCount([null, 2, null])).toBe(1);
    expect(observedPointCount([null, null])).toBe(0);
  });
});

describe('computeCountChartScale', () => {
  it('gives a small count an axis it is actually visible on', () => {
    // The CPU scale floors its ceiling at 100, which would draw 3 in-flight requests as a flat
    // line on the baseline — indistinguishable from no data.
    expect(computeCountChartScale([0, 1, 3])).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
  });

  it('never returns a zero-height axis for an idle node', () => {
    expect(computeCountChartScale([0, 0, 0])).toEqual({ max: 1, ticks: [0, 1] });
  });

  it('defaults to a drawable axis when nothing has been observed', () => {
    expect(computeCountChartScale([])).toEqual({ max: 1, ticks: [0, 1] });
  });

  it('ignores gaps rather than treating them as zero', () => {
    expect(computeCountChartScale([null, 2, undefined])).toEqual({ max: 2, ticks: [0, 1, 2] });
  });

  it('rounds up to four even bands above a handful', () => {
    const scale = computeCountChartScale([0, 17]);

    expect(scale.max).toBe(20);
    expect(scale.ticks).toEqual([0, 5, 10, 15, 20]);
  });
});

describe('localContainerRollup — parity with what a peer publishes', () => {
  const c = (over: Record<string, unknown> = {}) =>
    ({
      containerId: 'c1',
      name: 'svc',
      state: 'running',
      status: 'Up',
      health: null,
      cpuPercent: 5,
      memoryUsageBytes: 1000,
      memoryLimitBytes: 4000,
      ...over,
    }) as never;

  /*
   * THE BUG THIS PINS. The local card sits beside cards built from what a PEER published about
   * itself, and comparing them is the entire point of the grid. The peer's rollup drops the
   * synthetic `pid:` process; summing per-app totals here did not, so the local node read one
   * container higher and its CPU included the Hub's own API process.
   */
  it('excludes the synthetic pid: process, exactly as a peer rollup does', () => {
    const rollup = localContainerRollup([
      {
        cpuPercent: 99,
        memoryUsageBytes: 9_000,
        containers: [c({ containerId: 'pid:1234', cpuPercent: 90, memoryUsageBytes: 8_000 }), c({ containerId: 'abc' })],
      },
    ] as never);

    expect(rollup).toEqual({ running: 1, stopped: 0, total: 1, cpuPercent: 5, memoryBytes: 1000 });
  });

  it('sums leaf containers, not per-app aggregates', () => {
    // app.cpuPercent is deliberately absurd: reading it instead of the leaves would show it.
    const rollup = localContainerRollup([
      {
        cpuPercent: 500,
        memoryUsageBytes: 500_000,
        containers: [c({ containerId: 'a' }), c({ containerId: 'b', state: 'exited', cpuPercent: 0, memoryUsageBytes: 0 })],
      },
    ] as never);

    expect(rollup?.total).toBe(2);
    expect(rollup?.running).toBe(1);
    expect(rollup?.stopped).toBe(1);
    expect(rollup?.cpuPercent).toBe(5);
  });

  it('returns null rather than zeros when there is no sample', () => {
    expect(localContainerRollup(undefined)).toBeNull();
  });
});

describe('localContainerRollup', () => {
  /*
   * Leaf containers carry their own cpu/memory, because that is what the rollup reads — and what a
   * peer's rollup reads. `cpuPercent`/`memoryUsageBytes` on the APP are set to absurd values here
   * on purpose: if the implementation ever goes back to summing them, these tests show it.
   */
  const app = (states: string[], cpu: number, memory: number) => ({
    cpuPercent: 999,
    memoryUsageBytes: 999_999,
    containers: states.map((state, i) => ({
      containerId: `c${i}`,
      state,
      cpuPercent: cpu / states.length,
      memoryUsageBytes: memory / states.length,
    })),
  });

  it('rolls the local apps up into the same shape a peer publishes', () => {
    expect(localContainerRollup([app(['running', 'exited'], 12.5, 100), app(['running'], 7.5, 50)])).toEqual({
      running: 2,
      stopped: 1,
      total: 3,
      cpuPercent: 20,
      memoryBytes: 150,
    });
  });

  it('is null, not zeros, before the container snapshot has arrived', () => {
    // `/pool/status.localNode` carries no container numbers at all, so this is the only source.
    // A failed or pending fetch is "not reported"; zeros would claim an idle machine.
    expect(localContainerRollup(undefined)).toBeNull();
  });

  it('reports genuine zeros when the snapshot arrived and there is nothing running', () => {
    expect(localContainerRollup([])).toEqual({ running: 0, stopped: 0, total: 0, cpuPercent: 0, memoryBytes: 0 });
  });

  it('counts every non-running docker state as stopped, so the two always sum to the total', () => {
    const rollup = localContainerRollup([app(['running', 'paused', 'restarting', 'dead'], 0, 0)]);

    expect(rollup).toMatchObject({ running: 1, stopped: 3, total: 4 });
  });
});

describe('peerReportedInFlight', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();

  const reporting = (value: unknown, lastSeenAt: string | null): PoolPeerSummary => ({
    id: 'p',
    lastSeenAt,
    lastCapabilities: { inFlightRequests: value as number },
  });

  it('reads a fresh, believable self-report', () => {
    expect(peerReportedInFlight(reporting(2, at(10)), 30, now)).toBe(2);
  });

  it('discards a self-report older than three health polls, as the ranker does', () => {
    // A snapshot two minutes old describes a peer that may have been busy two minutes ago.
    expect(peerReportedInFlight(reporting(9, at(120)), 30, now)).toBeNull();
  });

  it('refuses a hostile value rather than putting it on the operator screen', () => {
    // `lastCapabilities` is free-form jsonb the remote machine controls, and `toPublicPeer`
    // ships it to the browser unclamped.
    expect(peerReportedInFlight(reporting(-1, at(1)), 30, now)).toBeNull();
    expect(peerReportedInFlight(reporting(1.5, at(1)), 30, now)).toBeNull();
    expect(peerReportedInFlight(reporting(99_999_999, at(1)), 30, now)).toBeNull();
    expect(peerReportedInFlight(reporting('lots', at(1)), 30, now)).toBeNull();
  });

  it('is null when the peer never reported one', () => {
    expect(peerReportedInFlight({ id: 'p', lastSeenAt: at(1) }, 30, now)).toBeNull();
  });

  it('is null when there is no last-seen timestamp to judge freshness against', () => {
    expect(peerReportedInFlight(reporting(3, null), 30, now)).toBeNull();
  });
});

describe('poolNodeCards', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const local: PoolNodeSummary = {
    nodeFqdn: 'beta-max.tail.ts.net',
    hardwareTier: 'high',
    inFlightRequests: 2,
    gpuPressure: 0,
    gpuPressureSource: 'amd-drm',
    backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['a', 'b'] }],
  };
  const options = { localLabel: 'This Hub', localContainers: null, healthPollSeconds: 30, now };

  it("gives each card its own first-byte figures, keyed by the node's first DNS label", () => {
    const firstByte = new Map([
      ['local', { count: 2, p50Ms: 300, maxMs: 900, maxEstTokens: null }],
      ['core-7', { count: 1, p50Ms: 16_450, maxMs: 16_450, maxEstTokens: 81 }],
    ]);
    const cards = poolNodeCards(
      local,
      [
        { id: 'p', nodeFqdn: 'core-7.tail.ts.net' },
        { id: 'q', nodeFqdn: 'core-3.tail.ts.net' },
      ],
      { ...options, firstByte },
    );

    expect(Object.fromEntries(cards.map((card) => [card.label, card.firstByte?.maxMs ?? null]))).toEqual({
      'This Hub': 900,
      'core-7': 16_450,
      'core-3': null,
    });
  });

  it("reads a peer's generation rate from what we timed and what it advertised, whichever is fresher", () => {
    const peer: PoolPeerSummary = {
      id: 'p',
      throughput: {
        observed: [{ model: 'qwen3.6:27b', backend: 'ollama', decode: { tokensPerSec: 11, ageMs: 600_000 } }],
        advertised: [{ model: 'qwen3.6:27b', backend: 'ollama', decode: { tokensPerSec: 12, ageMs: 30_000 } }],
      },
    };
    const [, card] = poolNodeCards(local, [peer], options);

    expect(card?.decode).toEqual({ tokensPerSec: 12, model: 'qwen3.6:27b', ageMs: 30_000 });
  });

  it('puts this Hub first and marks it local', () => {
    const cards = poolNodeCards(local, [{ id: 'p', displayName: 'core-7' }], options);

    expect(cards.map((card) => card.key)).toEqual(['local', 'p']);
    expect(cards[0]).toMatchObject({ local: true, status: 'local', label: 'This Hub' });
  });

  it('takes this Hub container numbers from the passed-in rollup, never from pool status', () => {
    // `/pool/status.localNode` has no `containers` field — the local rollup only ever goes into
    // the OUTBOUND payload peers fetch. A card that looked for it there would render a busy
    // machine as permanently "not reported".
    const containers = { running: 4, stopped: 1, total: 5, cpuPercent: 30, memoryBytes: 999 };
    const [card] = poolNodeCards(local, [], { ...options, localContainers: containers });

    expect(card?.containers).toEqual(containers);
  });

  it('labels the two in-flight counters as the different quantities they are', () => {
    // `localNode.inFlightRequests` is work OUR engines are serving. `peer.inFlightRequests` is
    // work WE FORWARDED there — a local counter about a remote node, permanently 0 on a Hub
    // that only receives work.
    const cards = poolNodeCards(local, [{ id: 'p', inFlightRequests: 0 }], options);

    expect(cards[0]).toMatchObject({ inFlight: 2, inFlightMeaning: 'local-engines' });
    expect(cards[1]).toMatchObject({ inFlight: 0, inFlightMeaning: 'forwarded-by-us' });
  });

  it('keeps a peer container rollup of null as not-reported rather than as zeros', () => {
    // The backend always sets the key and writes `null` for a stale, rejected or withheld
    // rollup, so `?? {running: 0}` here would draw five numbers the peer never sent.
    const [, card] = poolNodeCards(local, [{ id: 'p', containers: null }], options);

    expect(card?.containers).toBeNull();
  });

  it('treats an absent rollup the same as an explicit null', () => {
    const [, card] = poolNodeCards(local, [{ id: 'p' }], options);

    expect(card?.containers).toBeNull();
  });

  it('reads the clamped sibling fields, not the raw self-report the peer controls', () => {
    const peer: PoolPeerSummary = {
      id: 'p',
      gpuPressure: 1,
      containers: { running: 1, stopped: 0, total: 1, cpuPercent: 5, memoryBytes: 10 },
      lastCapabilities: { gpuPressure: 3, containers: { running: 900, stopped: 0, total: 900, cpuPercent: 9_000, memoryBytes: 1 } },
    };
    const [, card] = poolNodeCards(local, [peer], options);

    expect(card?.pressureBand).toBe(1);
    expect(card?.containers).toMatchObject({ running: 1, total: 1 });
  });

  it('distinguishes a measured idle band from an unmeasured one', () => {
    // Band 0 is a real measurement. `null` is a node that could not measure — most of the
    // fleet, since the signal is AMD-only and the sampler is disarmed on an unpaired Hub.
    const cards = poolNodeCards(local, [{ id: 'p' }], options);

    expect(cards[0]?.pressureBand).toBe(0);
    expect(cards[1]?.pressureBand).toBeNull();
  });

  it('reports an unread in-flight counter as null rather than zero', () => {
    const [, card] = poolNodeCards(local, [{ id: 'p' }], options);

    expect(card?.inFlight).toBeNull();
  });

  it('lets an operator disable outrank the lifecycle status', () => {
    const [, card] = poolNodeCards(local, [{ id: 'p', status: 'connected', enabled: false }], options);

    expect(card?.status).toBe('disabled');
  });

  it('does not count a disconnected peer cached model list as live capacity', () => {
    const stale: PoolPeerSummary = {
      id: 'p',
      status: 'unreachable',
      lastCapabilities: { backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['x', 'y'] }] },
    };
    const [, card] = poolNodeCards(local, [stale], options);

    // NULL, not 0: we could not ask. A 0 would assert the node holds nothing while the engine
    // chips on the same card still show its cached `ollama 2`.
    expect(card?.models).toBeNull();
  });

  it('excludes an unhealthy backend from the model count, which still lists what it cannot serve', () => {
    const node: PoolNodeSummary = { backends: [{ type: 'vllm', healthy: false, modelsLoaded: ['down:7b'] }] };
    const [card] = poolNodeCards(node, [], options);

    expect(card?.models).toBe(0);
    expect(card?.backends).toEqual([{ type: 'vllm', healthy: false, models: 1 }]);
  });

  it('keeps unknown backend health apart from unhealthy', () => {
    const node: PoolNodeSummary = { backends: [{ type: 'ollama', modelsLoaded: ['a'] }] };
    const [card] = poolNodeCards(node, [], options);

    expect(card?.backends[0]?.healthy).toBeNull();
    // Unknown is not unhealthy, so the model still counts as servable.
    expect(card?.models).toBe(1);
  });

  it('renders no local card at all when pool status has not reported one', () => {
    expect(poolNodeCards(undefined, [{ id: 'p' }], options).map((card) => card.key)).toEqual(['p']);
  });

  it('samples every card on screen, gapping the ones with no counter', () => {
    const cards = poolNodeCards(local, [{ id: 'p' }], options);

    expect(sampleInFlight(cards)).toEqual({ local: 2, p: null });
  });
});

describe('routingBuckets', () => {
  const now = Date.parse('2026-01-01T00:10:30Z');
  const entry = (iso: string, outcome = 'served') => ({ at: iso, direction: 'outbound', outcome }) as never;

  it('bins decisions by their own recorded instant', () => {
    const buckets = routingBuckets([entry('2026-01-01T00:10:05Z'), entry('2026-01-01T00:10:40Z'), entry('2026-01-01T00:09:10Z', 'failed')], {
      now,
      bucketMs: 60_000,
      buckets: 3,
    });

    expect(buckets.map((bucket) => [bucket.served, bucket.failed])).toEqual([
      [0, 0],
      [0, 1],
      [2, 0],
    ]);
  });

  it('emits an interval with nothing in it as a measured zero, not as a missing bar', () => {
    const buckets = routingBuckets([], { now, bucketMs: 60_000, buckets: 4 });

    expect(buckets).toHaveLength(4);
    expect(buckets.every((bucket) => bucket.served === 0 && bucket.failed === 0)).toBe(true);
  });

  it('drops a record older than the window rather than piling it into the first bar', () => {
    const buckets = routingBuckets([entry('2025-12-31T23:00:00Z')], { now, bucketMs: 60_000, buckets: 3 });

    expect(buckets.reduce((sum, bucket) => sum + bucket.served + bucket.failed, 0)).toBe(0);
  });

  it('ignores a record whose timestamp cannot be parsed', () => {
    const buckets = routingBuckets([entry('not-a-date')], { now, bucketMs: 60_000, buckets: 2 });

    expect(buckets.reduce((sum, bucket) => sum + bucket.served + bucket.failed, 0)).toBe(0);
  });

  it('returns nothing at all for a degenerate window rather than dividing by zero', () => {
    expect(routingBuckets([entry('2026-01-01T00:10:05Z')], { now, bucketMs: 0, buckets: 3 })).toEqual([]);
  });

  /*
   * beta-max, 2026-09-26: `qwen3.8:27b`, 39,668 prompt tokens, first byte at 370,941 ms. For those six
   * minutes the row was `pending`, and the bars drew it red and "Failed 30m" counted it.
   */
  it('counts a request still waiting for its first byte as waiting, never as failed', () => {
    const [bucket] = routingBuckets([entry('2026-01-01T00:10:05Z', 'pending')], { now, bucketMs: 60_000, buckets: 1 });

    expect(bucket).toMatchObject({ pending: 1, failed: 0, served: 0 });
  });

  /*
   * Failed rows split by what each points at. Shapes from the 2026-09-26 fleet logs: core-2's nine
   * refusals (307 s of a 780 s budget), beta-max's caller hanging up after 10.8 s, core-1's peer
   * answering 500 — and a turn whose one node ran out its 329 s budget, as core-7 did for core-2 at
   * 23:55:50 before core-14 took that one over.
   */
  it('counts the failures that took a whole first-byte budget, and only those', () => {
    const failed = (over: Record<string, unknown>) =>
      ({ at: '2026-01-01T00:10:05Z', direction: 'outbound', outcome: 'failed', status: null, clientClosed: false, ...over }) as never;
    const [bucket] = routingBuckets(
      [
        failed({ node: 'core-7', durationMs: 329_012, budgetMs: 329_000 }),
        failed({ node: null, candidates: 9, durationMs: 307_336, budgetMs: 780_000 }),
        failed({ node: 'core-1', durationMs: 10_843, budgetMs: 784_000, clientClosed: true }),
        failed({ node: 'core-2', status: 500, durationMs: 800_000, budgetMs: 780_000 }),
        failed({ node: 'core-7', durationMs: 329_012, budgetMs: null }),
      ],
      { now, bucketMs: 60_000, buckets: 1 },
    );

    expect(bucket).toMatchObject({ failed: 5, overBudget: 1, clientClosed: 1 });
  });

  it('counts unplaced requests only inside the window, so one old row cannot hold the page red', () => {
    const unplaced = (iso: string) => ({ at: iso, direction: 'outbound', node: null, candidates: 0, outcome: 'failed' }) as never;
    const buckets = routingBuckets([unplaced('2026-01-01T00:10:05Z'), unplaced('2025-12-31T18:00:00Z')], { now, bucketMs: 60_000, buckets: 30 });

    expect(buckets.reduce((sum, bucket) => sum + bucket.unplaced, 0)).toBe(1);
  });

  it('does not count a request every candidate failed as unplaced — it is a failure', () => {
    const exhausted = {
      at: '2026-01-01T00:10:05Z',
      direction: 'outbound',
      node: null,
      candidates: 9,
      attempt: 9,
      outcome: 'failed',
      failedOverFrom: ['a'],
    };
    const [bucket] = routingBuckets([exhausted as never], { now, bucketMs: 60_000, buckets: 1 });

    expect(bucket).toMatchObject({ unplaced: 0, failed: 1, failovers: 1 });
  });

  it('carries failovers, callers who left, and prompt and output tokens per minute', () => {
    const rows = [
      {
        at: '2026-01-01T00:10:05Z',
        direction: 'outbound',
        node: 'core-14',
        outcome: 'served',
        failedOverFrom: ['core-7'],
        usage: { promptTokens: 15_932, completionTokens: 41, totalTokens: 15_973 },
      },
      { at: '2026-01-01T00:10:10Z', direction: 'outbound', node: 'core-1', outcome: 'failed', clientClosed: true, failedOverFrom: [] },
      { at: '2026-01-01T00:10:12Z', direction: 'outbound', node: 'local', outcome: 'served', failedOverFrom: [], usage: null },
    ];
    const [bucket] = routingBuckets(rows as never[], { now, bucketMs: 60_000, buckets: 1 });

    expect(bucket).toMatchObject({ served: 2, failed: 1, failovers: 1, clientClosed: 1, promptTokens: 15_932, completionTokens: 41 });
  });
});

describe('routingWindowPartial', () => {
  const now = Date.parse('2026-09-27T18:00:00Z');
  const windowMs = 30 * 60_000;
  const rows = (...isos: string[]): RoutingLogEntry[] => isos.map((at) => ({ at, direction: 'outbound' }));

  it('is a floor when the ring has evicted and the oldest row held is inside the window', () => {
    const log = { entries: rows('2026-09-27T17:59:00Z', '2026-09-27T17:50:00Z'), summary: { recorded: 200, totalRecorded: 450 }, matched: 200 };

    expect(routingWindowPartial(log, { now, windowMs })).toBe(true);
  });

  it('is a floor when a raised ring holds more than the page returned', () => {
    // `HUB_POOL_ROUTING_LOG_SIZE=10000`: nothing evicted, but the unpaged request gets the newest 200.
    const log = { entries: rows('2026-09-27T17:59:00Z', '2026-09-27T17:55:00Z'), summary: { recorded: 900, totalRecorded: 900 }, matched: 900 };

    expect(routingWindowPartial(log, { now, windowMs })).toBe(true);
  });

  it('is exact when rows were dropped but the page still reaches back past the window', () => {
    const log = { entries: rows('2026-09-27T17:59:00Z', '2026-09-27T17:10:00Z'), summary: { recorded: 200, totalRecorded: 450 }, matched: 200 };

    expect(routingWindowPartial(log, { now, windowMs })).toBe(false);
  });

  it('is exact when nothing was ever dropped, however full the page looks', () => {
    // The old check fired at 200 rows held, whether or not anything had been evicted.
    const entries = rows(...Array.from({ length: 200 }, (_, index) => new Date(now - index * 1000).toISOString()));

    expect(routingWindowPartial({ entries, summary: { recorded: 200, totalRecorded: 200 }, matched: 200 }, { now, windowMs })).toBe(false);
  });

  it('is exact for a log that never answered — there is no window to be partial about', () => {
    expect(routingWindowPartial(undefined, { now, windowMs })).toBe(false);
  });
});

describe('waitingNow', () => {
  const now = Date.parse('2026-09-26T23:55:00Z');

  it('counts what is waiting for a first byte and reports the oldest wait, its node and its budget', () => {
    const rows: RoutingLogEntry[] = [
      { at: '2026-09-26T23:49:59.317Z', direction: 'outbound', node: 'local', outcome: 'pending', budgetMs: 780_000, bodyBytes: 155_982 },
      { at: '2026-09-26T23:54:00Z', direction: 'outbound', node: 'core-2.tailnet-example.ts.net', outcome: 'pending', budgetMs: 300_000 },
      { at: '2026-09-26T23:50:00Z', direction: 'outbound', node: 'core-7.tailnet-example.ts.net', outcome: 'served' },
    ];

    expect(waitingNow(rows, now)).toEqual({
      count: 2,
      oldest: { ageMs: now - Date.parse('2026-09-26T23:49:59.317Z'), node: 'local', budgetMs: 780_000, estTokens: 38_996, failovers: 0 },
    });
  });

  /*
   * core-2, 2026-09-26: placed on core-7 at 23:50:21.867, core-7 hit its 329 s deadline at 23:55:50.870
   * ("No response headers within 329000ms" in the Hub's log), and core-14 took it. The proxy gave
   * core-14 a fresh 329 s. Timed from `at`, this row read 6m 8s "on core-14" at 23:56:30 — past the
   * budget, on a node that had held it for 39 s.
   */
  it("times a failed-over request from its last hop, not from placement — the earlier node's wait is not the new node's", () => {
    const at = Date.parse('2026-09-26T23:56:30Z');
    const rows: RoutingLogEntry[] = [
      {
        at: '2026-09-26T23:50:21.867Z',
        updatedAt: '2026-09-26T23:55:50.870Z',
        direction: 'outbound',
        node: 'core-14.tailnet-example.ts.net',
        outcome: 'pending',
        failedOverFrom: ['core-7.tailnet-example.ts.net'],
        attempt: 2,
        budgetMs: 329_000,
      },
    ];

    expect(waitingNow(rows, at).oldest).toEqual({ ageMs: 39_130, node: 'core-14', budgetMs: 329_000, estTokens: null, failovers: 1 });
  });

  it('times a first attempt from placement, whatever updatedAt says, and falls back to placement on a Hub without the field', () => {
    const placed = '2026-09-26T23:50:00Z';
    // Never failed over: a bump to `updatedAt` for any other reason must not reset the only attempt's clock.
    const firstAttempt = waitingNow(
      [{ at: placed, updatedAt: '2026-09-26T23:54:00Z', direction: 'outbound', node: 'local', outcome: 'pending' }],
      now,
    );
    // Failed over, on a Hub predating `updatedAt`: nothing better than placement to time it by.
    const noField = waitingNow([{ at: placed, direction: 'outbound', node: 'local', outcome: 'pending', failedOverFrom: ['core-7'] }], now);

    expect(firstAttempt.oldest?.ageMs).toBe(5 * 60_000);
    expect(noField.oldest?.ageMs).toBe(5 * 60_000);
  });

  it('is a real zero when nothing is waiting', () => {
    expect(waitingNow([{ at: '2026-09-26T23:50:00Z', direction: 'outbound', node: 'local', outcome: 'served' }], now)).toEqual({
      count: 0,
      oldest: null,
    });
  });
});

describe('firstByteByNode', () => {
  const now = Date.parse('2026-09-26T23:58:00Z');
  const windowMs = 30 * 60_000;
  const served = (over: Partial<RoutingLogEntry>): RoutingLogEntry => ({
    at: '2026-09-26T23:50:00Z',
    direction: 'outbound',
    node: 'core-6.tailnet-example.ts.net',
    outcome: 'served',
    stream: true,
    failedOverFrom: [],
    durationMs: 1000,
    ...over,
  });

  it('reports median and worst per node, with the prompt size behind the worst', () => {
    const stats = firstByteByNode(
      [served({ durationMs: 91_716, bodyBytes: 154_773 }), served({ durationMs: 2_000 }), served({ durationMs: 5_000 })],
      { now, windowMs },
    );

    expect(stats.get('core-6')).toEqual({ count: 3, p50Ms: 5_000, maxMs: 91_716, maxEstTokens: 38_693 });
  });

  /*
   * core-2's 399,710 ms row reached core-14 after core-7 failed. `durationMs` runs from the proxy
   * receiving the request, so it is core-7's failure plus core-14's answer — charged to core-14.
   */
  it('leaves out a failed-over row, whose duration includes the node that failed first', () => {
    const stats = firstByteByNode(
      [served({ node: 'core-14.tailnet-example.ts.net', durationMs: 399_710, failedOverFrom: ['core-7.tailnet-example.ts.net'] })],
      { now, windowMs },
    );

    expect(stats.size).toBe(0);
  });

  it('leaves out a non-streamed row, whose headers arrive only after the whole generation', () => {
    expect(firstByteByNode([served({ stream: false, durationMs: 16_450 })], { now, windowMs }).size).toBe(0);
  });

  it('leaves out failures, rows still waiting, and rows older than the window', () => {
    const stats = firstByteByNode(
      [served({ outcome: 'failed' }), served({ outcome: 'pending', durationMs: null }), served({ at: '2026-09-26T23:00:00Z' })],
      { now, windowMs },
    );

    expect(stats.size).toBe(0);
  });

  it("files this Hub's engines under 'local' from both directions — our own placements and peers' forwards", () => {
    const stats = firstByteByNode(
      [served({ node: 'local', durationMs: 361 }), served({ direction: 'inbound', node: 'beta-max.tailnet-example.ts.net', durationMs: 32_227 })],
      { now, windowMs },
    );

    expect(stats.get('local')).toMatchObject({ count: 2, maxMs: 32_227 });
    expect(stats.has('beta-max')).toBe(false);
  });
});

describe('latestDecode', () => {
  it('takes the freshest generation rate, and carries its model', () => {
    const reading = latestDecode([
      { model: 'qwen3:8b', backend: 'ollama', decode: { tokensPerSec: 40, ageMs: 3_600_000 } },
      { model: 'qwen3.6:27b', backend: 'ollama', decode: { tokensPerSec: 11.2, ageMs: 60_000 } },
      { model: 'nomic-embed-text', backend: 'ollama', decode: null },
    ]);

    expect(reading).toEqual({ tokensPerSec: 11.2, model: 'qwen3.6:27b', ageMs: 60_000 });
  });

  it('is null when nothing has been measured — which after two idle hours is every node', () => {
    expect(latestDecode([])).toBeNull();
    expect(latestDecode(undefined)).toBeNull();
  });
});

describe('routingActivity', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({ at: '2026-01-01T00:00:00Z', direction: 'outbound', node: 'core-2.tail.ts.net', outcome: 'served', failedOverFrom: [], ...over }) as never;

  it('counts an outbound attempt nobody took as unplaced, not as the local node serving it', () => {
    const activity = routingActivity([row({ node: null, outcome: 'failed' })]);

    expect(activity).toMatchObject({ unplaced: 1, outbound: 1, failed: 1 });
  });

  it('counts a request with no candidate at all as unplaced', () => {
    expect(routingActivity([row({ node: null, candidates: 0, outcome: 'failed' })])).toMatchObject({ unplaced: 1, failed: 1 });
  });

  /*
   * core-2, 2026-09-26T23:51:12Z: `candidates: 9, attempt: 9`, nine nodes in `failedOverFrom`, and
   * `node: null` because none answered. It read as "1 request no node took" on the verdict.
   */
  it('does not count a request every candidate failed as unplaced — nine nodes took it', () => {
    const activity = routingActivity([
      row({ node: null, candidates: 9, attempt: 9, outcome: 'failed', failedOverFrom: Array.from({ length: 9 }, (_, i) => `n${i}`) }),
    ]);

    expect(activity).toMatchObject({ unplaced: 0, failed: 1, failovers: 1 });
  });

  /**
   * The cross-package half of the beta-max fix (see `noteClientClosed` in `hub-pool-proxy.service.ts`).
   * `unplaced` is defined here purely as "outbound with no node", and `triage.ts` raises it as a
   * `bad` fault meaning "nothing was even tried at a node". So the backend settling a hang-up with a
   * null node did not merely print a `-` in the CLI — it put a red routing/capacity fault on the
   * dashboard for a request a node had been prefilling for 30 s. This pins the contract from this
   * side: a row that names the node it was waiting on is placed, whatever ended it.
   */
  it('does not count a request the caller abandoned as unplaced — a node was working on it', () => {
    const activity = routingActivity([row({ node: 'local', outcome: 'failed', clientClosed: true })]);

    expect(activity).toMatchObject({ unplaced: 0, outbound: 1, failed: 1 });
  });

  it('does not count an inbound row as unplaced — its node is the sender, not a server', () => {
    const activity = routingActivity([row({ direction: 'inbound', node: null })]);

    expect(activity).toMatchObject({ inbound: 1, outbound: 0, unplaced: 0 });
  });

  it('counts a failover once per request, not once per node tried', () => {
    const activity = routingActivity([row({ failedOverFrom: ['a', 'b', 'c'] })]);

    expect(activity.failovers).toBe(1);
  });

  it('treats any outcome that is not served as failed, so an unknown one is never silently ok', () => {
    expect(routingActivity([row({ outcome: 'refused' })])).toMatchObject({ served: 0, failed: 1 });
  });

  it('counts a placed request still waiting for its first byte as in flight, not failed or unplaced', () => {
    const activity = routingActivity([row({ outcome: 'pending', node: 'local' })]);

    expect(activity).toMatchObject({ pending: 1, failed: 0, served: 0, unplaced: 0, outbound: 1 });
  });

  it('is all zeros for an empty log, which is a real state after a restart', () => {
    expect(routingActivity([])).toEqual({
      total: 0,
      served: 0,
      failed: 0,
      pending: 0,
      failovers: 0,
      inbound: 0,
      outbound: 0,
      unplaced: 0,
      tokensServed: 0,
    });
  });

  it('sums usage.totalTokens across held entries, and ignores entries with none', () => {
    const activity = routingActivity([
      row({ usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } }),
      row({ usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } }),
      row(), // no usage at all — the common case today, must not read as 0 tokens contributing anything odd
      row({ outcome: 'pending', usage: null }),
    ]);

    expect(activity.tokensServed).toBe(180);
  });
});
