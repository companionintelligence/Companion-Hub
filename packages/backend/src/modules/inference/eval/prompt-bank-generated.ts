/**
 * Generated prompt corpus — the volume half of the bank.
 *
 * WHY THIS IS A GENERATOR AND NOT 935 MORE HAND-WRITTEN ENTRIES
 *
 * `llm-prompt-bank.ts` holds 65 entries and states the rule they are held to: "An entry that cannot
 * say what it tests should not exist." Every one of them names a distinct failure mode — a slot held
 * open for minutes, a batch that copies input[0] across every output, a tokenizer edge. That set is
 * deliberately small because each addition had to earn a `why`.
 *
 * A speed benchmark needs the opposite thing. To say "this runner is faster than that one on code at
 * a 512-token budget" you need MANY samples per cell, and they must differ from one another — a
 * hundred copies of one prompt measures one prompt's cache behaviour, not a workload. Hand-writing
 * those would produce near-duplicates with invented `why` fields, which is worse than generating
 * them honestly.
 *
 * So: the curated bank stays the correctness suite, and this file is the throughput corpus. Every
 * generated entry still says what it tests, because its `why` names the axis tuple it occupies and
 * its assertion is DERIVED from that tuple rather than asserted by hand. A cell with no meaningful
 * assertion is not emitted.
 *
 * DETERMINISM IS THE POINT. Nothing here calls Math.random or reads a clock. `buildGeneratedPrompts(n)`
 * returns the same n prompts, in the same order, with the same ids, on every machine and every run —
 * which is the only way last week's numbers and today's compare. Variation comes from the index, by
 * mixing the axis positions with distinct strides so consecutive prompts differ on every axis at once
 * rather than marching through one axis at a time (which would put a whole run's `json` cell in one
 * contiguous block and hand it to whichever node happened to be free then).
 *
 * READ-ONLY, like the curated bank: these are inference requests against models a node already holds.
 * Nothing here names a URL — the dialect chooses the path, and the driver's allowlist is what makes
 * that binding safe (see `assertReadOnlyPath` in lib/backend-drivers.ts).
 */

import { LLM_BACKENDS, type LlmAssertion, type LlmBackend, type LlmContentClass, type LlmDialect, type LlmPrompt } from './prompt-bank';

const ALL: LlmBackend[] = [...LLM_BACKENDS];

/**
 * The subject filler.
 *
 * These exist to make prompts DIFFERENT, not to test knowledge — a benchmark must not be a quiz, or
 * a small model scores "slow" for being wrong. Every subject is a neutral, widely-documented
 * engineering topic with no single right answer, so the assertion can stay a shape check.
 */
const SUBJECTS: string[] = [
  'a write-ahead log',
  'consistent hashing',
  'a bloom filter',
  'copy-on-write snapshots',
  'TCP slow start',
  'a B-tree index',
  'vector clocks',
  'the raft leader election',
  'connection pooling',
  'content-addressed storage',
  'a circuit breaker',
  'backpressure in queues',
  'CRDT merge semantics',
  'a skip list',
  'read-repair in eventual consistency',
  'MVCC',
  'zero-copy networking',
  'an LRU cache',
  'columnar storage layout',
  'write amplification',
  'a token bucket rate limiter',
  'DNS resolution order',
  'TLS session resumption',
  'HTTP/2 multiplexing',
  'container layer caching',
  'cgroup memory limits',
  'NUMA locality',
  'page cache eviction',
  'a ring buffer',
  'lock-free queues',
  'the actor model',
  'structured concurrency',
  'speculative decoding',
  'KV-cache reuse',
  'tensor parallelism',
  'quantization error',
  'mixture-of-experts routing',
  'rotary position embeddings',
  'grouped-query attention',
  'flash attention',
  'gradient checkpointing',
  'a learning-rate warmup',
  'beam search',
  'nucleus sampling',
  'retrieval-augmented generation',
  'embedding dimensionality',
  'cosine similarity',
  'HNSW graph search',
  'idempotency keys',
  'exactly-once delivery',
  'the outbox pattern',
  'saga compensation',
  'blue-green deploys',
  'canary analysis',
  'feature flags',
  'schema migration ordering',
  'a health check probe',
  'graceful shutdown',
  'log structured merge trees',
  'compaction strategy',
];

