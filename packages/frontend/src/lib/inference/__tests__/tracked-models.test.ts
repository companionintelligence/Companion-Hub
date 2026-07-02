import { describe, expect, it, vi } from 'vitest';
import { parsePullProgress } from '@/lib/inference/tracked-models';
import type { TrackedModel } from '@ci-hub/common/types';

const mockStartInferenceModelPull = vi.fn();
vi.mock('@/lib/inference/inference-api', () => ({
  startInferenceModelPull: (...args: unknown[]) => mockStartInferenceModelPull(...args),
  fetchInferenceTrackedModels: vi.fn().mockResolvedValue([]),
}));

describe('parsePullProgress', () => {
  it('marks installed models complete without requiring tracked entries', () => {
    const result = parsePullProgress(['phi-4-mini'], ['phi-4-mini'], []);
    expect(result.allDone).toBe(true);
    expect(result.progressById['phi-4-mini']).toBe(100);
  });

  it('reports pulling progress and incomplete state', () => {
    const tracked = [{ catalogId: 'llama3-3-70b', state: 'pulling', pullProgress: 42 }] as TrackedModel[];
    const result = parsePullProgress(['llama3-3-70b'], [], tracked);
    expect(result.allDone).toBe(false);
    expect(result.progressById['llama3-3-70b']).toBe(42);
  });

  it('treats errors as terminal for wait completion', () => {
    const tracked = [{ catalogId: 'bad-model', state: 'error', errorMessage: 'failed' }] as TrackedModel[];
    const result = parsePullProgress(['bad-model'], [], tracked);
    expect(result.allDone).toBe(true);
    expect(result.errorsById['bad-model']).toBe('failed');
  });
});

describe('ensurePullStarted', () => {
  it('starts model pull via inference API', async () => {
    vi.resetModules();
    mockStartInferenceModelPull.mockResolvedValue(undefined);
    const { ensurePullStarted } = await import('@/lib/inference/tracked-models');
    await ensurePullStarted('phi-4-mini', true);

    expect(mockStartInferenceModelPull).toHaveBeenCalledWith('phi-4-mini', true);
  });
});
