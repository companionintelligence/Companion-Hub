/**
 * Statistics over finished rows. The property under test throughout is the same one `bench-ab.ts`
 * enforces for ratios: A FAILED REQUEST IS NOT A SLOW REQUEST. A timeout that reached its 60-second
 * deadline must not enter a latency distribution, a node comparison or a throughput table — it did
 * not measure the machine, it measured the deadline.
 *
 * The other half is grouping. Every comparison here refuses to be computed over a grouping that
 * cannot support the claim: one node is not a node-vs-node result, one backend is not a
 * backend-vs-backend result, and MLX numbers are only comparable when one machine ran both halves.
 */

import { describe, expect, it } from 'vitest';
import type { ConcurrencySample } from '../bench-series';
import {
  type EvalRow,
  backendVsBackend,
  errorTaxonomy,
  evalRowsFromItems,
  isOk,
  mlxSplit,
  nodeVsNode,
  perPromptSuccess,
  percentile,
  saturation,
  summarize,
  throughputSpread,
  ttftDistribution,
} from '../bench-stats';

let rowSeq = 0;

function row(over: Partial<EvalRow> = {}): EvalRow {
  return {
    id: over.id ?? `row-${rowSeq++}`,
    status: 'pass',
    node: 'node-a',
    backend: 'ollama',
    path: 'direct',
    promptId: 'short-chat',
    promptLabel: 'Short chat',
    model: 'model-x',
    mlx: false,
    stream: false,
    httpStatus: 200,
    failKind: null,
    truncated: false,
    durationMs: 100,
    ttftMs: null,
    tokensPerSec: 50,
    completionTokens: 10,
    textChars: 40,
    endTs: null,
    ...over,
  };
}

describe('a failed request never becomes a slow one', () => {
  it('is excluded from the throughput table entirely', () => {
    const rows = [
      row({ status: 'pass', tokensPerSec: 50 }),
      row({ status: 'pass', tokensPerSec: 60 }),
      // A timed-out request that nevertheless carried a number through: it must not land here.
      row({ status: 'fail', failKind: 'request-timeout', tokensPerSec: 0.1, durationMs: 60_000 }),
    ];
    const [spread] = throughputSpread(rows);
    expect(spread.n).toBe(2);
    expect(spread.min).toBe(50);
    expect(spread.max).toBe(60);
  });

  it('is excluded from the node comparison, so a deadline cannot become a node characterisation', () => {
    const rows = [
      row({ node: 'node-a', durationMs: 100 }),
      row({ node: 'node-a', durationMs: 110 }),
      row({ node: 'node-a', status: 'error', failKind: 'transport', durationMs: 60_000 }),
      row({ node: 'node-b', durationMs: 200 }),
      row({ node: 'node-b', durationMs: 210 }),
    ];
    const [comparison] = nodeVsNode(rows);
    expect(comparison.nodes.find((n) => n.node === 'node-a')?.n).toBe(2);
    expect(comparison.nodes.find((n) => n.node === 'node-a')?.p50).toBe(100);
    expect(comparison.fastest).toBe('node-a');
    expect(comparison.spread).toBe(2);
  });

  it('counts a successful row that reported no token usage rather than dropping it', () => {
    // A backend that never reports usage would otherwise vanish from the throughput table and read
    // as "no traffic" instead of "no token counts".
    const [spread] = throughputSpread([row({ tokensPerSec: 50 }), row({ tokensPerSec: null }), row({ tokensPerSec: 0 })]);
    expect(spread.n).toBe(1);
    expect(spread.noUsage).toBe(2);
  });

  it('treats pass and warn as usable answers and everything else as not', () => {
    expect(isOk({ status: 'pass' })).toBe(true);
    expect(isOk({ status: 'warn' })).toBe(true);
    for (const status of ['fail', 'error', 'skip', 'running']) expect(isOk({ status })).toBe(false);
  });
});