/**
 * SQL's own task pool.
 *
 * Every other language shares CODE_TASKS through the template "Write a {lang} function that
 * {task}." SQL does not have functions in that sense — running it through the same template asked
 * for things like "a SQL function that debounces a callback", which is not a task SQL answers, so
 * the class's own uplift number was partly measuring how a model handles a nonsensical prompt for
 * one-sixth of its rows. SQL gets a QUERY-shaped task pool and its own template clause instead, sized
 * to match CODE_TASKS.length so the per-language slice of `generatedVariantCapacity()` stays exact.
 */
const SQL_TASKS: string[] = [
  'returns the second-highest salary in an employees table',
  'finds gaps in a sequential integer id column',
  'computes a running total ordered by date within each group',
  'finds duplicate rows across a set of columns',
  'joins a table to itself to find each employee’s manager’s name',
  'returns the top 3 rows per group by a score column',
  'computes each row’s percentage of its group’s total',
  'performs an upsert that inserts a row or updates it on a unique-key conflict',
  'finds date ranges in one table that overlap a date range in another',
  'computes a median value using percentile functions',
  'selects the first and last event per session, ordered by timestamp',
  'returns a recursive result for a self-referencing org-chart table',
  'performs an anti-join, returning rows in one table with no match in another',
  'counts distinct values cumulatively over time within a partition',
  'extracts a field from a JSON column and filters on its value',
  'adds a NOT NULL constraint to an existing column without locking the whole table',
  'computes a moving average over the last N rows within a partition',
  'pivots rows into columns for a fixed, known set of category values',
  'finds the longest streak of consecutive days a user was active',
  'computes rank and dense_rank for a score column within groups, and explains the difference in a comment',
  'returns rows updated in the last 24 hours across two related tables via a join',
  'computes the difference between each row’s value and the previous row’s value within a partition',
  'lists columns that would benefit from an index based on the query’s own filter and join conditions, as a comment',
  'deletes duplicate rows, keeping only the one with the lowest id',
  'computes a cohort retention rate by signup month',
  'returns rows whose value is more than two standard deviations from the group mean',
  'builds a summary table refreshed from a base table’s changes since a watermark column',
  'lists foreign key columns that reference a given table',
  'computes the intersection of two sets of ids using set operations',
  'finds the most recent non-null value for a column, carried forward per row',
  'returns paginated results using keyset pagination rather than OFFSET',
  'computes a weighted average grouped by category',
];

/**
 * Programming languages for the `code` class, each with an anchor that any real answer contains.
 *
 * `unit` names what the model is asked to write ("function" for every ordinary language); `tasks`
 * lets a language draw from its own pool instead of the shared CODE_TASKS — SQL is the one language
 * here that needs both, since "write a SQL function that debounces a callback" is not a real task.
 */
const CODE_LANGS: { lang: string; anchors: string[]; unit?: string; tasks?: string[] }[] = [
  { lang: 'Python', anchors: ['def '] },
  { lang: 'TypeScript', anchors: ['function', 'return'] },
  { lang: 'Go', anchors: ['func '] },
  { lang: 'Rust', anchors: ['fn '] },
  { lang: 'SQL', anchors: ['SELECT'], unit: 'query', tasks: SQL_TASKS },
  { lang: 'Bash', anchors: ['#!/'] },
  { lang: 'Java', anchors: ['class ', 'public '] },
  { lang: 'C++', anchors: ['#include'] },
  { lang: 'Kotlin', anchors: ['fun '] },
];

