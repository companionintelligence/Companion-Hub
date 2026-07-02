import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelPullOrchestrator } from '@/lib/hooks/use-model-pull-orchestrator';

const { fetchOllamaInstallStatus } = vi.hoisted(() => ({
  fetchOllamaInstallStatus: vi.fn(),
}));

const { fetchTrackedModels, ensurePullStarted } = vi.hoisted(() => ({
  fetchTrackedModels: vi.fn(),
  ensurePullStarted: vi.fn(),
}));

vi.mock('@/lib/inference/inference-api', () => ({
  fetchOllamaInstallStatus,
}));

vi.mock('@/lib/inference/tracked-models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inference/tracked-models')>();
  return {
    ...actual,
    fetchTrackedModels,
    ensurePullStarted,
  };
});

describe('useModelPullOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchOllamaInstallStatus.mockResolvedValue({ ready: true, running: true });
    ensurePullStarted.mockResolvedValue(undefined);
    fetchTrackedModels.mockResolvedValue([{ catalogId: 'phi-4-mini', state: 'pulling', pullProgress: 42 }] as never);
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
      expect(ensurePullStarted).toHaveBeenCalledWith('phi-4-mini', true);
    });
  });

  it('does not start pulls when ollama is not ready', async () => {
    fetchOllamaInstallStatus.mockResolvedValue({ ready: false, running: false });

    renderHook(() =>
      useModelPullOrchestrator({
        selectedModelIds: ['phi-4-mini'],
        installedCatalogIds: [],
        enabled: true,
        bestEffort: true,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(ensurePullStarted).not.toHaveBeenCalled();
  });

  it('reports progress from tracked models', async () => {
    const { result } = renderHook(() =>
      useModelPullOrchestrator({
        selectedModelIds: ['phi-4-mini'],
        installedCatalogIds: [],
        enabled: true,
        bestEffort: true,
      }),
    );

    await waitFor(() => {
      expect(result.current.progressById['phi-4-mini']).toBe(42);
    });
  });
});
