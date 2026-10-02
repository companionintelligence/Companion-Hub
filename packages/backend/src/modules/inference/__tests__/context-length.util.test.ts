import { describe, expect, it } from 'vitest';
import {
  appMinContextLength,
  estimateLoadedFootprintMb,
  LADDER_KV_MB_PER_TOKEN,
  largestFittingWindow,
  recommendContextLength,
  VISION_ENCODER_RESERVE_MB,
} from '../context-length.util';

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

describe('estimateLoadedFootprintMb', () => {
  it('charges the ladder its own per-token assumption, so every rung it picks fits by its own arithmetic', () => {
    // The ladder hands 8192 tokens to 2048 MB of free memory, 16384 to 4096, and so on.
    expect(LADDER_KV_MB_PER_TOKEN * 8192).toBe(2048);
    const footprint = 18_000;
    const numCtx = recommendContextLength({ effectiveInferenceMemoryMb: 24_576, modelFootprintMb: footprint, modelContextWindow: 262_144 });
    expect(numCtx).toBe(16_384);
    expect(estimateLoadedFootprintMb({ modelFootprintMb: footprint, numCtx })).toBeLessThanOrEqual(24_576);
  });

  it('charges the measured path the base, KV cache and margin recommendContextLength sized against', () => {
    const input = { modelFootprintMb: 18_000, kvMbPerToken: 0.0625, weightMb: 16_000 };
    const numCtx = recommendContextLength({ effectiveInferenceMemoryMb: 24_576, modelContextWindow: 262_144, ...input });
    expect(numCtx).toBe(65_536);
    expect(estimateLoadedFootprintMb({ ...input, numCtx })).toBe(18_000 + 4_096 + 1_024);
  });

  it('takes the measured weights plus runner overhead when they exceed the catalog figure', () => {
    expect(estimateLoadedFootprintMb({ modelFootprintMb: 10_000, kvMbPerToken: 0.125, weightMb: 16_000, numCtx: 8192 })).toBe(
      16_000 + 768 + 1_024 + 1_024,
    );
  });
});

describe('the vision encoder reserve', () => {
  const card = 24_560;
  const qwen = { modelFootprintMb: 19_374, weightMb: 17_630, kvMbPerToken: 0.0667, modelContextWindow: 262_144 };

  it('is charged before any context on the measured path', () => {
    // 24,560 - 19,374 - 1,024 margin = 4,162 MB → 64k (4,371 MB) does not fit, 32k does; the reserve
    // leaves 3,138 MB, still 32k. A larger reserve would have to push it down a rung.
    expect(recommendContextLength({ effectiveInferenceMemoryMb: card, ...qwen })).toBe(32_768);
    expect(recommendContextLength({ effectiveInferenceMemoryMb: card, ...qwen, visionReserveMb: VISION_ENCODER_RESERVE_MB })).toBe(32_768);
    expect(recommendContextLength({ effectiveInferenceMemoryMb: card, ...qwen, visionReserveMb: 2_000 })).toBe(16_384);
  });

  it('is charged before any context on the ladder too', () => {
    // 28,000 - 19,374 = 8,626 MB → the 32k rung; the reserve leaves 7,602 → 16k.
    const ladder = { effectiveInferenceMemoryMb: 28_000, modelFootprintMb: 19_374, modelContextWindow: 262_144 };
    expect(recommendContextLength(ladder)).toBe(32_768);
    expect(recommendContextLength({ ...ladder, visionReserveMb: VISION_ENCODER_RESERVE_MB })).toBe(16_384);
  });

  it('is part of what a load is fit-checked against', () => {
    expect(estimateLoadedFootprintMb({ ...qwen, numCtx: 32_768, visionReserveMb: VISION_ENCODER_RESERVE_MB })).toBe(
      Math.ceil(19_374 + 32_768 * 0.0667 + 1_024 + VISION_ENCODER_RESERVE_MB),
    );
    expect(estimateLoadedFootprintMb({ modelFootprintMb: 19_374, numCtx: 16_384, visionReserveMb: VISION_ENCODER_RESERVE_MB })).toBe(
      19_374 + 16_384 * LADDER_KV_MB_PER_TOKEN + VISION_ENCODER_RESERVE_MB,
    );
  });

  it('ignores a reserve that is not a positive number', () => {
    for (const visionReserveMb of [0, -500, Number.NaN]) {
      expect(recommendContextLength({ effectiveInferenceMemoryMb: card, ...qwen, visionReserveMb })).toBe(32_768);
    }
  });
});