/** Small, self-contained programming tasks. Paired with a language to make the `code` cells. */
const CODE_TASKS: string[] = [
  'parses a duration string like "1h30m" into seconds',
  'merges two sorted arrays without allocating a third',
  'debounces a callback with a trailing edge',
  'computes a rolling median over a fixed window',
  'retries an operation with exponential backoff and jitter',
  'validates a semantic version string and compares two of them',
  'flattens an arbitrarily nested list iteratively',
  'implements a fixed-capacity LRU cache',
  'chunks a byte stream on a delimiter without buffering all of it',
  'converts a nested object into dot-separated key paths',
  'finds the longest common prefix of a list of strings',
  'implements a token-bucket rate limiter',
  'deduplicates records by a composite key, keeping the newest',
  'formats a byte count as a human-readable size',
  'walks a directory tree and totals file sizes by extension',
  'parses a CSV line that contains quoted commas',
  'sorts a list in place using quicksort with a median-of-three pivot',
  'merges overlapping intervals given as [start, end] pairs',
  'performs a topological sort of a dependency graph, erroring on a cycle',
  'computes the Levenshtein edit distance between two strings',
  'inserts into and searches a trie of lowercase words',
  'computes the sliding-window maximum over an array for a fixed window size',
  'checks whether a string of brackets, braces and parentheses is balanced',
  'computes an exponential moving average over a stream of numbers',
  'wraps a paragraph of text to a fixed line width without breaking words',
  'implements union-find with path compression and union by rank',
  'memoizes a pure recursive function with an unbounded cache',
  'counts the number of set bits in an unsigned integer using bitwise operations',
  'implements a concurrency-safe counter that many callers can increment at once',
  'builds a minimal event emitter with on/off/emit methods',
  'transposes a square 2D matrix in place',
  'implements a bounded producer-consumer queue that blocks when full',
];

/** Non-English chat, so the corpus is not an English-only measurement. */
const LANGUAGES: { code: string; name: string; ask: (s: string) => string }[] = [
  { code: 'en', name: 'English', ask: (s) => `Explain ${s} to a working engineer.` },
  { code: 'es', name: 'Spanish', ask: (s) => `Explica ${s} a un ingeniero. Responde en español.` },
  { code: 'de', name: 'German', ask: (s) => `Erkläre ${s} für eine Ingenieurin. Antworte auf Deutsch.` },
  { code: 'ja', name: 'Japanese', ask: (s) => `${s} をエンジニア向けに説明してください。日本語で答えてください。` },
  { code: 'fr', name: 'French', ask: (s) => `Explique ${s} à un ingénieur. Réponds en français.` },
];

/**
 * Output budgets.
 *
 * The bank's own `class-code` / `class-code-long` pair exists because tok/s on a ~120-token answer is
 * dominated by fixed per-request overhead. Three budgets per class make that curve measurable
 * instead of leaving it as a two-point guess, and the cost tier follows the budget so the scheduler's
 * existing expensive-prompt handling keeps working.
 */
const BUDGETS: { key: string; maxTokens: number; cost: 'trivial' | 'moderate' | 'heavy'; timeoutMs: number }[] = [
  { key: 's', maxTokens: 128, cost: 'trivial', timeoutMs: 120_000 },
  { key: 'm', maxTokens: 512, cost: 'moderate', timeoutMs: 240_000 },
  { key: 'l', maxTokens: 1024, cost: 'heavy', timeoutMs: 420_000 },
];

/**
 * Dialects the corpus rotates through.
 *
 * Only chat dialects: the generated corpus measures decode throughput, and the embedding and legacy
 * completion routes are conformance surfaces the curated bank already covers entry by entry. Both
 * chat dialects appear so a per-runner number is never an artifact of one wire format — Ollama's
 * native `/api/chat` and its OpenAI shim are different handlers on the same engine.
 */
