import { describe, expect, it } from 'vitest';
import { recommendContextLength } from '../context-length.util';

describe('recommendContextLength', () => {
  it('scales the context window up with available memory', () => {
    const big = recommendContextLength({ effectiveInferenceMemoryMb: 65536, modelFootprintMb: 0, modelContextWindow: 262144 });
    const small = recommendContextLength({ effectiveInferenceMemoryMb: 7000, modelFootprintMb: 0, modelContextWindow: 262144 });
    expect(big).toBe(65536);
    expect(small).toBeLessThan(big);
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
});
