import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelPullOrchestrator } from '../use-model-pull-orchestrator';

const mockApiFetch = vi.fn();

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

describe('useModelPullOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/inference/ollama/status') {
        return { ok: true, json: async () => ({ ready: true, running: true }) };
      }
      if (url === '/api/inference/models/pull/start') {
        return { ok: true, json: async () => ({ status: 'queued' }) };
      }
      if (url === '/api/inference/models/tracked') {
        return {
          ok: true,
          json: async () => [{ catalogId: 'phi-4-mini', state: 'pulling', pullProgress: 42 }],
        };
      }
      return { ok: true, json: async () => ({}) };
    });
  });

  it('starts pulls when selection changes and ollama is ready', async () => {
    const { rerender } = renderHook((props) => useModelPullOrchestrator(props), {
      initialProps: {
        selectedModelIds: [] as string[],
        installedCatalogIds: [] as string[],
        enabled: true,
        bestEffort: true,
      },
    });

    rerender({
      selectedModelIds: ['phi-4-mini'],
      installedCatalogIds: [],
      enabled: true,
      bestEffort: true,
    });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/inference/models/pull/start',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ modelId: 'phi-4-mini', bestEffort: true }),
        }),
      );
    });
  });

  it('polls tracked models and exposes progress', async () => {
    const { result } = renderHook(() =>
      useModelPullOrchestrator({
        selectedModelIds: ['phi-4-mini'],
        installedCatalogIds: [],
        enabled: true,
      }),
    );

    await waitFor(() => {
      expect(result.current.progressById['phi-4-mini']).toBe(42);
    });
    expect(result.current.isPulling).toBe(true);
    expect(result.current.activeCount).toBe(1);
  });

  it('does not start pulls when disabled', async () => {
    renderHook(() =>
      useModelPullOrchestrator({
        selectedModelIds: ['phi-4-mini'],
        installedCatalogIds: [],
        enabled: false,
      }),
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/inference/models/pull/start', expect.anything());
  });
});