/**
 * Fleet numbers, 2026-09-29. beta-1: RX 7900 XTX, 24,560 MB, of which the fit check lets a model use
 * 24,048 (the 512 MB display reserve off). qwen3.8:27b: catalog footprint 20,275 MB and 0.0625 MB per
 * token (smaller than its geometry's 0.0664), 17,741,872,154 bytes on disk, takes images.
 */
const QWEN_27B_BETA_1 = { modelFootprintMb: 20_275, weightMb: 16_920, kvMbPerToken: 0.0625, visionReserveMb: VISION_ENCODER_RESERVE_MB };

describe('largestFittingWindow (the step-down before a load refuses or evicts)', () => {
  it('finds the window a 27B fits at on an empty beta-1, where the window sized to the whole card did not fit', () => {
    // Sized against the whole card the recommendation was 32768, charged 24,371 MB: refused at 24,048.
    expect(recommendContextLength({ effectiveInferenceMemoryMb: 24_560, modelContextWindow: 256_000, ...QWEN_27B_BETA_1 })).toBe(32_768);
    expect(estimateLoadedFootprintMb({ ...QWEN_27B_BETA_1, numCtx: 32_768 })).toBe(24_371);
    // One rung down fits, and it is what both the step-down and a recommendation against the budget pick.
    expect(estimateLoadedFootprintMb({ ...QWEN_27B_BETA_1, numCtx: 16_384 })).toBe(23_347);
    expect(largestFittingWindow({ ...QWEN_27B_BETA_1, from: 65_536, budgetMb: 24_048 })).toBe(16_384);
    expect(recommendContextLength({ effectiveInferenceMemoryMb: 24_048, modelContextWindow: 256_000, ...QWEN_27B_BETA_1 })).toBe(16_384);
  });

  it("tries a floor that is not a power of two first, then halves — Hermes' 64000 on a Lemonade model", () => {
    // gemma4-e4b-lemonade: 6,724 MB, no measured KV cost (the ladder's 0.25 MB/token), takes images.
    const gemma = { modelFootprintMb: 6_724, visionReserveMb: VISION_ENCODER_RESERVE_MB };
    expect(largestFittingWindow({ ...gemma, from: 64_000, budgetMb: 24_048 })).toBe(64_000);
    // A 12 GB card: 64000, 32768 and 16384 (11,844 MB) are over 11,776; 8192 fits.
    expect(largestFittingWindow({ ...gemma, from: 64_000, budgetMb: 11_776 })).toBe(8_192);
  });

  it('answers null when not even 4096 fits, and never offers a window above where it started', () => {
    expect(largestFittingWindow({ ...QWEN_27B_BETA_1, from: 65_536, budgetMb: 9_728 })).toBeNull();
    expect(largestFittingWindow({ modelFootprintMb: 0, from: 8_192, budgetMb: 1_000_000 })).toBe(8_192);
    expect(largestFittingWindow({ modelFootprintMb: 0, from: 2_048, budgetMb: 1_000_000 })).toBe(2_048);
    expect(largestFittingWindow({ modelFootprintMb: 0, from: Number.NaN, budgetMb: 1_000_000 })).toBeNull();
  });
});

describe("the KV cache of every slot (Ollama's OLLAMA_NUM_PARALLEL)", () => {
  // gemma4:e4b's geometry: 24 layers that own a KV cache × 2 heads × 1024 × 2 B = 0.09375 MB per token.
  const gemma = { modelFootprintMb: 10_813, weightMb: 9_163, kvMbPerToken: 0.09375, visionReserveMb: VISION_ENCODER_RESERVE_MB };

  it('charges the window once per slot', () => {
    expect(estimateLoadedFootprintMb({ ...gemma, numCtx: 16_384 })).toBe(10_813 + 1_536 + 1_024 + 1_024);
    expect(estimateLoadedFootprintMb({ ...gemma, numCtx: 16_384, kvSlots: 4 })).toBe(10_813 + 6_144 + 1_024 + 1_024);
  });

  it('sizes the ladder per slot too', () => {
    const ladder = { effectiveInferenceMemoryMb: 24_576, modelFootprintMb: 0, modelContextWindow: 262_144 };
    expect(recommendContextLength(ladder)).toBe(65_536);
    // 24,576 MB over four slots is 6,144 each: the 16k rung.
    expect(recommendContextLength({ ...ladder, kvSlots: 4 })).toBe(16_384);
  });

  it('treats a slot count that is not a positive integer as one', () => {
    for (const kvSlots of [0, -2, 2.5, Number.NaN, null]) {
      expect(estimateLoadedFootprintMb({ ...gemma, numCtx: 16_384, kvSlots })).toBe(estimateLoadedFootprintMb({ ...gemma, numCtx: 16_384 }));
    }
  });
});