describe('groupings that cannot support a claim are dropped, not reported', () => {
  it('a model served by one node is not a node comparison', () => {
    const rows = [row({ node: 'node-a', model: 'solo' }), row({ node: 'node-a', model: 'solo' }), row({ node: 'node-b', model: 'shared' })];
    expect(nodeVsNode(rows)).toEqual([]);
  });

  it('a node/model pair served by one backend is not a backend comparison', () => {
    expect(backendVsBackend([row({ backend: 'ollama' }), row({ backend: 'ollama' })])).toEqual([]);
  });

  it('ranks backends by decode rate rather than by latency', () => {
    // A backend can post a lower p50 on a short reply while decoding slower overall, and the
    // question this comparison answers is which runner decodes faster.
    const rows = [
      row({ backend: 'ollama', durationMs: 50, tokensPerSec: 20 }),
      row({ backend: 'ollama', durationMs: 50, tokensPerSec: 20 }),
      row({ backend: 'vllm', durationMs: 500, tokensPerSec: 80 }),
      row({ backend: 'vllm', durationMs: 500, tokensPerSec: 80 }),
    ];
    const [cell] = backendVsBackend(rows);
    expect(cell.fastest).toBe('vllm');
    expect(cell.slowest).toBe('ollama');
    expect(cell.spread).toBe(4);
  });

  it('keeps node/model cells apart even when the labels could run together', () => {
    // The cell key is never parsed back apart, so a model id that happens to contain the separator
    // cannot merge two different cells into one comparison.
    const rows = [
      row({ node: 'n', model: 'a/b', backend: 'ollama' }),
      row({ node: 'n', model: 'a/b', backend: 'vllm' }),
      row({ node: 'n/a', model: 'b', backend: 'ollama' }),
      row({ node: 'n/a', model: 'b', backend: 'vllm' }),
    ];
    expect(backendVsBackend(rows)).toHaveLength(2);
  });

  it('refuses an MLX conclusion unless one node ran both halves', () => {
    const crossHardware = mlxSplit([row({ node: 'node-a', mlx: true }), row({ node: 'node-b', mlx: false })]);
    expect(crossHardware.comparable).toBe(false);
    expect(crossHardware.perNode.every((e) => e.sameNode === false)).toBe(true);

    const sameNode = mlxSplit([row({ node: 'node-a', mlx: true }), row({ node: 'node-a', mlx: false })]);
    expect(sameNode.comparable).toBe(true);
  });
});

describe('error taxonomy', () => {
  const rows = [
    row({ status: 'pass' }),
    row({ status: 'warn' }),
    row({ status: 'fail', failKind: 'request-timeout', httpStatus: null }),
    row({ status: 'error', failKind: 'transport', httpStatus: null }),
    row({ status: 'fail', failKind: 'assertion', httpStatus: 200, textChars: 0 }),
    row({ status: 'fail', failKind: 'assertion', httpStatus: 200, textChars: 0, truncated: true }),
    row({ status: 'fail', failKind: null, httpStatus: 500 }),
    row({ status: 'skip' }),
  ];

  it('separates a target that serves nothing from a reasoning model that spent its budget', () => {
    // Counting a truncated zero-character generation as an empty-serving node would make the alarm
    // fire on every reasoning model until it meant nothing at all.
    const taxonomy = errorTaxonomy(rows);
    expect(taxonomy.empty200).toBe(1);
    expect(taxonomy.budgetTruncated).toBe(1);
    expect(taxonomy.emptyNodes).toEqual([{ node: 'node-a', n: 1 }]);
  });

  it('excludes skipped rows from the denominator and keeps the shares honest', () => {
    const taxonomy = errorTaxonomy(rows);
    expect(taxonomy.total).toBe(7);
    expect(taxonomy.bad).toBe(5);
    const shares = taxonomy.kinds.reduce((sum, k) => sum + k.share, 0);
    expect(shares).toBeCloseTo(1, 10);
    expect(taxonomy.kinds.find((k) => k.kind === 'other')?.n).toBe(1);
  });

  it('reports every known kind even at zero, so a missing row is visibly zero', () => {
    const taxonomy = errorTaxonomy([row({ status: 'pass' })]);
    expect(taxonomy.kinds.map((k) => k.kind)).toEqual(['http-status', 'assertion', 'request-timeout', 'transport', 'watchdog']);
    expect(taxonomy.kinds.every((k) => k.n === 0 && k.share === 0)).toBe(true);
  });
});

describe('distributions', () => {
  it('summarize drops nulls and non-finite values instead of counting them as zero', () => {
    const summary = summarize([10, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 20, 30]);
    expect(summary.n).toBe(3);
    expect(summary.min).toBe(10);
    expect(summary.max).toBe(30);
    expect(summary.mean).toBe(20);
    expect(summarize([]).p50).toBeNull();
    expect(summarize(null).n).toBe(0);
  });

  it('percentile is nearest-rank over an ascending array', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.9)).toBe(9);
    expect(percentile(sorted, 1)).toBe(10);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('TTFT is read from streamed rows only', () => {
    // A buffered read makes TTFT equal the total duration, so a non-streamed row's TTFT would be a
    // duration wearing a queue-wait label.
    const rows = [
      row({ stream: true, ttftMs: 100 }),
      row({ stream: true, ttftMs: 200 }),
      row({ stream: false, ttftMs: 5_000 }),
      row({ stream: true, ttftMs: 0 }),
    ];
    const [dist] = ttftDistribution(rows);
    expect(dist.n).toBe(2);
    expect(dist.max).toBe(200);
  });

  it('per-prompt success ranks the hardest prompt first and names the nodes that failed it', () => {
    const rows = [
      row({ promptId: 'easy', node: 'node-a', status: 'pass' }),
      row({ promptId: 'easy', node: 'node-b', status: 'pass' }),
      row({ promptId: 'hard', node: 'node-a', status: 'fail' }),
      row({ promptId: 'hard', node: 'node-b', status: 'pass' }),
      row({ promptId: 'hard', node: 'node-b', status: 'skip' }),
    ];
    const results = perPromptSuccess(rows);
    expect(results.map((r) => r.promptId)).toEqual(['hard', 'easy']);
    expect(results[0].rate).toBe(0.5);
    expect(results[0].n).toBe(2);
    expect(results[0].failingNodes).toEqual(['node-a']);
  });
});

