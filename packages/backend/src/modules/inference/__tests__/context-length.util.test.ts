import { describe, expect, it } from 'vitest';
import { appMinContextLength, recommendContextLength } from '../context-length.util';

describe('recommendContextLength', () => {
  it('scales the context window up with available memory', () => {
    const big = recommendContextLength({ effectiveInferenceMemoryMb: 65536, modelFootprintMb: 0, modelContextWindow: 262144 });
    const small = recommendContextLength({ effectiveInferenceMemoryMb: 7000, modelFootprintMb: 0, modelContextWindow: 262144 });
    expect(big).toBe(65536);
    expect(small).toBeLessThan(big);
  });

  describe('measured path (per-token KV cost from the engine)', () => {
    // RX 7900 XTX, 24,560 MB VRAM; qwen3.8:27b: catalog footprint 20,275 MB (18 GB × 1.1),
    // weights 16,920 MB, 17 full-attention layers × 4 KV heads × 512 × 2 B ≈ 0.0664 MB/token.
    const card = 24_560;
    const qwen = { modelFootprintMb: 20_275, weightMb: 16_920, kvMbPerToken: (17 * 4 * 512 * 2) / 1024 ** 2, modelContextWindow: 262_144 };

    it('sizes a hybrid-attention 27B to 32k on a 24 GB card, where the fixed ladder said 16k', () => {
      expect(recommendContextLength({ effectiveInferenceMemoryMb: card, ...qwen })).toBe(32768);
      expect(recommendContextLength({ effectiveInferenceMemoryMb: card, ...qwen, kvMbPerToken: null })).toBe(16384);
    });

    it('lets a small model with cheap KV reach the 64k cap, and never above it unprompted', () => {
      // gemma4:e4b: 24 layers × 2 KV heads × 1024 × 2 B ≈ 0.094 MB/token, 10.8 GB footprint.
      const gemma = { modelFootprintMb: 10_814, weightMb: 9_163, kvMbPerToken: (24 * 2 * 1024 * 2) / 1024 ** 2, modelContextWindow: 131_072 };
      expect(recommendContextLength({ effectiveInferenceMemoryMb: card, ...gemma })).toBe(65536);
      expect(recommendContextLength({ effectiveInferenceMemoryMb: 200_000, ...gemma })).toBe(65536);
    });

    it('charges the larger of the catalog footprint and weights-plus-overhead before any context', () => {
      // A stale catalog row says 1 GB for a model whose file is 22.5 GB: the weights term must keep
      // the budget honest (22,500 + 768 + 1,024 leaves 268 MB, below even 4k × 0.066 MB → floor), where the catalog
      // figure alone would have handed out 64k.
      const stale = { ...qwen, modelFootprintMb: 1_000, weightMb: 22_500 };
      expect(recommendContextLength({ effectiveInferenceMemoryMb: card, ...stale })).toBe(4096);
      expect(recommendContextLength({ effectiveInferenceMemoryMb: card, ...stale, weightMb: null })).toBe(65536);
    });

    it('drops to the floor when even 4k of context does not fit, and still honours an app floor and the model window', () => {
      expect(recommendContextLength({ effectiveInferenceMemoryMb: 21_500, ...qwen })).toBe(4096);
      expect(recommendContextLength({ effectiveInferenceMemoryMb: 21_500, ...qwen, minContextLength: 16_000 })).toBe(16000);
      expect(recommendContextLength({ effectiveInferenceMemoryMb: card, ...qwen, modelContextWindow: 8_192 })).toBe(8192);
    });

    it('treats a non-positive or non-finite cost as unmeasured', () => {
      for (const kvMbPerToken of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(recommendContextLength({ effectiveInferenceMemoryMb: card, ...qwen, kvMbPerToken })).toBe(16384);
      }
    });
  });

  it('never exceeds the model context window', () => {
    const ctx = recommendContextLength({ effectiveInferenceMemoryMb: 131072, modelFootprintMb: 0, modelContextWindow: 8192 });
    expect(ctx).toBe(8192);
  });

  it('subtracts the model footprint from the budget (APU unified memory)', () => {
    // 30 GiB unified, 17 GiB model → ~13 GiB free → 32768 tier.
    const ctx = recommendContextLength({ effectiveInferenceMemoryMb: 30720, modelFootprintMb: 17408, modelContextWindow: 262144 });
    expect(ctx).toBe(32768);
  });

  it('falls back conservatively when memory is unknown', () => {
    expect(recommendContextLength({ effectiveInferenceMemoryMb: 0, modelFootprintMb: 0, modelContextWindow: 262144 })).toBe(8192);
    expect(recommendContextLength({ effectiveInferenceMemoryMb: Number.NaN, modelFootprintMb: 0, modelContextWindow: 262144 })).toBe(8192);
  });

  it('floors at 4096 when almost no memory is free after weights', () => {
    const ctx = recommendContextLength({ effectiveInferenceMemoryMb: 18000, modelFootprintMb: 17408, modelContextWindow: 262144 });
    expect(ctx).toBe(4096);
  });

  it('defaults the cap when the model window is unset', () => {
    const ctx = recommendContextLength({ effectiveInferenceMemoryMb: 65536, modelFootprintMb: 0, modelContextWindow: 0 });
    expect(ctx).toBe(8192);
  });

  describe('minContextLength (app-specific floor)', () => {
    it('raises a memory-limited recommendation up to the floor', () => {
      // 12 GiB free → 32768 tier, but the app requires >= 64000.
      const ctx = recommendContextLength({
        effectiveInferenceMemoryMb: 12288,
        modelFootprintMb: 0,
        modelContextWindow: 131072,
        minContextLength: 64_000,
      });
      expect(ctx).toBe(64_000);
    });

    it('does not lower a recommendation that already clears the floor', () => {
      // 16 GiB free → 65536 tier, well above the 64000 floor.
      const ctx = recommendContextLength({
        effectiveInferenceMemoryMb: 16384,
        modelFootprintMb: 0,
        modelContextWindow: 131072,
        minContextLength: 64_000,
      });
      expect(ctx).toBe(65536);
    });

    it('never raises the floor above the model window', () => {
      // Model maxes out at 32768; the floor cannot exceed what the model serves.
      const ctx = recommendContextLength({
        effectiveInferenceMemoryMb: 4096,
        modelFootprintMb: 0,
        modelContextWindow: 32768,
        minContextLength: 64_000,
      });
      expect(ctx).toBe(32768);
    });

    it('applies the floor even when memory is unknown', () => {
      const ctx = recommendContextLength({
        effectiveInferenceMemoryMb: 0,
        modelFootprintMb: 0,
        modelContextWindow: 131072,
        minContextLength: 64_000,
      });
      expect(ctx).toBe(64_000);
    });

    it('returns an integer token count even for a fractional floor or model window', () => {
      const fractionalFloor = recommendContextLength({
        effectiveInferenceMemoryMb: 12288,
        modelFootprintMb: 0,
        modelContextWindow: 131072,
        minContextLength: 64000.5,
      });
      expect(fractionalFloor).toBe(64000);
      expect(Number.isInteger(fractionalFloor)).toBe(true);

      const fractionalCap = recommendContextLength({
        effectiveInferenceMemoryMb: 131072,
        modelFootprintMb: 0,
        modelContextWindow: 8192.9,
      });
      expect(fractionalCap).toBe(8192);
      expect(Number.isInteger(fractionalCap)).toBe(true);
    });

    it('ignores a non-finite floor instead of returning NaN', () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const ctx = recommendContextLength({
          effectiveInferenceMemoryMb: 12288,
          modelFootprintMb: 0,
          modelContextWindow: 131072,
          minContextLength: bad,
        });
        expect(ctx).toBe(32768); // falls back to the pure ladder value, never NaN
      }
    });

    it('is a no-op when no floor is given (default behavior preserved)', () => {
      const ctx = recommendContextLength({
        effectiveInferenceMemoryMb: 12288,
        modelFootprintMb: 0,
        modelContextWindow: 131072,
      });
      expect(ctx).toBe(32768);
    });
  });

  describe('appMinContextLength (per-app floor registry)', () => {
    it('returns 64000 for hermes-agent (its hard startup minimum)', () => {
      expect(appMinContextLength('hermes-agent')).toBe(64_000);
    });

    it('returns undefined for apps with no declared minimum', () => {
      expect(appMinContextLength('openclaw')).toBeUndefined();
      expect(appMinContextLength('some-other-app')).toBeUndefined();
    });

    it('returns undefined for null/empty slugs', () => {
      expect(appMinContextLength(null)).toBeUndefined();
      expect(appMinContextLength(undefined)).toBeUndefined();
      expect(appMinContextLength('')).toBeUndefined();
    });

    it('returns undefined for Object.prototype keys (no prototype pollution leak)', () => {
      expect(appMinContextLength('toString')).toBeUndefined();
      expect(appMinContextLength('constructor')).toBeUndefined();
      expect(appMinContextLength('__proto__')).toBeUndefined();
      expect(appMinContextLength('hasOwnProperty')).toBeUndefined();
    });
  });
});
