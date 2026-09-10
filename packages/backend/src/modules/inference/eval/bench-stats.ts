/**
 * Statistics over finished eval rows — pure functions, no I/O, no dependencies.
 *
 * Every function here is deliberately narrow about what comparison it will make, because the
 * expensive mistakes in benchmarking are not arithmetic errors. They are numbers computed over the
 * wrong grouping and then read as a statement about hardware: a model served by one node compared
 * "against the fleet", two backends compared across different weights, a mean that describes the
 * prompt mix. Where a grouping cannot support the claim, the function drops the group rather than
 * reporting it — see `nodeVsNode` and `backendVsBackend`.
 *
 * Paired A/B comparison — where a *ratio* is computed — lives in `bench-ab.ts` and has stricter
 * rules again. Nothing here produces an uplift figure.
 */

import type { ConcurrencySample } from './bench-series';

/** Terminal statuses that mean the request produced a usable answer. */
export const OK_STATUSES = ['pass', 'warn'] as const;

export interface EvalRow {
  id: string;
  status: string;
  node: string | null;
  backend: string | null;
  /** How the request was routed — `direct`, or through a pool/proxy. */
  path: string;
  promptId: string | null;
  promptLabel: string | null;
  model: string | null;
  /** Whether this row used an MLX build of the model. See `mlxSplit` for what that may be read as. */
  mlx: boolean;
  stream: boolean;
  httpStatus: number | null;
  failKind: string | null;
  /** The generation stopped on the token budget rather than on the model finishing. */
  truncated: boolean;
  durationMs: number | null;
  ttftMs: number | null;
  tokensPerSec: number | null;
  completionTokens: number | null;
  textChars: number | null;
  /** Epoch ms the row settled. Used by `saturation` to attribute completions to a window. */
  endTs: number | null;
}

export interface Summary {
  n: number;
  min: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
}

export interface KeyedSummary extends Summary {
  key: string;
}

/** p-th percentile of an ASCENDING-sorted array (nearest-rank). */
export function percentile(sorted: readonly number[] | null | undefined, p: number): number | null {
  if (!sorted || sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[i] ?? null;
}

/** n / min / p50 / p90 / p95 / max / mean over a set of numbers. Nulls and non-finite values dropped. */
export function summarize(values: readonly (number | null | undefined)[] | null | undefined): Summary {
  const clean = (values ?? []).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (clean.length === 0) return { n: 0, min: null, p50: null, p90: null, p95: null, max: null, mean: null };
  const sorted = [...clean].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? null,
    mean: Math.round((sum / sorted.length) * 10) / 10,
  };
}

export function isOk(row: Pick<EvalRow, 'status'>): boolean {
  return (OK_STATUSES as readonly string[]).includes(row.status);
}

/** The shape a run keeps per dispatched item, before it is flattened into a stat row. */
export interface EvalItem {
  kind: string;
  status: string;
  node?: string | null;
  endTs?: number | null;
  result?: Partial<Omit<EvalRow, 'id' | 'status' | 'endTs'>> & { ts?: number | null };
}

/** Flatten a run's item map into stat rows. Only finished `llm` items contribute. */
export function evalRowsFromItems(items: Record<string, EvalItem | null | undefined> | null | undefined): EvalRow[] {
  const rows: EvalRow[] = [];
  for (const [id, item] of Object.entries(items ?? {})) {
    if (!item || item.kind !== 'llm' || !item.result) continue;
    const r = item.result;
    rows.push({
      id,
      status: item.status,
      node: r.node || item.node || null,
      backend: r.backend || null,
      path: r.path || 'direct',
      promptId: r.promptId || null,
      promptLabel: r.promptLabel || r.promptId || null,
      model: r.model || null,
      mlx: r.mlx === true,
      stream: r.stream === true,
      httpStatus: typeof r.httpStatus === 'number' ? r.httpStatus : null,
      failKind: r.failKind || null,
      truncated: r.truncated === true,
      durationMs: typeof r.durationMs === 'number' ? r.durationMs : null,
      ttftMs: typeof r.ttftMs === 'number' ? r.ttftMs : null,
      tokensPerSec: typeof r.tokensPerSec === 'number' ? r.tokensPerSec : null,
      completionTokens: typeof r.completionTokens === 'number' ? r.completionTokens : null,
      textChars: typeof r.textChars === 'number' ? r.textChars : null,
      endTs: item.endTs || r.ts || null,
    });
  }
  return rows;
}

