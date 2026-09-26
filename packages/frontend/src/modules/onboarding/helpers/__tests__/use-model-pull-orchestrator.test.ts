import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelPullOrchestrator } from '@/lib/hooks/use-model-pull-orchestrator';

const { fetchOllamaInstallStatus, fetchVllmInstallStatus, fetchOmlxInstallStatus, fetchLemonadeInstallStatus } = vi.hoisted(() => ({
  fetchOllamaInstallStatus: vi.fn(),
  fetchVllmInstallStatus: vi.fn(),
  fetchOmlxInstallStatus: vi.fn(),
  fetchLemonadeInstallStatus: vi.fn(),
}));

const { fetchTrackedModels, ensurePullStarted } = vi.hoisted(() => ({
  fetchTrackedModels: vi.fn(),
  ensurePullStarted: vi.fn(),
}));

vi.mock('@/lib/inference/inference-api', () => ({
  fetchOllamaInstallStatus,
  fetchVllmInstallStatus,
  fetchOmlxInstallStatus,
  fetchLemonadeInstallStatus,
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
    fetchVllmInstallStatus.mockResolvedValue({ ready: false, running: false });
    fetchOmlxInstallStatus.mockResolvedValue({ ready: true, running: true });
    fetchLemonadeInstallStatus.mockResolvedValue({ ready: true, running: true });
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

  // Regression: the hook's readiness gate used to be resolved with Ollama's probe regardless of the
  // selected backend, because the only production caller never passed `inferenceBackend`. That was
  // inert while vLLM was the only alternative (the Hub cannot pull vLLM models at all), but
  // mlx-dspark IS Hub-loadable, so an operator with mlx-dspark up and Ollama down had their model
  // silently never load.
  it('gates readiness on mlx-dspark, not Ollama, when dspark is the selected backend', async () => {
    fetchOllamaInstallStatus.mockResolvedValue({ ready: false, running: false });
    fetchOmlxInstallStatus.mockResolvedValue({ ready: true, running: true });

    renderHook(() =>
      useModelPullOrchestrator({
        selectedModelIds: ['qwen3-8b-dspark'],
        installedCatalogIds: [],
        enabled: true,
        inferenceBackend: 'omlx',
        backendUrl: 'http://192.168.1.50:8080',
      }),
    );

    await waitFor(() => expect(ensurePullStarted).toHaveBeenCalledWith('qwen3-8b-dspark', expect.anything()));
    // The operator's unsaved endpoint must reach the probe — onboarding collects it before
    // install-step persists it, so the Hub default would be the wrong server to ask.
    expect(fetchOmlxInstallStatus).toHaveBeenCalledWith('http://192.168.1.50:8080');
  });

  it('does not start pulls when the selected backend is down, even if Ollama is up', async () => {
    fetchOllamaInstallStatus.mockResolvedValue({ ready: true, running: true });
    fetchOmlxInstallStatus.mockResolvedValue({ ready: false, running: false });

    renderHook(() =>
      useModelPullOrchestrator({
        selectedModelIds: ['qwen3-8b-dspark'],
        installedCatalogIds: [],
        enabled: true,
        inferenceBackend: 'omlx',
      }),
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(ensurePullStarted).not.toHaveBeenCalled();
  });

  it('passes the selected MTPLX endpoint to the readiness probe', async () => {
    fetchOmlxInstallStatus.mockResolvedValue({ ready: true, running: true });

    renderHook(() =>
      useModelPullOrchestrator({
        selectedModelIds: ['qwen3-8b-mtplx'],
        installedCatalogIds: [],
        enabled: true,
        inferenceBackend: 'omlx',
        backendUrl: 'http://192.168.1.50:8001',
      }),
    );

    await waitFor(() => expect(fetchOmlxInstallStatus).toHaveBeenCalledWith('http://192.168.1.50:8001'));
  });
});
