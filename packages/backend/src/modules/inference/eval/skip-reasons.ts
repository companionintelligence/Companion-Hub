/**
 * WHY A CASE DID NOT RUN — the classification behind a run's blocked/skipped accounting.
 *
 * ── The rule this file exists to enforce ────────────────────────────────────────────────────────
 * A measurement that did not happen is a SKIP CARRYING ITS REASON. Never a pass, never a zero, never
 * an unexplained blank. A skipped case is by definition a case that did not measure the thing it
 * claims to measure, and that is only ever benign once someone has read WHY — so the reason, not the
 * count, is the unit this module deals in. A skip with no reason recorded is reported as a DEFECT IN
 * THE HARNESS rather than quietly filed under 'other'.
 *
 * ── The measurement that made it necessary ──────────────────────────────────────────────────────
 * One run produced 145 skips and 35 timeouts. Both numbers were on the page, as two grey chips, and
 * neither was actionable: the summary could say HOW MANY cases had not run and nothing whatever about
 * WHY, so 145 unmeasured tuples read the same as 145 harmless ones. They were not the same. Some were
 * "this target doesn't run vllm" (correct, uninteresting), some were "none of your selected models is
 * resident here" (a selection mistake), and some were "the pool is auth-gated" (a missing key). Three
 * different jobs, merged into one number that suggested no job at all.
 *
 * ── The buckets ────────────────────────────────────────────────────────────────────────────────
 * Ordered by what an operator would DO about them, not by how they read. `expected` marks the ones
 * that are a correct description of the deployment rather than something to fix — but they are still
 * shown and still counted, because "expected" is a judgement about a reason and cannot be made about a
 * number that has lost its reason.
 *
 * Pure classification, no I/O.
 */

export type SkipBucketId =
  | 'no-reason'
  | 'backend-absent'
  | 'model-pin-missed'
  | 'no-resident-model'
  | 'pool-guarded'
  | 'pool-absent'
  | 'nothing-selected'
  | 'hub-unreachable'
  | 'arch'
  | 'run-ended'
  | 'other';

export interface SkipBucket {
  id: SkipBucketId;
  label: string;
  /** True when this bucket describes the deployment correctly and nothing is broken. */
  expected: boolean;
  /** What an operator does about it. Written to be read, not parsed. */
  fix: string;
  /** Applied to the LOWER-CASED reason text. null on the two buckets nothing matches into. */
  match: RegExp | null;
}

/** The bucket a reason-less skip lands in. Its own id so a report can shout about it. */
export const SKIP_NO_REASON: SkipBucketId = 'no-reason';
/** The catch-all. More than a handful here means the patterns below need a look. */
export const SKIP_UNCLASSIFIED: SkipBucketId = 'other';

const UNCLASSIFIED_BUCKET: SkipBucket = {
  id: 'other',
  label: 'other',
  expected: false,
  fix: 'Not matched by any known pattern — read the reason text. If several land here, a bucket pattern has gone stale.',
  match: null,
};

/**
 * Buckets, in the order a report lists them.
 *
 * Matching on prose is the honest trade here: these reasons are written for an operator to read and
 * are not enumerated anywhere as codes. The failure mode of a wrong pattern is a row in the wrong
 * bucket — visible, with its full text right there — which is a far smaller lie than the number
 * without the text. `SKIP_UNCLASSIFIED` is the tell that a pattern has gone stale.
 */