export interface ErrorKind {
  kind: string;
  label: string;
  detail: string;
  n: number;
  /** This kind's share of the failing rows. 0 when nothing failed. */
  share: number;
}

export interface ErrorTaxonomy {
  total: number;
  bad: number;
  kinds: ErrorKind[];
  /** 2xx responses that carried zero characters of text. A SUBSET of `assertion`. */
  empty200: number;
  /** 2xx, zero visible characters, but the generation hit its token budget. Not an empty-serving node. */
  budgetTruncated: number;
  emptyNodes: { node: string; n: number }[];
}

/**
 * Error taxonomy — the reason this exists is a node that answered HTTP 200 to every dialect with an
 * EMPTY completion: zero characters, no `choices.0.message.content`.
 *
 * Lumping that under "errors" next to a refused connection makes a target that serves nothing look
 * like a target that is merely unreachable, and the two demand opposite responses. So the kinds are
 * kept apart by WHERE the failure happened, not by how bad it looked:
 *
 *   http-status      the backend answered with a status the prompt does not accept — transport fine
 *   assertion        2xx, but the body failed the prompt's shape check — the server IS answering, wrongly
 *   request-timeout  no response inside the prompt's own timeout (client abort)
 *   transport        the request never completed a round trip (DNS/connect/reset)
 *   watchdog         a server-side deadline sweep force-failed a request that never settled
 *
 * `empty200` counts that healthy-looking-but-serving-nothing signature separately, because it is the
 * single most misleading state a target can be in.
 *
 * `truncated` rows are EXCLUDED from that count. A reasoning model can spend its whole token budget
 * on hidden reasoning and return zero visible characters with finish_reason "length" (observed on a
 * 2B reasoning build at max_tokens 8). That is a budget problem, not a target serving nothing, and
 * counting it here would make the alarm fire on every reasoning model until it meant nothing at all.
 * Those rows are counted as `budgetTruncated` instead.
 */
export function errorTaxonomy(rows: readonly EvalRow[]): ErrorTaxonomy {
  const KINDS = [
    { kind: 'http-status', label: 'HTTP status', detail: 'backend answered with an unaccepted status — transport fine' },
    { kind: 'assertion', label: 'Assertion', detail: 'answered 2xx but the body failed the prompt shape check' },
    { kind: 'request-timeout', label: 'Timeout', detail: 'no response inside the prompt timeout — client aborted' },
    { kind: 'transport', label: 'Transport', detail: 'never completed a round trip (connect / reset / DNS)' },
    { kind: 'watchdog', label: 'Watchdog', detail: 'deadline sweep force-failed a request that never settled' },
  ] as const;

  const counts = new Map<string, number>(KINDS.map((k) => [k.kind, 0]));
  const emptyNodes = new Map<string, number>();
  let other = 0;
  let bad = 0;
  let empty200 = 0;
  let budgetTruncated = 0;

  for (const row of rows) {
    if (row.status === 'skip') continue;
    if (row.httpStatus != null && row.httpStatus >= 200 && row.httpStatus < 300 && row.textChars === 0 && !isOk(row)) {
      if (row.truncated) {
        budgetTruncated++;
      } else {
        empty200++;
        if (row.node) emptyNodes.set(row.node, (emptyNodes.get(row.node) ?? 0) + 1);
      }
    }
    if (isOk(row)) continue;
    bad++;
    if (row.failKind && counts.has(row.failKind)) counts.set(row.failKind, (counts.get(row.failKind) ?? 0) + 1);
    else other++;
  }

  const kinds: ErrorKind[] = KINDS.map((k) => {
    const n = counts.get(k.kind) ?? 0;
    return { kind: k.kind, label: k.label, detail: k.detail, n, share: bad > 0 ? n / bad : 0 };
  });
  if (other > 0) kinds.push({ kind: 'other', label: 'Unclassified', detail: 'no failKind recorded', n: other, share: bad > 0 ? other / bad : 0 });

  return {
    total: rows.filter((r) => r.status !== 'skip').length,
    bad,
    kinds,
    empty200,
    budgetTruncated,
    emptyNodes: [...emptyNodes].map(([node, n]) => ({ node, n })),
  };
}

