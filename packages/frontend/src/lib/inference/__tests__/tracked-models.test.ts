import { describe, expect, it, vi } from 'vitest';
import { parsePullProgress } from '@/lib/inference/tracked-models';
import type { TrackedModel } from '@ci-hub/common/types';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
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
  it('posts to pull/start', async () => {
    vi.resetModules();
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ status: 'queued' }) });
    const { ensurePullStarted } = await import('@/lib/inference/tracked-models');
    await ensurePullStarted('phi-4-mini', true);

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/inference/models/pull/start',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ modelId: 'phi-4-mini', bestEffort: true }),
      }),
    );
  });
});