export const SKIP_BUCKETS: readonly SkipBucket[] = [
  {
    id: 'no-reason',
    label: 'no reason recorded',
    expected: false,
    fix: 'A harness defect, not a deployment fact: this case was skipped and nothing recorded why. Every skip is supposed to carry a sentence.',
    match: null,
  },
  {
    id: 'backend-absent',
    label: 'backend not running here',
    expected: true,
    fix: 'Correct and uninteresting: the target does not run that engine. Deselect the backend to stop generating these rows.',
    match: /not reachable on |not found on |simply doesn't run it/,
  },
  {
    id: 'model-pin-missed',
    label: 'selected model not resident',
    expected: false,
    fix: 'A SELECTION that missed: the target has models, none of them the ones you pinned. Widen the model picks or pick a target that holds them — the harness will never pull one to satisfy a case.',
    match: /selected model|none of the .* selected/,
  },
  {
    id: 'no-resident-model',
    label: 'no resident model for the role',
    expected: false,
    fix: 'The target runs the backend but holds no model of the role the prompt needs. Load one there, or drop the prompt role from the run.',
    match: /no resident .* model|no resident model/,
  },
  {
    id: 'pool-guarded',
    label: 'pool present but auth-gated',
    expected: false,
    fix: 'Presence, not absence: the routes are mounted and answering 401. Supply the pool API key to measure them.',
    match: /auth-gated|not measurable without a key|must_be_logged_in/,
  },
  {
    id: 'pool-absent',
    label: 'pool routes not in this build',
    expected: true,
    fix: 'A 404 on identify: this Hub build predates the pool routes. Nothing to fix on the harness side.',
    match: /does not mount the pool|pool routes|404 from/,
  },
  {
    id: 'nothing-selected',
    label: 'backend present, nothing targeted it',
    expected: false,
    fix: 'The endpoint is healthy and no selected prompt names it, so it would have vanished from the run without a trace. Select a prompt that targets it, or deselect the backend.',
    match: /nothing selected|no selected prompt|of the .* selected prompt/,
  },
  {
    id: 'hub-unreachable',
    label: 'Hub API unreachable',
    expected: false,
    fix: 'Nothing answered on the Hub port. Check the target is up and the Hub is listening — and check the PORT: a Hub listening on a non-default port is indistinguishable from an absent one.',
    match: /hub api unreachable|no ci-hub api|hub build does not serve/,
  },
  {
    id: 'arch',
    label: 'architecture mismatch',
    expected: true,
    fix: "The app cannot run on that target's architecture. Expected wherever amd64 and arm64 machines are evaluated together.",
    match: /architecture|arch |arm64|amd64/,
  },
  {
    id: 'run-ended',
    label: 'run ended before it ran',
    expected: false,
    fix: 'Stopped, or the run watchdog fired, before this case was dispatched. Unmeasured — not passing and not failing.',
    // Three separate sentences a dispatcher emits for this, and the third was found by running these
    // buckets over a real 1326-row run: eight rows from one endpoint reading "run stopped before this
    // tuple was dispatched" were landing in 'other'. That is what the catch-all is FOR — it made a
    // stale pattern visible instead of hiding eight rows inside a bucket that sounded plausible.
    match: /run ended|run stopped|circuit breaker|remaining tuples skipped|no request was sent/,
  },
  UNCLASSIFIED_BUCKET,
];

export function skipBucketById(id: string): SkipBucket {
  return SKIP_BUCKETS.find((b) => b.id === id) ?? UNCLASSIFIED_BUCKET;
}

/**
 * Which bucket one skip reason belongs to.
 *
 * An empty, whitespace-only or non-string reason is `no-reason` — never 'other'. The distinction is
 * the whole point: 'other' means we could not classify what the harness said, 'no-reason' means the
 * harness said nothing, and only one of those is a bug in this code.
 */
export function classifySkipReason(reason: unknown): SkipBucket {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) return skipBucketById(SKIP_NO_REASON);
  const lower = text.toLowerCase();
  for (const b of SKIP_BUCKETS) {
    if (b.match?.test(lower)) return b;
  }
  return skipBucketById(SKIP_UNCLASSIFIED);
}

/**
 * One result row, reduced to the fields the accounting reads.
 *
 * `endpoint` is an opaque caller-supplied label — a host:port, a discovery id — the same convention
 * the rest of this directory uses. Nothing here parses it; it is only ever grouped on and printed.
 */
export interface EvalOutcomeRow {
  status: string;
  endpoint?: string | null;
  backend?: string | null;
  promptId?: string | null;
  /** The reason sentence. Its absence on a `skip` row is itself a finding. */
  notes?: string | null;
  timeoutMs?: number | null;
  durationMs?: number | null;
}

export interface SkipReasonCount {
  text: string;
  n: number;
}

export interface SkipGroup {
  id: SkipBucketId;
  label: string;
  expected: boolean;
  fix: string;
  n: number;
  endpoints: string[];
  backends: string[];
  /** Every distinct sentence, with how many rows carried it. */
  reasons: SkipReasonCount[];
}

export interface SkipSummary {
  total: number;
  buckets: SkipGroup[];
  /** Rows that were skipped with nothing recorded about why. Any number above zero is a defect. */
  unexplained: number;
  /** Rows whose reason is something to fix rather than something to accept. */
  actionable: number;
  headline: string;
}

/**
 * Group every skipped case into buckets, with the endpoints and the sample reasons attached.
 *
 * Only `skip`-status rows are bucketed; timeouts are counted separately by `summarizeTimeouts`,
 * because a timeout MEASURED something (the target took longer than the budget) and a skip measured
 * nothing — merging them is how "35 timeouts" became indistinguishable from "35 things we did not
 * try".
 */