describe('flattening a run into rows', () => {
  it('takes only finished llm items that carry a result', () => {
    const rows = evalRowsFromItems({
      a: { kind: 'llm', status: 'pass', node: 'node-a', endTs: 5, result: { backend: 'ollama', promptId: 'short-chat', durationMs: 12 } },
      b: { kind: 'app', status: 'pass', result: { backend: 'ollama' } },
      c: { kind: 'llm', status: 'running' },
      d: null,
    });
    expect(rows.map((r) => r.id)).toEqual(['a']);
    expect(rows[0]).toMatchObject({ node: 'node-a', backend: 'ollama', path: 'direct', durationMs: 12, endTs: 5 });
    // Absent numbers stay null rather than becoming zero — a zero is a measurement.
    expect(rows[0].ttftMs).toBeNull();
    expect(rows[0].tokensPerSec).toBeNull();
  });
});

describe('saturation', () => {
  /** Four concurrency levels, two seconds each, with an idle window in front. */
  const samples: ConcurrencySample[] = [0, 1, 1, 2, 2, 3, 3, 4, 4].map((inFlight, i) => ({
    ts: i * 1000,
    inFlight,
    queued: 0,
    perTarget: {},
  }));
  samples.push({ ts: 9000, inFlight: 0, queued: 0, perTarget: {} });

  // Completions per window. Level 3 dips and level 4 recovers to the peak.
  const ends = [
    500,
    500,
    500, // idle window — must not be attributed to any level
    1500,
    1600,
    2500,
    2600, // level 1: 4 over 2s = 2.0/s
    3100,
    3200,
    3300,
    3400,
    4100,
    4200,
    4300,
    4400, // level 2: 8 over 2s = 4.0/s
    5100,
    5200,
    5300,
    6100,
    6200,
    6300, // level 3: 6 over 2s = 3.0/s
    7100,
    7200,
    7300,
    7400,
    7500,
    8100,
    8200,
    8300,
    8400, // level 4: 9 over 2s = 4.5/s
  ];
  const rows = [...ends.map((endTs) => row({ endTs })), row({ endTs: 1500, status: 'skip' })];

  it('excludes idle windows and skipped rows from the curve', () => {
    // A level-0 window can only ever report zero throughput, and a long idle stretch would anchor
    // the whole curve at the bottom.
    const result = saturation(samples, rows);
    expect(result.levels.map((l) => l.level)).toEqual([1, 2, 3, 4]);
    expect(result.levels.find((l) => l.level === 1)?.completed).toBe(4);
    expect(result.levels.find((l) => l.level === 1)?.rps).toBe(2);
    expect(result.levels.find((l) => l.level === 4)?.rps).toBe(4.5);
  });

  it('puts the knee at the LOWEST level already delivering near-peak throughput', () => {
    // Not "the first level that failed to beat the one below it": level 3 dips here and level 4
    // recovers, and the first-dip reading would report a knee far below the real one.
    const result = saturation(samples, rows, 0.2);
    expect(result.peakLevel).toBe(4);
    expect(result.peakRps).toBe(4.5);
    expect(result.knee).toBe(2);
    expect(result.atCeiling).toBe(false);
  });

  it('says atCeiling when throughput never flattened below the concurrency limit of the run', () => {
    const result = saturation(samples, rows, 0.05);
    expect(result.knee).toBe(4);
    expect(result.atCeiling).toBe(true);
  });

  it('will not draw a verdict from a level observed for a moment', () => {
    const brief: ConcurrencySample[] = [
      { ts: 0, inFlight: 9, queued: 0, perTarget: {} },
      { ts: 200, inFlight: 0, queued: 0, perTarget: {} },
    ];
    const result = saturation(brief, [row({ endTs: 100 })]);
    expect(result.levels).toHaveLength(1);
    expect(result.knee).toBeNull();
    expect(result.peakRps).toBeNull();
  });

  it('reports nothing rather than guessing when there is no series', () => {
    expect(saturation(null, rows)).toEqual({ levels: [], knee: null, peakRps: null, peakLevel: null, atCeiling: false });
  });
});