describe('a sighting of the model on this node', () => {
  // beta-red, RTX 3080 (10,240 MB, 9,728 for models), 2026-09-29: gemma4:e4b at a 16384 window on four
  // slots, 5,550 MiB by nvidia-smi (3,209 by /api/ps), where the catalog says 10,813 and the file 9,163.
  const gemma = { modelFootprintMb: 10_813, weightMb: 9_163, kvMbPerToken: 0.09375, kvSlots: 4, visionReserveMb: VISION_ENCODER_RESERVE_MB };
  const seen = { footprintMb: 5_550, contextLength: 16_384, source: 'process' as const };

  it('replaces the catalog base, so the model fits the 10 GB card it is running on', () => {
    expect(estimateLoadedFootprintMb({ ...gemma, numCtx: 16_384 })).toBe(19_005);
    expect(estimateLoadedFootprintMb({ ...gemma, numCtx: 16_384, sighting: seen })).toBe(5_550 + 1_024);
    expect(recommendContextLength({ effectiveInferenceMemoryMb: 9_728, modelContextWindow: 128_000, ...gemma })).toBe(4_096);
    expect(recommendContextLength({ effectiveInferenceMemoryMb: 9_728, modelContextWindow: 128_000, ...gemma, sighting: seen })).toBe(16_384);
  });

  it('adds the KV cache above the sighted window', () => {
    expect(estimateLoadedFootprintMb({ ...gemma, numCtx: 32_768, sighting: seen })).toBe(5_550 + 16_384 * 0.375 + 1_024);
  });

  it('takes the KV cache off below the sighted window, but never more than half of what was seen', () => {
    // 12,288 tokens at 0.375 MB across four slots would be 4,608 MB off a 5,550 MB sighting. The per-token
    // cost is an over-estimate for gemma4's sliding-window layers, so the charge stops at half.
    expect(estimateLoadedFootprintMb({ ...gemma, numCtx: 4_096, sighting: seen })).toBe(5_550 / 2 + 1_024);
    expect(estimateLoadedFootprintMb({ ...gemma, numCtx: 12_288, sighting: seen })).toBe(5_550 - 4_096 * 0.375 + 1_024);
  });

  it("keeps the safety margin over the engine's own figure, which leaves out the runtime's buffers", () => {
    const engine = { footprintMb: 3_209, contextLength: 16_384, source: 'engine' as const };
    expect(estimateLoadedFootprintMb({ ...gemma, numCtx: 16_384, sighting: engine })).toBe(3_209 + 1_024 + 1_024);
  });

  it('ignores a sighting with no size or window', () => {
    for (const sighting of [
      { ...seen, footprintMb: 0 },
      { ...seen, contextLength: 0 },
      { ...seen, footprintMb: Number.NaN },
    ]) {
      expect(estimateLoadedFootprintMb({ ...gemma, numCtx: 16_384, sighting })).toBe(19_005);
    }
  });
});

