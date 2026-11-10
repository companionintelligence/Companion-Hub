import { describe, expect, it } from 'vitest';
import { KV_CACHE_SCALE, LEMONADE_KV_CACHE_FLAGS, lemonadeSavesOptionsWithoutLoading, withKvCacheFlags } from '../backends/lemonade-kv-cache.util';

describe('withKvCacheFlags', () => {
  const Q8 = LEMONADE_KV_CACHE_FLAGS.q8_0;

  it('is just the cache flags for a model with none saved', () => {
    expect(withKvCacheFlags(undefined, 'q8_0')).toBe(Q8);
    expect(withKvCacheFlags('', 'q8_0')).toBe(Q8);
  });

  // The 27B's flags as Lemonade launched it on 2026-11-10: the quoted JSON must come through intact.
  it('keeps every other saved flag as written, quoted JSON included', () => {
    const saved = `--temp 1.0 --top-p 0.95 --chat-template-kwargs '{"preserve_thinking":true}' --spec-type draft-mtp --parallel 1`;
    expect(withKvCacheFlags(saved, 'q8_0')).toBe(`${saved} ${Q8}`);
  });

  it('replaces an earlier flash-attention or cache-type setting, in any spelling', () => {
    expect(withKvCacheFlags('--parallel 2 -fa off -ctk f16 --cache-type-v=f16', 'q8_0')).toBe(`--parallel 2 ${Q8}`);
    expect(withKvCacheFlags('--flash-attn auto --cache-type-k q4_0 --parallel 1', 'q8_0')).toBe(`--parallel 1 ${Q8}`);
    // An older valueless --flash-attn: the flag after it is not swallowed as its value.
    expect(withKvCacheFlags('--flash-attn --parallel 1', 'q8_0')).toBe(`--parallel 1 ${Q8}`);
  });

  it('is idempotent, so saving it on every load changes nothing after the first', () => {
    const once = withKvCacheFlags('--parallel 1', 'q8_0');
    expect(withKvCacheFlags(once, 'q8_0')).toBe(once);
  });
});

describe('KV_CACHE_SCALE', () => {
  it('charges q8_0 at 34 bytes per 32 values against 64', () => {
    expect(KV_CACHE_SCALE.q8_0).toBeCloseTo(0.53125, 5);
  });
});

describe('lemonadeSavesOptionsWithoutLoading', () => {
  it('is true for date-based versions and false for the fleet 10.2.0 or an unread version', () => {
    expect(lemonadeSavesOptionsWithoutLoading('2026.45.3')).toBe(true);
    expect(lemonadeSavesOptionsWithoutLoading('2026.39.1')).toBe(true);
    expect(lemonadeSavesOptionsWithoutLoading('10.2.0')).toBe(false);
    expect(lemonadeSavesOptionsWithoutLoading(null)).toBe(false);
    expect(lemonadeSavesOptionsWithoutLoading('garbage')).toBe(false);
  });
});