type KeyFn = (row: EvalRow) => string | null | undefined;

const byNode: KeyFn = (r) => r.node;

/**
 * TTFT distribution across the STREAMING rows only, grouped by `keyFn`.
 *
 * Total duration answers "how long until I had the whole answer"; TTFT answers "how long did this
 * request sit in the queue before the model started talking". The p50/p95 of duration cannot
 * separate those two, which is exactly the distinction a saturation hunt needs.
 */
export function ttftDistribution(rows: readonly EvalRow[], keyFn: KeyFn = byNode): KeyedSummary[] {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.stream || row.ttftMs == null || row.ttftMs <= 0) continue;
    const k = keyFn(row);
    if (k == null) continue;
    const list = groups.get(k);
    if (list) list.push(row.ttftMs);
    else groups.set(k, [row.ttftMs]);
  }
  return [...groups].map(([key, values]) => ({ ...summarize(values), key })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

export interface ThroughputSpread extends KeyedSummary {
  /** Rows that succeeded but reported no token counts. Counted, never silently dropped. */
  noUsage: number;
}

/** tokens/sec distribution (the spread, not just a mean) grouped by `keyFn`. */
export function throughputSpread(rows: readonly EvalRow[], keyFn: KeyFn = byNode): ThroughputSpread[] {
  const groups = new Map<string, number[]>();
  const missing = new Map<string, number>();
  for (const row of rows) {
    const k = keyFn(row);
    if (k == null || !isOk(row)) continue;
    if (row.tokensPerSec == null || !(row.tokensPerSec > 0)) {
      // Counted, not silently dropped: a backend that never reports usage would otherwise vanish from
      // the throughput table entirely and read as "no traffic" instead of "no token counts".
      missing.set(k, (missing.get(k) ?? 0) + 1);
      continue;
    }
    const list = groups.get(k);
    if (list) list.push(row.tokensPerSec);
    else groups.set(k, [row.tokensPerSec]);
  }
  const keys = new Set([...groups.keys(), ...missing.keys()]);
  return [...keys]
    .map((key) => ({ ...summarize(groups.get(key) ?? []), key, noUsage: missing.get(key) ?? 0 }))
    .sort((a, b) => (b.p50 ?? 0) - (a.p50 ?? 0));
}

export interface PerPromptResult {
  promptId: string;
  label: string;
  n: number;
  ok: number;
  rate: number;
  nodes: number;
  failingNodes: string[];
  p50: number | null;
  p95: number | null;
}

/** Per-prompt success rate across every target that ran it — "which prompt is hardest here". */
export function perPromptSuccess(rows: readonly EvalRow[]): PerPromptResult[] {
  interface Bucket {
    promptId: string;
    label: string;
    n: number;
    ok: number;
    durations: number[];
    nodes: Set<string>;
    badNodes: Set<string>;
  }
  const groups = new Map<string, Bucket>();
  for (const row of rows) {
    if (!row.promptId || row.status === 'skip') continue;
    let g = groups.get(row.promptId);
    if (!g) {
      g = { promptId: row.promptId, label: row.promptLabel || row.promptId, n: 0, ok: 0, durations: [], nodes: new Set(), badNodes: new Set() };
      groups.set(row.promptId, g);
    }
    g.n++;
    if (isOk(row)) g.ok++;
    else if (row.node) g.badNodes.add(row.node);
    if (row.node) g.nodes.add(row.node);
    if (row.durationMs != null && row.durationMs > 0) g.durations.push(row.durationMs);
  }
  return [...groups.values()]
    .map((g) => {
      const sorted = [...g.durations].sort((a, b) => a - b);
      return {
        promptId: g.promptId,
        label: g.label,
        n: g.n,
        ok: g.ok,
        rate: g.n > 0 ? g.ok / g.n : 0,
        nodes: g.nodes.size,
        failingNodes: [...g.badNodes].sort(),
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
      };
    })
    .sort((a, b) => a.rate - b.rate || b.n - a.n);
}

export interface NodeLatency {
  node: string;
  n: number;
  p50: number | null;
  p95: number | null;
  tps: number | null;
  mlx: boolean;
}

export interface NodeComparison {
  model: string;
  nodes: NodeLatency[];
  fastest: string | null;
  slowest: string | null;
  /** How many times slower the slowest is. 1 = identical behaviour on this model. */
  spread: number | null;
}

/**
 * Node-versus-node for the SAME model — the only comparison in which a latency difference is a
 * statement about hardware.
 *
 * Models served by a single node are excluded: a one-node "comparison" is just that node's latency
 * wearing a comparison's clothes.
 */
export function nodeVsNode(rows: readonly EvalRow[]): NodeComparison[] {
  const byModel = new Map<string, Map<string, { durations: number[]; tps: number[]; mlx: boolean }>>();
  for (const row of rows) {
    if (!row.model || !row.node || !isOk(row) || !(row.durationMs != null && row.durationMs > 0)) continue;
    let m = byModel.get(row.model);
    if (!m) {
      m = new Map();
      byModel.set(row.model, m);
    }
    let e = m.get(row.node);
    if (!e) {
      e = { durations: [], tps: [], mlx: row.mlx === true };
      m.set(row.node, e);
    }
    e.durations.push(row.durationMs);
    if (row.tokensPerSec != null && row.tokensPerSec > 0) e.tps.push(row.tokensPerSec);
  }
  return [...byModel]
    .map(([model, perNode]) => {
      const nodes: NodeLatency[] = [...perNode]
        .map(([node, e]) => {
          const sorted = [...e.durations].sort((a, b) => a - b);
          return { node, n: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), tps: summarize(e.tps).p50, mlx: e.mlx };
        })
        .sort((a, b) => (a.p50 ?? 0) - (b.p50 ?? 0));
      const fastest = nodes[0];
      const slowest = nodes[nodes.length - 1];
      const spread = fastest?.p50 != null && fastest.p50 > 0 && slowest?.p50 != null ? Math.round((slowest.p50 / fastest.p50) * 100) / 100 : null;
      return { model, nodes, fastest: fastest?.node ?? null, slowest: slowest?.node ?? null, spread };
    })
    .filter((m) => m.nodes.length > 1)
    .sort((a, b) => (b.spread ?? 0) - (a.spread ?? 0));
}