describe('a sighting taken at a larger window than the one being sized (fleet retest 2026-10-01)', () => {
  // beta-3-glass, RTX 3070 (7,680 MB for models): qwen3.5:9b measured 6,836 MB at 16384 and 4,872 MB at 4096,
  // so 0.16 MB a token. The engine's own figure, so the 1,024 MB margin goes on top.
  const nine = { modelFootprintMb: 6_600, kvMbPerToken: 0.16, kvSlots: 1 };
  const nineAt16k = { footprintMb: 6_836, contextLength: 16_384, source: 'engine' as const };
  const glassCeilingMb = 7_168;

  it('charges a smaller window less than the sighted one, close to what the engine then held', () => {
    expect(estimateLoadedFootprintMb({ ...nine, numCtx: 16_384, sighting: nineAt16k })).toBe(6_836 + 1_024);
    const at4k = estimateLoadedFootprintMb({ ...nine, numCtx: 4_096, sighting: nineAt16k });
    expect(at4k).toBe(Math.ceil(6_836 - 12_288 * 0.16 + 1_024));
    expect(at4k - 1_024).toBeGreaterThanOrEqual(4_872 - 8);
    expect(at4k - 1_024).toBeLessThanOrEqual(4_872 + 8);
  });

  it('lets the step-down reach a window that fits where the sighted one does not', () => {
    // 7,860 MB at 16384 against 7,168: it was the same 7,860 at every smaller window, so null.
    expect(largestFittingWindow({ ...nine, sighting: nineAt16k, from: 16_384, budgetMb: glassCeilingMb })).toBe(8_192);
    expect(largestFittingWindow({ ...nine, sighting: nineAt16k, from: 16_384, budgetMb: 6_000 })).toBe(4_096);
  });

  it('still refuses what even the smallest window cannot hold', () => {
    expect(largestFittingWindow({ ...nine, sighting: nineAt16k, from: 16_384, budgetMb: 5_000 })).toBeNull();
  });

  describe('qwen3.8:27b sighted at 65536 on a single 24 GB card', () => {
    // beta-1 on one RX 7900 XTX (24,048 MB for models): 29,115 MB at 65536 by rocm-smi, 18,949 at 16384, and the
    // engine served it at 16384. The file is 16,920 MiB. The geometry says 0.066 MB a token, the retest's
    // estimate 0.103; between its two sightings the engine held 0.207.
    const seenAt64k = { footprintMb: 29_115, contextLength: 65_536, source: 'process' as const };
    const big = { modelFootprintMb: 20_275, kvSlots: 1, visionReserveMb: VISION_ENCODER_RESERVE_MB, sighting: seenAt64k };
    const budgetMb = 24_048;

    it('keeps the weights and scales the rest by window, whatever per-token cost the Hub computed', () => {
      for (const kvMbPerToken of [0.066, 0.103, 0.121, 0.207]) {
        const input = { ...big, weightMb: 16_920, kvMbPerToken };
        expect(estimateLoadedFootprintMb({ ...input, numCtx: 65_536 })).toBe(29_115 + 1_024);
        // 16,920 + 768 kept, then 11,427 MB of the sighting over 65536 tokens: 20,545 MB at 16384, 23,402 at 32768.
        expect(estimateLoadedFootprintMb({ ...input, numCtx: 16_384 })).toBe(Math.ceil(17_688 + (11_427 * 16_384) / 65_536 + 1_024));
        expect(largestFittingWindow({ ...input, from: 65_536, budgetMb })).toBe(16_384);
      }
    });

    it('is charged above what the engine held at that window, so it is still safe to plan with', () => {
      expect(estimateLoadedFootprintMb({ ...big, weightMb: 16_920, kvMbPerToken: 0.066, numCtx: 16_384 })).toBeGreaterThan(18_949 + 1_024);
    });

    it('cannot step down on the per-token cost alone: without the weights the geometry still refuses it', () => {
      // 26,895 MB at 16384 by the geometry's 0.066 and 25,077 by the retest's 0.103 (which reaches only 4096): the cost
      // is the KV cache and the engine held three times that. The weights are what lets the sighting say how much scales.
      expect(largestFittingWindow({ ...big, kvMbPerToken: 0.066, from: 65_536, budgetMb })).toBeNull();
      expect(largestFittingWindow({ ...big, kvMbPerToken: 0.103, from: 65_536, budgetMb })).toBe(4_096);
      expect(largestFittingWindow({ ...big, kvMbPerToken: 0.207, from: 65_536, budgetMb })).toBe(32_768);
    });

    it('ignores a file larger than what the sighting held, which says nothing about the split', () => {
      const input = { ...big, weightMb: 30_000, kvMbPerToken: 0.207 };
      expect(estimateLoadedFootprintMb({ ...input, numCtx: 16_384 })).toBe(Math.ceil(29_115 - 49_152 * 0.207 + 1_024));
    });
  });

  it('keeps qwen3.5:9b on the per-token cost, because its 6,289 MiB file is more than the 4,872 MB the engine held at 4096', () => {
    // The glass retest's weights (api/tags) put a floor of 7,057 MB under a footprint measured at 6,836: not usable.
    const input = { ...nine, weightMb: 6_289, sighting: nineAt16k };
    expect(estimateLoadedFootprintMb({ ...input, numCtx: 4_096 })).toBe(Math.ceil(6_836 - 12_288 * 0.16 + 1_024));
    expect(largestFittingWindow({ ...input, from: 16_384, budgetMb: glassCeilingMb })).toBe(8_192);
  });

  it('sizes the recommendation from the sighting, so the handout and the load agree', () => {
    expect(recommendContextLength({ effectiveInferenceMemoryMb: glassCeilingMb, modelContextWindow: 262_144, ...nine, sighting: nineAt16k })).toBe(
      8_192,
    );
  });

  it('leaves a window above the sighting, and the sighting itself, as they were', () => {
    expect(estimateLoadedFootprintMb({ ...nine, numCtx: 32_768, sighting: nineAt16k })).toBe(Math.ceil(6_836 + 16_384 * 0.16 + 1_024));
  });
});