const DIALECTS: LlmDialect[] = ['openai-chat', 'ollama-chat'];

/**
 * Framings for the classes whose subject list alone cannot supply enough distinct prompts.
 *
 * A class emits ~200 prompts and there are 60 subjects, so subject-alone repeats each body more than
 * three times. Repetition is the one thing this corpus must not have: a prompt sent twice to the same
 * node is answered the second time from a warm KV cache and prefill effectively disappears, so the
 * duplicate measures caching rather than decoding and silently drags the cell's median down.
 */
const LIST_FRAMINGS: string[] = [
  'for a code-review checklist',
  'for an incident runbook',
  'for a design-document review',
  'for an on-call handover note',
];

const CODE_STYLES: { hint: string; key: string }[] = [
  { key: 'doc', hint: 'Include a short doc comment.' },
  { key: 'err', hint: 'Handle malformed input explicitly rather than assuming it is well-formed.' },
  { key: 'test', hint: 'Follow the function with two example assertions.' },
  { key: 'perf', hint: 'Avoid allocating inside the hot loop, and say why in one comment.' },
];

const JSON_SHAPES: { key: string; keys: string[]; spec: (s: string, n: number) => string }[] = [
  {
    key: 'notes',
    keys: ['topic', 'notes'],
    spec: (s, n) => `{"topic": string, "notes": string[]} where "topic" is ${JSON.stringify(s)} and "notes" holds ${n} short strings about it`,
  },
  {
    key: 'tradeoff',
    keys: ['topic', 'pros', 'cons'],
    spec: (s, n) =>
      `{"topic": string, "pros": string[], "cons": string[]} where "topic" is ${JSON.stringify(s)} and each array holds ${n} short strings`,
  },
  {
    key: 'steps',
    keys: ['topic', 'steps'],
    spec: (s, n) =>
      `{"topic": string, "steps": [{"n": number, "action": string}]} where "topic" is ${JSON.stringify(s)} and "steps" holds ${n} entries numbered from 1`,
  },
  {
    key: 'rating',
    keys: ['topic', 'aspects'],
    spec: (s, n) =>
      `{"topic": string, "aspects": [{"name": string, "score": number}]} where "topic" is ${JSON.stringify(s)} and "aspects" holds ${n} entries scored 1-5`,
  },
];

const TABLE_COLUMNS: { key: string; cols: string }[] = [
  { key: 'sc', cols: 'Approach | Strength | Cost' },
  { key: 'wf', cols: 'Option | When it fits | Failure mode' },
  { key: 'op', cols: 'Technique | Operational risk | Mitigation' },
  { key: 'cx', cols: 'Variant | Complexity | Typical scale' },
];

/**
 * Decompose an ordinal into independent axis positions (mixed radix).
 *
 * `axes([60, 5], k)` walks all 300 combinations before repeating any — which is what the previous
 * stride-multiplication did NOT do. Multiplying one counter by a stride and taking it modulo each
 * axis length ties the axes together through their common factors: the first cut of this file
 * produced 1000 prompts with only 96 distinct bodies that way. Successive division cannot alias,
 * so the only repetition is the deliberate wrap past the full product.
 */
function axes(radices: number[], k: number): number[] {
  const out: number[] = [];
  let rest = k;
  for (const r of radices) {
    out.push(rest % r);
    rest = Math.floor(rest / r);
  }
  return out;
}

interface Cell {
  contentClass: LlmContentClass;
  /** Distinct bodies this cell can produce before it must repeat one. Asserted by the bank test. */
  variants: number;
  /** Builds the request body from this cell's own ordinal `k` (0,1,2… within the class). */
  make: (k: number, budget: (typeof BUDGETS)[number]) => { system?: string; user: string; label: string; why: string };
  /** Shape assertion for this class, at this budget. */
  assert: (budget: (typeof BUDGETS)[number], ctx: { anchors?: string[]; jsonKeys?: string[] }) => LlmAssertion;
  /** Anchors carried from make() into assert() — code needs the language's own. */
  anchorsFor?: (k: number) => string[];
  /** Required JSON keys, for the json cell whose schema varies per variant. */
  jsonKeysFor?: (k: number) => string[];
}