export interface BackendThroughput {
  backend: string;
  n: number;
  p50: number | null;
  p95: number | null;
  tps: number | null;
}

export interface BackendComparison {
  node: string;
  model: string;
  backends: BackendThroughput[];
  fastest: string | null;
  slowest: string | null;
  /** How many times faster the fastest backend is. 1 = identical throughput on this node/model. */
  spread: number | null;
}

/**
 * Backend-versus-backend for the SAME node AND the SAME model — the only comparison in which a
 * throughput difference is a statement about the model RUNNER, rather than the hardware underneath
 * it or which weights were loaded.
 *
 * Mirrors `nodeVsNode`'s reasoning with the fixed and varying axes swapped: a node/model pair served
 * by only one backend is excluded, for the same reason a model served by only one node is excluded
 * there — a one-backend "comparison" is that backend's own number wearing a comparison's clothes.
 */
export function backendVsBackend(rows: readonly EvalRow[]): BackendComparison[] {
  interface Cell {
    node: string;
    model: string;
    backends: Map<string, { durations: number[]; tps: number[] }>;
  }
  const cells = new Map<string, Cell>();
  for (const row of rows) {
    if (!row.backend || !row.node || !row.model || !isOk(row) || !(row.durationMs != null && row.durationMs > 0)) continue;
    // Keyed by node+model, but the key is never parsed back apart — the cell carries its own labels,
    // because a model id containing the separator would otherwise split into the wrong pieces.
    const key = `${row.node} ${row.model}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { node: row.node, model: row.model, backends: new Map() };
      cells.set(key, cell);
    }
    let e = cell.backends.get(row.backend);
    if (!e) {
      e = { durations: [], tps: [] };
      cell.backends.set(row.backend, e);
    }
    e.durations.push(row.durationMs);
    if (row.tokensPerSec != null && row.tokensPerSec > 0) e.tps.push(row.tokensPerSec);
  }
  return [...cells.values()]
    .map((cell) => {
      const backends: BackendThroughput[] = [...cell.backends]
        .map(([backend, e]) => {
          const sorted = [...e.durations].sort((a, b) => a - b);
          return { backend, n: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), tps: summarize(e.tps).p50 };
        })
        // Ranked by tok/s, not latency: this comparison exists to answer "which runner decodes
        // faster", and a backend can post a lower p50 on a short reply while decoding slower overall.
        .sort((a, b) => (b.tps ?? 0) - (a.tps ?? 0));
      const fastest = backends[0];
      const slowest = backends[backends.length - 1];
      const spread = slowest?.tps != null && slowest.tps > 0 && fastest?.tps != null ? Math.round((fastest.tps / slowest.tps) * 100) / 100 : null;
      return { node: cell.node, model: cell.model, backends, fastest: fastest?.backend ?? null, slowest: slowest?.backend ?? null, spread };
    })
    .filter((g) => g.backends.length > 1)
    .sort((a, b) => (b.spread ?? 0) - (a.spread ?? 0));
}

export interface MlxSplit {
  mlx: Summary;
  std: Summary;
  mlxTps: Summary;
  stdTps: Summary;
  perNode: { node: string; mlx: Summary; std: Summary; sameNode: boolean }[];
  /** True when at least one node ran both halves — without this, any ratio above is cross-hardware. */
  comparable: boolean;
}

/**
 * MLX-build versus ordinary-build latency.
 *
 * HONESTY NOTE, carried in the data as well as the docs: this compares MLX model *builds* against
 * ordinary GGUF builds served by the same runner. It is NOT a measurement of any particular MLX
 * server implementation. `sameNode` is true only when both halves were served by the same node — the
 * only rows from which an MLX conclusion can be drawn at all, and `comparable` is false otherwise.
 */
export function mlxSplit(rows: readonly EvalRow[]): MlxSplit {
  const mlxDurations: number[] = [];
  const stdDurations: number[] = [];
  const mlxTps: number[] = [];
  const stdTps: number[] = [];
  const nodes = new Map<string, { mlx: number[]; std: number[] }>();

  for (const row of rows) {
    if (!isOk(row) || !(row.durationMs != null && row.durationMs > 0) || !row.node) continue;
    let bucket = nodes.get(row.node);
    if (!bucket) {
      bucket = { mlx: [], std: [] };
      nodes.set(row.node, bucket);
    }
    if (row.mlx) {
      mlxDurations.push(row.durationMs);
      if (row.tokensPerSec != null && row.tokensPerSec > 0) mlxTps.push(row.tokensPerSec);
      bucket.mlx.push(row.durationMs);
    } else {
      stdDurations.push(row.durationMs);
      if (row.tokensPerSec != null && row.tokensPerSec > 0) stdTps.push(row.tokensPerSec);
      bucket.std.push(row.durationMs);
    }
  }

  const perNode = [...nodes]
    .map(([node, e]) => {
      const m = summarize(e.mlx);
      const s = summarize(e.std);
      return { node, mlx: m, std: s, sameNode: m.n > 0 && s.n > 0 };
    })
    .filter((e) => e.mlx.n > 0 || e.std.n > 0)
    .sort((a, b) => Number(b.sameNode) - Number(a.sameNode) || a.node.localeCompare(b.node));

  return {
    mlx: summarize(mlxDurations),
    std: summarize(stdDurations),
    mlxTps: summarize(mlxTps),
    stdTps: summarize(stdTps),
    perNode,
    comparable: perNode.some((e) => e.sameNode),
  };
}

export interface SaturationLevel {
  level: number;
  seconds: number;
  completed: number;
  rps: number;
  /** Step-over-step change against the level below. For a tooltip; NOT what decides the knee. */
  gain?: number | null;
}

export interface Saturation {
  levels: SaturationLevel[];
  knee: number | null;
  peakRps: number | null;
  peakLevel: number | null;
  /** No flattening seen — the ceiling is above the concurrency this run was allowed to reach. */
  atCeiling: boolean;
}

/**
 * Queue saturation: throughput as a function of how many requests were actually in flight.
 *
 * Built from data already collected — the 1 Hz concurrency samples plus each row's finish time. For
 * every gap between consecutive samples we know the concurrency that held during it and how many
 * requests completed inside it; accumulating those per concurrency level gives requests/second at
 * each level.
 *
 * The KNEE is the LOWEST concurrency that already delivers essentially peak throughput — the
 * smallest level within `minGain` of the best observed. Defining it that way rather than as "the
 * first level that failed to beat the one below it" matters: real data is noisy (a level observed
 * for a single sample can dip and recover), and the first-dip definition picked a knee of 1 on a run
 * whose peak was at 7, which is a sentence an operator would have had to disbelieve.
 *
 * `atCeiling` is true when that knee IS the highest level observed — meaning throughput never
 * flattened and the real ceiling is above whatever the run's concurrency limit allowed.
 *
 * Level 0 windows are idle time and are excluded: they can only ever report zero throughput, and a
 * long idle stretch would otherwise anchor the curve at the bottom.
 */
export function saturation(samples: readonly ConcurrencySample[] | null | undefined, rows: readonly EvalRow[], minGain = 0.05): Saturation {
  const gain = typeof minGain === 'number' && Number.isFinite(minGain) ? minGain : 0.05;
  const ends = rows
    .map((r) => (r.status !== 'skip' && r.endTs ? r.endTs : null))
    .filter((t): t is number => t != null)
    .sort((a, b) => a - b);

  const acc = new Map<number, { level: number; seconds: number; completed: number }>();
  const series = samples ?? [];
  for (let i = 0; i + 1 < series.length; i++) {
    const a = series[i];
    const b = series[i + 1];
    if (!a || !b) continue;
    const level = a.inFlight;
    if (!(level > 0)) continue;
    const dt = (b.ts - a.ts) / 1000;
    if (!(dt > 0)) continue;
    let done = 0;
    for (const end of ends) {
      if (end > a.ts && end <= b.ts) done++;
    }
    let e = acc.get(level);
    if (!e) {
      e = { level, seconds: 0, completed: 0 };
      acc.set(level, e);
    }
    e.seconds += dt;
    e.completed += done;
  }

  const levels: SaturationLevel[] = [...acc.values()]
    .map((e) => ({
      level: e.level,
      seconds: Math.round(e.seconds * 10) / 10,
      completed: e.completed,
      rps: e.seconds > 0 ? Math.round((e.completed / e.seconds) * 1000) / 1000 : 0,
    }))
    .sort((x, y) => x.level - y.level);

  // Only levels actually observed for a meaningful stretch can carry a knee verdict; a level seen
  // for 200ms says nothing about steady-state throughput.
  const solid = levels.filter((l) => l.seconds >= 1);
  let best: SaturationLevel | null = null;
  let prev: SaturationLevel | null = null;
  for (const cur of solid) {
    cur.gain = prev && prev.rps > 0 ? Math.round(((cur.rps - prev.rps) / prev.rps) * 1000) / 1000 : null;
    prev = cur;
    if (!best || cur.rps > best.rps) best = cur;
  }

  let knee: number | null = null;
  if (best && best.rps > 0) {
    for (const l of solid) {
      if (l.rps >= best.rps * (1 - gain)) {
        knee = l.level;
        break;
      }
    }
  }
  const topLevel = solid.length ? (solid[solid.length - 1]?.level ?? null) : null;
  return {
    levels,
    knee,
    peakRps: best ? best.rps : null,
    peakLevel: best ? best.level : null,
    atCeiling: knee != null && knee === topLevel,
  };
}
