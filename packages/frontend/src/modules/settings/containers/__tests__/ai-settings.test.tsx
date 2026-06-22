import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiSettingsContainer } from '../ai-settings';
import toast from 'react-hot-toast';

const mockApiFetch = vi.fn();

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, onClick, loading: _loading, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('@/components/ui/Card', () => ({
  Card: ({ children }: any) => <div>{children}</div>,
  CardHeader: ({ children }: any) => <div>{children}</div>,
  CardContent: ({ children }: any) => <div>{children}</div>,
  CardTitle: ({ children }: any) => <div>{children}</div>,
  CardDescription: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('@/components/ui/Skeleton/Skeleton', () => ({
  Skeleton: () => <div data-testid="skeleton" />,
}));

vi.mock('@/modules/onboarding/components/ai-setup/system-overview', () => ({
  SystemOverview: ({ onRescan }: { onRescan: () => Promise<void> }) => (
    <div data-testid="hardware-profile-card">
      <button type="button" data-testid="rescan-btn" onClick={() => void onRescan()}>
        Rescan
      </button>
    </div>
  ),
}));

vi.mock('@/modules/onboarding/components/ai-setup/model-selection-card', () => ({
  modelTags: () => [],
  modelMeta: () => null,
  modelScores: () => ({}),
  RecommendedModels: () => <div data-testid="model-selection-card" />,
  OtherModelsSection: () => null,
}));

vi.mock('@/modules/onboarding/components/ai-setup/primitives', () => ({
  ModelCard: ({ title, checkboxTestId, selected, onToggle }: any) => (
    <div data-testid={`model-card-${title}`}>
      <input type="checkbox" data-testid={checkboxTestId} checked={selected} onChange={onToggle} readOnly />
      {title}
    </div>
  ),
}));

vi.mock('@/modules/onboarding/components/ai-setup/icons', () => ({
  ModelIcon: () => null,
}));

vi.mock('@/modules/onboarding/components/ai-setup/backend-selection-card', () => ({
  BackendSelectionCard: ({ selected, onSelect }: any) => (
    <div>
      <div data-testid="selected-backend">{selected}</div>
      <button type="button" data-testid="select-lemonade" onClick={() => onSelect('lemonade')}>
        select lemonade
      </button>
    </div>
  ),
}));

vi.mock('@/modules/onboarding/components/ai-setup/cloud-provider-card', () => ({
  CloudProviderCard: () => <div data-testid="cloud-provider-card" />,
}));

vi.mock('@/modules/onboarding/components/ai-setup/resource-summary-bar', () => ({
  ResourceSummaryBar: () => <div data-testid="resource-summary-bar" />,
}));

const profile = {
  hardware: {
    gpu: { available: true, vendor: 'nvidia', model: 'RTX', vramMb: 8192, unifiedMemory: false, driverVersion: '1', runtimeAvailable: true },
    npu: { available: false, model: '' },
    ram: { totalMb: 16384, availableMb: 12000 },
    cpu: { arch: 'x86_64', cores: 8, model: 'CPU' },
    effectiveInferenceMemoryMb: 8192,
    tier: 'medium',
  },
  tier: 'medium',
  recommendedModels: [{ id: 'm1', backend: 'vllm', displayName: 'Model 1', runtime: { memoryFootprintMb: 1024 }, requirements: { diskMb: 1000 } }],
  availableModels: [{ id: 'm1', backend: 'vllm', displayName: 'Model 1', runtime: { memoryFootprintMb: 1024 }, requirements: { diskMb: 1000 } }],
  memoryBudget: {
    totalVramMb: 8192,
    totalRamMb: 16384,
    systemReservedRamMb: 2048,
    dockerOverheadMb: 0,
    appContainerBudgetMb: 0,
    modelBudgetVramMb: 7000,
    modelBudgetRamMb: 12000,
    modelUsedVramMb: 0,
    modelUsedRamMb: 0,
    pinnedVramMb: 0,
    pinnedRamMb: 0,
  },
  backends: {
    recommended: 'ollama',
    available: [{ type: 'ollama', running: true, healthy: true }],
  },
  resourceEstimate: {
    totalDiskMb: 1000,
    totalMemoryMb: 1024,
    availableMemoryMb: 7000,
  },
};

describe('AiSettingsContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/inference/onboarding-profile') {
        return Promise.resolve({ ok: true, json: async () => profile });
      }
      if (url === '/api/inference/preferences') {
        return Promise.resolve({ ok: true, json: async () => ({ preferredBackend: 'vllm' }) });
      }
      if (url === '/api/inference/models/tracked') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes('/api/inference/models/runtime?backend=')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            backend: 'vllm',
            discoveryUnavailable: false,
            models: [{ id: 'llama3.2:latest', name: 'llama3.2:latest', state: 'loaded' }],
          }),
        });
      }
      if (url === '/api/inference/cloud-providers') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
  });

  it('loads preferred backend from preferences endpoint', async () => {
    render(<AiSettingsContainer />);

    await waitFor(() => {
      expect(screen.getByTestId('selected-backend')).toHaveTextContent('vllm');
    });

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/inference/models/runtime?backend=vllm', expect.any(Object));
    });
  });

  it('persists backend changes on save', async () => {
    const user = userEvent.setup();
    render(<AiSettingsContainer />);

    await waitFor(() => {
      expect(screen.getByTestId('selected-backend')).toHaveTextContent('vllm');
    });

    await user.click(screen.getByTestId('select-lemonade'));
    await user.click(screen.getByTestId('ai-settings-save-btn'));
    // Saving now goes through a confirmation modal before patching preferences.
    await user.click(screen.getByTestId('ai-settings-confirm-btn'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/inference/preferences',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ backend: 'lemonade', model: null, embeddingModel: null, visionModel: null }),
        }),
      );
    });
  });

  it('keeps runtime models read-only', async () => {
    render(<AiSettingsContainer />);

    await waitFor(() => {
      expect(screen.getByText('Recommended Models')).toBeInTheDocument();
    });

    expect(screen.getByTestId('recommended-model-checkbox-m1')).toBeInTheDocument();
    expect(screen.queryByTestId('runtime-model-checkbox-llama3.2:latest')).not.toBeInTheDocument();
    expect(screen.getByText('Models currently active in the inference backend.')).toBeInTheDocument();
  });

  it('keeps curated model selection independent of runtime model discovery', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/inference/onboarding-profile') {
        return Promise.resolve({ ok: true, json: async () => profile });
      }
      if (url === '/api/inference/preferences') {
        return Promise.resolve({ ok: true, json: async () => ({ preferredBackend: 'vllm' }) });
      }
      if (url === '/api/inference/models/tracked') {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { catalogId: 'm1', backend: 'ollama', backendModelId: 'qwen3:8b', state: 'pinned', pinned: true, memoryUsedMb: 1024, requestCount: 0 },
          ],
        });
      }
      if (url.includes('/api/inference/models/runtime?backend=')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            backend: 'vllm',
            discoveryUnavailable: false,
            models: [{ id: 'llama3.2:latest', name: 'llama3.2:latest', state: 'loaded' }],
          }),
        });
      }
      if (url === '/api/inference/cloud-providers') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AiSettingsContainer />);

    await waitFor(() => {
      expect(screen.getByTestId('recommended-model-checkbox-m1')).toBeChecked();
    });
  });

  it('shows tracked download progress for recommended models', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/inference/onboarding-profile') {
        return Promise.resolve({ ok: true, json: async () => profile });
      }
      if (url === '/api/inference/preferences') {
        return Promise.resolve({ ok: true, json: async () => ({ preferredBackend: 'vllm' }) });
      }
      if (url === '/api/inference/models/tracked') {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              catalogId: 'm1',
              backend: 'ollama',
              backendModelId: 'qwen3:8b',
              state: 'pulling',
              pinned: false,
              pullProgress: 42,
              memoryUsedMb: 1024,
              requestCount: 0,
            },
          ],
        });
      }
      if (url.includes('/api/inference/models/runtime?backend=')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            backend: 'vllm',
            discoveryUnavailable: false,
            models: [{ id: 'llama3.2:latest', name: 'llama3.2:latest', state: 'loaded' }],
          }),
        });
      }
      if (url === '/api/inference/cloud-providers') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AiSettingsContainer />);

    await waitFor(() => {
      expect(screen.getByText('Downloading 42%')).toBeInTheDocument();
    });
  });

  it('only pulls models compatible with the selected backend', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/inference/onboarding-profile') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ...profile,
            recommendedModels: [
              { id: 'm1', backend: 'vllm', displayName: 'Model 1', runtime: { memoryFootprintMb: 1024 }, requirements: { diskMb: 1000 } },
              {
                id: 'whisper-base',
                backend: 'lemonade',
                displayName: 'Whisper Base',
                runtime: { memoryFootprintMb: 512 },
                requirements: { diskMb: 500 },
              },
            ],
            availableModels: [
              { id: 'm1', backend: 'vllm', displayName: 'Model 1', runtime: { memoryFootprintMb: 1024 }, requirements: { diskMb: 1000 } },
              {
                id: 'whisper-base',
                backend: 'lemonade',
                displayName: 'Whisper Base',
                runtime: { memoryFootprintMb: 512 },
                requirements: { diskMb: 500 },
              },
            ],
          }),
        });
      }
      if (url === '/api/inference/preferences') {
        return Promise.resolve({ ok: true, json: async () => ({ preferredBackend: 'vllm' }) });
      }
      if (url === '/api/inference/models/tracked') {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { catalogId: 'm1', backend: 'vllm', backendModelId: 'model-1', state: 'pinned', pinned: true, memoryUsedMb: 1024, requestCount: 0 },
            {
              catalogId: 'whisper-base',
              backend: 'lemonade',
              backendModelId: 'whisper-base',
              state: 'pinned',
              pinned: true,
              memoryUsedMb: 512,
              requestCount: 0,
            },
          ],
        });
      }
      if (url.includes('/api/inference/models/runtime?backend=')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ backend: 'vllm', discoveryUnavailable: false, models: [] }),
        });
      }
      if (url === '/api/inference/cloud-providers') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const user = userEvent.setup();
    render(<AiSettingsContainer />);

    await waitFor(() => {
      expect(screen.getByTestId('recommended-model-checkbox-m1')).toBeChecked();
    });

    await user.click(screen.getByTestId('ai-settings-save-btn'));
    await user.click(screen.getByTestId('ai-settings-confirm-btn'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/inference/preferences', expect.objectContaining({ method: 'PATCH' }));
    });

    expect(mockApiFetch).not.toHaveBeenCalledWith(
      '/api/inference/models/pull',
      expect.objectContaining({ body: JSON.stringify({ modelId: 'whisper-base' }) }),
    );
  });

  it('shows rescan error toast and skips profile refresh when rescan returns non-OK', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/inference/onboarding-profile') {
        return Promise.resolve({ ok: true, json: async () => profile });
      }
      if (url === '/api/inference/preferences') {
        return Promise.resolve({ ok: true, json: async () => ({ preferredBackend: 'vllm' }) });
      }
      if (url === '/api/inference/models/tracked') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes('/api/inference/models/runtime?backend=')) {
        return Promise.resolve({ ok: true, json: async () => ({ backend: 'vllm', discoveryUnavailable: false, models: [] }) });
      }
      if (url === '/api/inference/cloud-providers') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/api/inference/hardware/rescan') {
        return Promise.resolve({ ok: false, status: 503 });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const user = userEvent.setup();
    render(<AiSettingsContainer />);

    await waitFor(() => {
      expect(screen.getByTestId('hardware-profile-card')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('rescan-btn'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Rescan failed: HTTP 503');
    });

    const profileCalls = mockApiFetch.mock.calls.filter(([url]) => url === '/api/inference/onboarding-profile');
    expect(profileCalls).toHaveLength(1);
  });
});
