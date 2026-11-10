import type { CuratedModel } from '@ci-hub/common/types';

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

type KvCacheType = NonNullable<CuratedModel['runtime']['kvCacheType']>;

/** llama-server flags for each cache type. A quantized V cache needs flash attention, so it is forced on. */
export const LEMONADE_KV_CACHE_FLAGS: Record<KvCacheType, string> = {
  q8_0: '-fa on --cache-type-k q8_0 --cache-type-v q8_0',
};

/** Bytes a cache type stores per value against the 16-bit default: q8_0 keeps 32 values in 34 bytes, against 64. */
export const KV_CACHE_SCALE: Record<KvCacheType, number> = {
  q8_0: 34 / 64,
};

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
export function withKvCacheFlags(args: unknown, type: KvCacheType): string {
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
  return [...kept, LEMONADE_KV_CACHE_FLAGS[type]].join(' ');
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
