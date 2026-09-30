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

  it("returns the Hub's reason for a refused pull", async () => {
    vi.resetModules();
    mockStartInferenceModelPull.mockResolvedValue({
      status: 'error',
      reason: 'lemonade on this node does not list Qwen3.8-27B-GGUF in its model registry, so it cannot download it.',
    });
    const { ensurePullStarted } = await import('@/lib/inference/tracked-models');

    await expect(ensurePullStarted('qwen3-8-27b-lemonade', false)).resolves.toMatch(/does not list Qwen3\.8-27B-GGUF/);
  });
});

describe('ensurePullsStarted', () => {
  // The refusal toast used to read "Failed to pull X: [object Object]" for an HTTP error.
  it('reports the reason from an HTTP error body, not [object Object]', async () => {
    vi.resetModules();
    const { unwrapSdk } = await import('@/lib/sdk-unwrap');
    mockStartInferenceModelPull.mockImplementation(() =>
      unwrapSdk(Promise.resolve({ error: { statusCode: 409, message: 'Model requires 20480 MB disk but only 1024 MB is available.' } })),
    );
    const { ensurePullsStarted } = await import('@/lib/inference/tracked-models');

    await expect(ensurePullsStarted(['gemma4-31b'])).resolves.toEqual({
      'gemma4-31b': 'Model requires 20480 MB disk but only 1024 MB is available.',
    });
  });

  it('translates an i18n key the response interceptor made of an HTTP error', async () => {
    vi.resetModules();
    const { TranslatableError } = await import('@/types/error.types');
    mockStartInferenceModelPull.mockRejectedValue(
      new TranslatableError('INTERNAL_SERVER_ERROR', {}, { status: 500, url: '/api/inference/models/pull/start' }),
    );
    const { ensurePullsStarted } = await import('@/lib/inference/tracked-models');

    await expect(ensurePullsStarted(['gemma4-31b'])).resolves.toEqual({ 'gemma4-31b': 'Internal server error' });
  });
});
