/**
 * Setting a Lemonade model's KV cache type: the llama-server flags, what they save, and the rule for
 * when the Hub may use them. Pure, so each piece is testable without a server.
 *
 * WHY THE FLAGS ARE SAVED, NOT SENT. Lemonade combines the `llamacpp_args` of every layer — its own
 * defaults for the model's architecture (Qwen 3.8's sampling: `--temp 1.0 --top-p 0.95 ...`), the
 * model's saved options, server settings — flag by flag, EXCEPT that `llamacpp_args` in a load request
 * replaces the model's and the architecture's for that load (Lemonade 2026.45.3 `POST /v1/load`,
 * "Option Priority"). Sent on the load, the cache flags dropped the 27B's sampling and
 * `--chat-template-kwargs` (seen 2026-11-10). So they go into the model's saved options with
 * `POST /v1/models/{id}/options`, and the load sends none.
 */

/**
 * The quantized cache types the Hub sets, most precise first: the order the planner tries them in.
 *
 * q4_0 is a last step. Measured 2026-11-10 on Qwen 3.5 4B and Gemma 4 E4B (Lemonade, 64k window, 16-bit
 * run twice as the noise floor, which came out identical): recall of 12 facts hidden through 58k tokens
 * 12/12 at every type, HBPE labels 40/40; image descriptions identical 10-12 of 20 at q8_0 and 3 of 20 at
 * q4_0, wording mostly, with an ambiguous detail flipped now and then; graph-enrichment extraction the
 * most changed — Gemma's long batch agreed 0.70 with 16-bit at q8_0 and 0.18 at q4_0, and Qwen 3.5 4B
 * overran its output on 2 of 4 batches at every quantized type, never at 16-bit. So q4_0 only where q8_0
 * cannot reach an installed app's floor, which is where it buys an agent the window it needs.
 */
export const QUANTIZED_KV_CACHE_TYPES = ['q8_0', 'q4_0'] as const;
export type QuantizedKvCacheType = (typeof QUANTIZED_KV_CACHE_TYPES)[number];

/** The cache a load runs with: the 16-bit default, or a quantized type. */
export type KvCacheChoice = 'f16' | QuantizedKvCacheType;

/** llama-server flags for each cache type. A quantized V cache needs flash attention, so it is forced on. */
export const LEMONADE_KV_CACHE_FLAGS: Record<QuantizedKvCacheType, string> = {
  q8_0: '-fa on --cache-type-k q8_0 --cache-type-v q8_0',
  q4_0: '-fa on --cache-type-k q4_0 --cache-type-v q4_0',
};

/**
 * Bytes a cache type stores per value against the 16-bit default: q8_0 keeps 32 values in 34 bytes and
 * q4_0 in 18, against 64.
 */
export const KV_CACHE_SCALE: Record<QuantizedKvCacheType, number> = {
  q8_0: 34 / 64,
  q4_0: 18 / 64,
};

/** The share of the 16-bit cost a choice costs: 1 for `f16` or none. */
export function kvCacheScaleFor(choice: KvCacheChoice | undefined): number {
  return choice === undefined || choice === 'f16' ? 1 : KV_CACHE_SCALE[choice];
}

/** Flags {@link withKvCacheFlags} replaces: any earlier setting of flash attention or either cache type. */
const OWNED_FLAGS = new Set(['-fa', '--flash-attn', '-ctk', '--cache-type-k', '-ctv', '--cache-type-v']);
/** Values `--flash-attn` takes; anything else after it is the next flag, as with an older valueless `--flash-attn`. */
const FLASH_ATTN_VALUES = new Set(['on', 'off', 'auto', 'true', 'false', '1', '0']);

/** Splits a flag string on whitespace outside quotes, keeping each token's text as written (quotes included). */
function tokenize(args: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const char of args) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      current += char;
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * `args` with the flags for `type` in place of any flash-attention or cache-type flags it had, every
 * other flag kept as written: an operator's `--parallel 2`, the 27B's quoted
 * `--chat-template-kwargs '{"preserve_thinking":true}'`. `args` is a saved `llamacpp_args`, or
 * absent when the model has none saved.
 */
export function withKvCacheFlags(args: unknown, type: QuantizedKvCacheType): string {
  const kept = withoutOwnedFlags(args);
  return [...kept, LEMONADE_KV_CACHE_FLAGS[type]].join(' ');
}

/**
 * `args` with any flash-attention and cache-type flags taken out and every other flag kept as
 * written: what a model goes back to for the 16-bit cache. Empty when nothing else was saved.
 */
export function withoutKvCacheFlags(args: unknown): string {
  return withoutOwnedFlags(args).join(' ');
}

/**
 * The quantized cache type a saved `llamacpp_args` sets — what Lemonade runs the model with on its
 * next load, whoever saved it — or null for the 16-bit default.
 */
export function savedKvCacheType(args: unknown): QuantizedKvCacheType | null {
  const tokens = typeof args === 'string' ? tokenize(args) : [];
  for (let i = 0; i < tokens.length; i++) {
    const [name, inlineValue] = (tokens[i] as string).split('=', 2) as [string, string | undefined];
    if (name !== '-ctv' && name !== '--cache-type-v') continue;
    const value = (inlineValue ?? tokens[i + 1] ?? '').toLowerCase();
    if (value === 'q8_0' || value === 'q4_0') return value;
  }
  return null;
}

function withoutOwnedFlags(args: unknown): string[] {
  const tokens = typeof args === 'string' ? tokenize(args) : [];
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    const [name, inlineValue] = token.split('=', 2) as [string, string | undefined];
    if (!OWNED_FLAGS.has(name)) {
      kept.push(token);
      continue;
    }
    if (inlineValue !== undefined) continue;
    const next = tokens[i + 1];
    const takesValue =
      name === '-fa' || name === '--flash-attn' ? next !== undefined && FLASH_ATTN_VALUES.has(next.toLowerCase()) : next !== undefined;
    if (takesValue) i++;
  }
  return kept;
}

/**
 * A load with a quantized KV cache failed, and its flags were taken back out of the model's saved
 * options. The router re-plans at 16-bit and loads once more; only when that succeeds was the cache
 * the cause, and the model is marked unable to use it (`InferenceBackend.markKvCacheUnsupported`).
 */
export class KvCacheLoadError extends Error {
  constructor(
    readonly kvCacheType: KvCacheChoice,
    readonly loadError: unknown,
  ) {
    super(`Loading with a ${kvCacheType} KV cache failed: ${loadError instanceof Error ? loadError.message : String(loadError)}`);
    this.name = 'KvCacheLoadError';
  }
}

/**
 * Whether this Lemonade saves a model's options without loading it (`POST /v1/models/{id}/options`),
 * which setting a cache type needs (see the module comment). Versions are date-based from 2026
 * (2026.39.1, 2026.45.3) and have it; the fleet's apt 10.2.0 does not — the Hub's window saves there
 * already go through `save_options` on the load for that reason. An unreadable version says no.
 */
export function lemonadeSavesOptionsWithoutLoading(version: string | null): boolean {
  const major = version ? Number.parseInt(version.split('.')[0] ?? '', 10) : Number.NaN;
  return Number.isFinite(major) && major >= 2026;
}