const pick = <T>(arr: T[], i: number): T => arr[((i % arr.length) + arr.length) % arr.length] as T;

/**
 * The five comparable content classes, as generator cells.
 *
 * These are the same five `LLM_COMPARABLE_CONTENT_CLASSES` names the reporting already groups by, so
 * a generated run drops straight into the per-class breakdown the dashboard draws — no new axis, far
 * more samples per cell.
 */
const CELLS: Cell[] = [
  {
    contentClass: 'prose',
    variants: SUBJECTS.length * LANGUAGES.length,
    make: (k, b) => {
      const [si, li] = axes([SUBJECTS.length, LANGUAGES.length], k);
      const subject = pick(SUBJECTS, si ?? 0);
      const lang = pick(LANGUAGES, li ?? 0);
      const paras = b.maxTokens <= 128 ? 1 : b.maxTokens <= 512 ? 2 : 4;
      return {
        system: 'Answer in plain prose. No bullet points, no headings, no code.',
        user: `${lang.ask(subject)} Write ${paras} paragraph${paras > 1 ? 's' : ''}.`,
        label: `prose · ${subject} · ${lang.code} · ${b.key}`,
        why: `Prose decode at a ${b.maxTokens}-token budget in ${lang.name}. Prose is the class with the LEAST token-to-token predictability, so it is the floor a runner's throughput is measured against — the fleet's own paired numbers put code at 1.6–3.7x and prose at ~1.0.`,
      };
    },
    assert: (b) => ({
      acceptStatuses: [200],
      minTextChars: 80,
      nonDegenerate: true,
      noReplacementChars: true,
      // A budget the server ignores is a real failure mode, but the ceiling has to be loose: token
      // budgets are not character budgets and multi-byte scripts spend more characters per token.
      maxTextChars: b.maxTokens * 24,
      onFailure: 'warn',
    }),
  },
  {
    contentClass: 'code',
    variants: CODE_LANGS.length * CODE_TASKS.length * CODE_STYLES.length,
    anchorsFor: (k) => pick(CODE_LANGS, axes([CODE_LANGS.length], k)[0] ?? 0).anchors,
    make: (k, b) => {
      const [li, ti, yi] = axes([CODE_LANGS.length, CODE_TASKS.length, CODE_STYLES.length], k);
      const langEntry = pick(CODE_LANGS, li ?? 0);
      const { lang, unit = 'function', tasks = CODE_TASKS } = langEntry;
      const task = pick(tasks, ti ?? 0);
      const style = pick(CODE_STYLES, yi ?? 0);
      return {
        system: `Reply with ${lang} source only. No explanation before or after the code.`,
        user: `Write a ${lang} ${unit} that ${task}. ${style.hint}`,
        label: `code · ${lang} · ${style.key} · ${b.key}`,
        why: `Code decode at a ${b.maxTokens}-token budget in ${lang}. Code is highly predictable token-to-token (indentation, keywords, closing brackets), which is why it is where a speculative or MTP runner shows its largest uplift — and why a fleet number computed over a prose-heavy mix says nothing about a coding workload.${lang === 'SQL' ? ' SQL draws from its own query-shaped task pool rather than CODE_TASKS — it has no "function" in the sense every other language here does, so sharing the generic pool used to produce prompts like "a SQL function that debounces a callback".' : ''}`,
      };
    },
    assert: (b, ctx) => ({
      acceptStatuses: [200],
      minTextChars: 60,
      nonDegenerate: true,
      containsAll: ctx.anchors ?? [],
      maxTextChars: b.maxTokens * 24,
      onFailure: 'warn',
    }),
  },
  {
    contentClass: 'list',
    variants: SUBJECTS.length * LIST_FRAMINGS.length,
    make: (k, b) => {
      const [si, fi] = axes([SUBJECTS.length, LIST_FRAMINGS.length], k);
      const subject = pick(SUBJECTS, si ?? 0);
      const framing = pick(LIST_FRAMINGS, fi ?? 0);
      const n = b.maxTokens <= 128 ? 5 : b.maxTokens <= 512 ? 10 : 16;
      return {
        system: 'Answer as a numbered list. One item per line. No preamble, no closing summary.',
        user: `List ${n} practical considerations when working with ${subject}, written ${framing}.`,
        label: `list · ${subject} · ${framing} · ${b.key}`,
        why: `List decode at a ${b.maxTokens}-token budget. A list is structurally predictable but semantically varied, so it sits between prose and code — and the line count is a cheap check that the budget was actually spent rather than truncated at item two.`,
      };
    },
    assert: (b) => ({
      acceptStatuses: [200],
      // Deliberately below the requested count: a model that stops at the token budget mid-list is
      // doing what it was told, and grading that a failure would measure the budget, not the runner.
      minLines: 3,
      nonDegenerate: true,
      maxTextChars: b.maxTokens * 24,
      onFailure: 'warn',
    }),
  },
  {
    contentClass: 'table',
    variants: SUBJECTS.length * TABLE_COLUMNS.length,
    make: (k, b) => {
      const [si, ci] = axes([SUBJECTS.length, TABLE_COLUMNS.length], k);
      const subject = pick(SUBJECTS, si ?? 0);
      const cols = pick(TABLE_COLUMNS, ci ?? 0);
      const rows = b.maxTokens <= 128 ? 3 : b.maxTokens <= 512 ? 6 : 10;
      return {
        system: 'Answer with a GitHub-flavoured Markdown table and nothing else.',
        user: `Produce a Markdown table with ${rows} rows comparing approaches to ${subject}. Columns: ${cols.cols}.`,
        label: `table · ${subject} · ${cols.key} · ${b.key}`,
        why: `Table decode at a ${b.maxTokens}-token budget. Tables are the most rigidly templated class in the corpus — every row repeats the same delimiter structure — so they are the upper bound on what structure alone buys a runner.`,
      };
    },
    assert: (b) => ({
      acceptStatuses: [200],
      containsAll: ['|'],
      minLines: 3,
      nonDegenerate: true,
      maxTextChars: b.maxTokens * 24,
      onFailure: 'warn',
    }),
  },
  {
    contentClass: 'json',
    variants: SUBJECTS.length * JSON_SHAPES.length,
    jsonKeysFor: (k) => pick(JSON_SHAPES, axes([SUBJECTS.length, JSON_SHAPES.length], k)[1] ?? 0).keys,
    make: (k, b) => {
      const [si, hi] = axes([SUBJECTS.length, JSON_SHAPES.length], k);
      const subject = pick(SUBJECTS, si ?? 0);
      const shape = pick(JSON_SHAPES, hi ?? 0);
      const n = b.maxTokens <= 128 ? 2 : b.maxTokens <= 512 ? 4 : 8;
      return {
        system: 'Reply with a single JSON object and nothing else. No markdown fence, no prose.',
        user: `Return JSON: ${shape.spec(subject, n)}.`,
        label: `json · ${subject} · ${shape.key} · ${b.key}`,
        why: `Constrained-decoding path at a ${b.maxTokens}-token budget, schema variant "${shape.key}". This is the only generated class whose answer is machine-checkable rather than shape-checkable, so it doubles as a per-runner correctness signal: a backend that serves fluent JSON-ish text which does not parse breaks every downstream app while scoring well on every other class.`,
      };
    },
    assert: (b, ctx) => ({
      acceptStatuses: [200],
      jsonParses: true,
      jsonRequiredKeys: ctx.jsonKeys ?? ['topic'],
      nonDegenerate: true,
      maxTextChars: b.maxTokens * 24,
      onFailure: 'warn',
    }),
  },
];