export function summarizeSkips(rows: readonly EvalOutcomeRow[] | null | undefined): SkipSummary {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r?.status === 'skip');
  const groups = new Map<
    SkipBucketId,
    { bucket: SkipBucket; n: number; endpoints: Map<string, number>; backends: Map<string, number>; reasons: Map<string, number> }
  >();

  for (const r of list) {
    const bucket = classifySkipReason(r.notes);
    let g = groups.get(bucket.id);
    if (!g) {
      g = { bucket, n: 0, endpoints: new Map(), backends: new Map(), reasons: new Map() };
      groups.set(bucket.id, g);
    }
    g.n++;
    if (r.endpoint) g.endpoints.set(r.endpoint, (g.endpoints.get(r.endpoint) ?? 0) + 1);
    if (r.backend) g.backends.set(r.backend, (g.backends.get(r.backend) ?? 0) + 1);
    const text = typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : '(no reason recorded)';
    g.reasons.set(text, (g.reasons.get(text) ?? 0) + 1);
  }

  const out: SkipGroup[] = [];
  for (const b of SKIP_BUCKETS) {
    const g = groups.get(b.id);
    if (!g) continue;
    out.push({
      id: b.id,
      label: b.label,
      expected: b.expected,
      fix: b.fix,
      n: g.n,
      endpoints: [...g.endpoints.keys()].sort(),
      backends: [...g.backends.keys()].sort(),
      // The counts are the evidence; the sentences are what an operator actually acts on.
      reasons: [...g.reasons.entries()].map(([text, n]) => ({ text, n })).sort((a, b2) => b2.n - a.n),
    });
  }

  const total = list.length;
  const unexplained = out.filter((g) => g.id === SKIP_NO_REASON).reduce((n, g) => n + g.n, 0);
  const actionable = out.filter((g) => !g.expected).reduce((n, g) => n + g.n, 0);
  return {
    total,
    buckets: out,
    unexplained,
    actionable,
    // "145 skipped" says nothing; this says how much of it is a deployment fact and how much is a run
    // that did not measure what it was asked to.
    headline:
      total === 0
        ? 'nothing was skipped'
        : `${total} skipped · ${actionable} worth acting on, ${total - actionable} expected here` +
          (unexplained ? ` · ${unexplained} with NO reason recorded (a harness defect)` : ''),
  };
}

export interface TimeoutGroup {
  key: string;
  endpoint: string | null;
  backend: string | null;
  n: number;
  /** The longest observed duration in the group, when the rows carried one. */
  longestMs: number | null;
  /** Prompt ids, most-timed-out first. */
  prompts: string[];
  /** The distinct budgets involved, ascending. */
  budgets: number[];
}

export interface TimeoutSummary {
  total: number;
  groups: TimeoutGroup[];
  headline: string;
}

/**
 * Timeouts, grouped by where they happened and against which budget.
 *
 * A timeout is not a skip: the request WAS sent and the target did not answer inside the prompt's own
 * `timeoutMs`. Grouped by (endpoint, backend) with the budgets involved, because "35 timeouts" spread
 * over twelve endpoints and "35 timeouts all on one" are different findings that a single chip could
 * not tell apart.
 */
export function summarizeTimeouts(rows: readonly EvalOutcomeRow[] | null | undefined): TimeoutSummary {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r?.status === 'timeout');
  const groups = new Map<
    string,
    {
      key: string;
      endpoint: string | null;
      backend: string | null;
      n: number;
      prompts: Map<string, number>;
      budgets: Map<number, number>;
      longestMs: number | null;
    }
  >();

  for (const r of list) {
    const key = `${r.endpoint || 'unknown endpoint'} · ${r.backend || 'unknown backend'}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, endpoint: r.endpoint ?? null, backend: r.backend ?? null, n: 0, prompts: new Map(), budgets: new Map(), longestMs: null };
      groups.set(key, g);
    }
    g.n++;
    if (r.promptId) g.prompts.set(r.promptId, (g.prompts.get(r.promptId) ?? 0) + 1);
    if (typeof r.timeoutMs === 'number' && Number.isFinite(r.timeoutMs)) g.budgets.set(r.timeoutMs, (g.budgets.get(r.timeoutMs) ?? 0) + 1);
    if (typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && (g.longestMs === null || r.durationMs > g.longestMs))
      g.longestMs = r.durationMs;
  }

  const out: TimeoutGroup[] = [...groups.values()]
    .map((g) => ({
      key: g.key,
      endpoint: g.endpoint,
      backend: g.backend,
      n: g.n,
      longestMs: g.longestMs,
      prompts: [...g.prompts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id),
      budgets: [...g.budgets.keys()].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.n - a.n);

  return {
    total: list.length,
    groups: out,
    headline:
      list.length === 0
        ? 'nothing timed out'
        : `${list.length} timed out across ${out.length} endpoint/backend pair(s) — the request was SENT and no answer arrived inside the prompt's own budget, which is a measurement, not a skip`,
  };
}