/** Pad to a fixed width so generated ids sort lexicographically in the order they were produced. */
function pad(n: number, width = 4): string {
  return String(n).padStart(width, '0');
}

/**
 * Build `count` deterministic prompts.
 *
 * Streaming alternates rather than being on for everything: TTFT is only measurable on a streamed
 * row, but streaming changes how a server frames its answer and a corpus that never sends a
 * non-streamed request cannot see a bug that only appears in the buffered path (the curated bank has
 * one such entry precisely because that happened).
 */
export function buildGeneratedPrompts(count: number): LlmPrompt[] {
  const out: LlmPrompt[] = [];
  // Per-class counter. Each class advances its OWN ordinal, so its variant axes are walked in full
  // (subject × framing × …) instead of being sampled every CELLS.length-th step — the aliasing that
  // produced 96 distinct bodies out of 1000 before `axes()` replaced stride multiplication.
  const seen = new Map<LlmContentClass, number>();
  for (let i = 0; i < count; i++) {
    const cell = pick(CELLS, i);
    const budget = pick(BUDGETS, Math.floor(i / CELLS.length));
    const dialect = pick(DIALECTS, Math.floor(i / (CELLS.length * BUDGETS.length)));
    const k = seen.get(cell.contentClass) ?? 0;
    seen.set(cell.contentClass, k + 1);
    const stream = i % 2 === 0;

    const built = cell.make(k, budget);
    const anchors = cell.anchorsFor ? cell.anchorsFor(k) : undefined;
    const jsonKeys = cell.jsonKeysFor ? cell.jsonKeysFor(k) : undefined;

    out.push({
      id: `gen-${cell.contentClass}-${budget.key}-${dialect === 'ollama-chat' ? 'native' : 'openai'}-${pad(i)}`,
      label: built.label,
      why: built.why,
      // 'load' rather than 'baseline': these exist to produce throughput samples in bulk. Filing them
      // as baseline would put a thousand generated rows into the smoke preset.
      category: 'load',
      contentClass: cell.contentClass,
      cost: budget.cost,
      dialect,
      backends: ALL,
      role: 'chat',
      stream,
      fanout: 1,
      timeoutMs: budget.timeoutMs,
      input: { system: built.system, user: built.user },
      // temperature 0 throughout: two runs of the same prompt must differ because the RUNNER differs,
      // not because sampling did. It also keeps the JSON cell's parse check honest.
      params: { max_tokens: budget.maxTokens, temperature: 0 },
      assert: cell.assert(budget, { anchors, jsonKeys }),
    });
  }
  return out;
}

/**
 * Distinct bodies this corpus can produce before any prompt text repeats.
 *
 * Exposed rather than kept private because it is the number that bounds an honest run: ask for more
 * prompts than this and some node answers the same text twice from a warm cache. The bank test
 * asserts GENERATED_BANK_DEFAULT stays under it.
 */
export function generatedVariantCapacity(): number {
  // Per class, a body is (variant × budget × dialect) — budget and dialect both change the text.
  return CELLS.reduce((n, c) => n + c.variants * BUDGETS.length * DIALECTS.length, 0);
}

/** Every generated id, for the selector and for preset membership. */
export function generatedPromptIds(count: number): string[] {
  return buildGeneratedPrompts(count).map((p) => p.id);
}

/**
 * Default corpus size.
 *
 * 1000 is the operator-facing number, and it divides the axis product cleanly enough that every
 * (class × budget × dialect) cell — 30 of them — receives 33 or 34 prompts. That is enough samples
 * per cell for a median to mean something and for the p95 to not be one unlucky request.
 */
export const GENERATED_BANK_DEFAULT = 1000;
