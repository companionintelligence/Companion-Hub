import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AiSettingsContainer } from '../ai-settings';
import toast from 'react-hot-toast';

const {
  fetchInferenceOnboardingProfile,
  fetchInferencePreferences,
  fetchInferenceTrackedModels,
  fetchInferenceRuntimeModels,
  fetchConfiguredCloudProviders,
  fetchOllamaInstallStatus,
  fetchVllmInstallStatus,
  saveInferencePreferences,
  rescanInferenceHardware,
  pinInferenceModel,
  saveCloudProviderConfig,
  ensurePullsStarted,
} = vi.hoisted(() => ({
  fetchInferenceOnboardingProfile: vi.fn(),
  fetchInferencePreferences: vi.fn(),
  fetchInferenceTrackedModels: vi.fn(),
  fetchInferenceRuntimeModels: vi.fn(),
  fetchConfiguredCloudProviders: vi.fn(),
  fetchOllamaInstallStatus: vi.fn(),
  fetchVllmInstallStatus: vi.fn(),
  saveInferencePreferences: vi.fn(),
  rescanInferenceHardware: vi.fn(),
  pinInferenceModel: vi.fn(),
  saveCloudProviderConfig: vi.fn(),
  ensurePullsStarted: vi.fn(),
}));

vi.mock('@/lib/inference/inference-api', () => ({
  fetchInferenceOnboardingProfile,
  fetchInferencePreferences,
  fetchInferenceTrackedModels,
  fetchInferenceRuntimeModels,
  fetchConfiguredCloudProviders,
  fetchOllamaInstallStatus,
  fetchVllmInstallStatus,
  saveInferencePreferences,
  rescanInferenceHardware,
  pinInferenceModel,
  saveCloudProviderConfig,
}));

vi.mock('@/lib/inference/tracked-models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inference/tracked-models')>();
  return {
    ...actual,
    ensurePullsStarted,
    waitForModelPulls: vi.fn().mockResolvedValue({ errorsById: {}, pulledIds: new Set(), progressById: {}, allDone: true }),
  };
});

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

// `m1` as an LLM the agent can actually default to, plus a second installed model. `modality` is
// what `isAgentModel` keys off, so without it every role resolves to null regardless of selection.
const llm = (id: string) => ({
  id,
  backend: 'vllm',
  modality: 'llm',
  displayName: `Model ${id}`,
  runtime: { memoryFootprintMb: 1024 },
  requirements: { diskMb: 1000 },
});

/** A profile where the backend reports models installed — what the Hub is actually serving. */
const profileWithInstalled = (installedCatalogIds: string[], models = [llm('m1')]) =>
  ({
    ...profile,
    recommendedModels: models,
    availableModels: models,
    installedCatalogIds,
  }) as never;

function renderAiSettings(initialEntry = '/settings?tab=ai') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AiSettingsContainer />
    </MemoryRouter>,
  );
}

describe('AiSettingsContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchInferenceOnboardingProfile.mockResolvedValue(profile);
    fetchInferencePreferences.mockResolvedValue({ preferredBackend: 'vllm' });
    fetchInferenceTrackedModels.mockResolvedValue([]);
    fetchInferenceRuntimeModels.mockResolvedValue({
      backend: 'vllm',
      discoveryUnavailable: false,
      models: [{ id: 'llama3.2:latest', name: 'llama3.2:latest', state: 'loaded' }],
    });
    fetchConfiguredCloudProviders.mockResolvedValue([]);
    fetchOllamaInstallStatus.mockResolvedValue({ ready: true, running: true, endpointUrl: 'http://localhost:11434' });
    fetchVllmInstallStatus.mockResolvedValue({ ready: true, running: true, endpointUrl: 'http://localhost:8000' });
    saveInferencePreferences.mockResolvedValue(undefined);
    rescanInferenceHardware.mockResolvedValue(undefined);
    ensurePullsStarted.mockResolvedValue(undefined);
  });

  it('loads preferred backend from preferences endpoint', async () => {
    renderAiSettings();

    await waitFor(() => {
      expect(screen.getByTestId('selected-backend')).toHaveTextContent('vllm');
    });

    await waitFor(() => {
      expect(fetchInferenceRuntimeModels).toHaveBeenCalledWith('vllm');
    });
  });

  it('asks the profile endpoint for the stored backend rather than the hardware recommendation', async () => {
    // Asked about no backend, the endpoint answers for whatever it recommends — so
    // `installedCatalogIds` would describe a backend this panel is not showing.
    renderAiSettings();

    await waitFor(() => expect(screen.getByTestId('selected-backend')).toHaveTextContent('vllm'));
    expect(fetchInferenceOnboardingProfile).toHaveBeenCalledWith('vllm');
  });

  it('persists backend changes on save', async () => {
    const user = userEvent.setup();
    renderAiSettings();

    await waitFor(() => {
      expect(screen.getByTestId('selected-backend')).toHaveTextContent('vllm');
    });

    await user.click(screen.getByTestId('select-lemonade'));
    await user.click(screen.getByTestId('ai-settings-save-btn'));
    // Saving now goes through a confirmation modal before patching preferences.
    await user.click(screen.getByTestId('ai-settings-confirm-btn'));

    await waitFor(() => {
      expect(saveInferencePreferences).toHaveBeenCalledWith({
        backend: 'lemonade',
        model: null,
        embeddingModel: null,
        visionModel: null,
        vllmApiKey: null,
      });
    });
  });

  it('keeps runtime models read-only', async () => {
    renderAiSettings();

    await waitFor(() => {
      expect(screen.getByText('Recommended Models')).toBeInTheDocument();
    });

    expect(screen.getByTestId('recommended-model-checkbox-m1')).toBeInTheDocument();
    expect(screen.queryByTestId('runtime-model-checkbox-llama3.2:latest')).not.toBeInTheDocument();
    expect(screen.getByText('Models currently active in the inference backend.')).toBeInTheDocument();
  });

  it('keeps curated model selection independent of runtime model discovery', async () => {
    fetchInferenceTrackedModels.mockResolvedValue([
      { catalogId: 'm1', backend: 'ollama', backendModelId: 'qwen3:8b', state: 'pinned', pinned: true, memoryUsedMb: 1024, requestCount: 0 },
    ] as never);

    renderAiSettings();

    await waitFor(() => {
      expect(screen.getByTestId('recommended-model-checkbox-m1')).toBeChecked();
    });
  });

  it('shows tracked download progress for recommended models', async () => {
    fetchInferenceTrackedModels.mockResolvedValue([
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
    ] as never);

    renderAiSettings();

    await waitFor(() => {
      expect(screen.getByText('Downloading 42%')).toBeInTheDocument();
    });
  });

  it('only pulls models compatible with the selected backend', async () => {
    ensurePullsStarted.mockResolvedValue(undefined);
    fetchInferenceOnboardingProfile.mockResolvedValue({
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
    } as never);
    fetchInferenceTrackedModels.mockResolvedValue([
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
    ] as never);

    const user = userEvent.setup();
    renderAiSettings();

    await waitFor(() => {
      expect(screen.getByTestId('recommended-model-checkbox-m1')).toBeChecked();
    });

    await user.click(screen.getByTestId('ai-settings-save-btn'));
    await user.click(screen.getByTestId('ai-settings-confirm-btn'));

    await waitFor(() => {
      expect(saveInferencePreferences).toHaveBeenCalled();
    });

    expect(ensurePullsStarted).not.toHaveBeenCalledWith(['whisper-base'], expect.anything());
  });

  it('pre-selects models the backend reports installed even when the tracked registry is empty', async () => {
    // The tracked registry lives in memory in the Hub and is never rebuilt, so it is empty after a
    // restart and for any vLLM model (which the Hub never pulls). The backend still serves them.
    fetchInferenceOnboardingProfile.mockResolvedValue(profileWithInstalled(['m1']));
    fetchInferenceTrackedModels.mockResolvedValue([]);

    renderAiSettings();

    await waitFor(() => expect(screen.getByTestId('recommended-model-checkbox-m1')).toBeChecked());
  });

  it('saves an installed model as the agent default instead of clearing the stored preference', async () => {
    fetchInferenceOnboardingProfile.mockResolvedValue(profileWithInstalled(['m1']));
    fetchInferenceTrackedModels.mockResolvedValue([]);

    const user = userEvent.setup();
    renderAiSettings();

    await waitFor(() => expect(screen.getByTestId('recommended-model-checkbox-m1')).toBeChecked());

    await user.click(screen.getByTestId('ai-settings-save-btn'));
    await user.click(screen.getByTestId('ai-settings-confirm-btn'));

    // Seeding from the tracked registry alone left this null, which clears the stored default.
    await waitFor(() => expect(saveInferencePreferences).toHaveBeenCalledWith(expect.objectContaining({ model: 'm1' })));
  });

  it('keeps installed models selected while a pull is in progress', async () => {
    // A tracked transfer starts the poller, which refetches tracked models every few seconds. It
    // must not rewrite the selection: `m2` is installed but was never pulled by this process.
    fetchInferenceOnboardingProfile.mockResolvedValue(profileWithInstalled(['m1', 'm2'], [llm('m1'), llm('m2')]));
    fetchInferenceTrackedModels.mockResolvedValue([
      {
        catalogId: 'm1',
        backend: 'vllm',
        backendModelId: 'model-1',
        state: 'pulling',
        pinned: false,
        pullProgress: 42,
        memoryUsedMb: 1024,
        requestCount: 0,
      },
    ] as never);

    renderAiSettings();

    await waitFor(() => expect(screen.getByTestId('recommended-model-checkbox-m1')).toBeChecked());
    // The poller fires immediately once a transfer is detected, so no timers are needed here.
    await waitFor(() => expect(fetchInferenceTrackedModels).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('recommended-model-checkbox-m2')).toBeChecked();
  });

  it('warns that saving an empty selection clears preferences and unpins models', async () => {
    fetchInferenceOnboardingProfile.mockResolvedValue(profileWithInstalled(['m1']));
    fetchInferenceTrackedModels.mockResolvedValue([]);
    fetchInferencePreferences.mockResolvedValue({ preferredBackend: 'vllm', preferredModel: 'm1' });

    const user = userEvent.setup();
    renderAiSettings();

    await waitFor(() => expect(screen.getByTestId('recommended-model-checkbox-m1')).toBeChecked());
    await user.click(screen.getByTestId('recommended-model-checkbox-m1'));

    await user.click(screen.getByTestId('ai-settings-save-btn'));

    // Still allowed — deselecting everything is a legitimate way to unpin — but the generic
    // "this restarts your apps" copy gave no hint that it also wipes the agent defaults.
    expect(screen.getByTestId('ai-settings-confirm-description')).toHaveTextContent(/clears the default chat, embedding and vision models/);
  });

  it('keeps the ordinary confirmation copy when the selection is not being emptied', async () => {
    fetchInferenceOnboardingProfile.mockResolvedValue(profileWithInstalled(['m1']));
    fetchInferenceTrackedModels.mockResolvedValue([]);
    fetchInferencePreferences.mockResolvedValue({ preferredBackend: 'vllm', preferredModel: 'm1' });

    const user = userEvent.setup();
    renderAiSettings();

    await waitFor(() => expect(screen.getByTestId('recommended-model-checkbox-m1')).toBeChecked());
    await user.click(screen.getByTestId('ai-settings-save-btn'));

    expect(screen.getByTestId('ai-settings-confirm-description')).toHaveTextContent(/restart your apps that use AI models/);
  });

  it('warns about an emptying save even when the backend reports nothing installed', async () => {
    // A backend that is down answers the profile endpoint with nothing served, so the selection
    // empties for a reason that has nothing to do with intent — the case a guard keyed to the
    // installed list would miss, and the one where saving does the most damage.
    fetchInferenceOnboardingProfile.mockResolvedValue(profileWithInstalled([]));
    fetchInferenceTrackedModels.mockResolvedValue([]);
    fetchInferencePreferences.mockResolvedValue({ preferredBackend: 'vllm', preferredModel: 'm1' });

    const user = userEvent.setup();
    renderAiSettings();

    await waitFor(() => expect(screen.getByTestId('recommended-model-checkbox-m1')).not.toBeChecked());
    await user.click(screen.getByTestId('ai-settings-save-btn'));

    expect(screen.getByTestId('ai-settings-confirm-description')).toHaveTextContent(/clears the default chat, embedding and vision models/);
  });

  it('does not warn when an empty selection has no preferences or pins to destroy', async () => {
    // Nothing stored and nothing pinned: the save clears nothing, so the warning would be a lie.
    fetchInferenceOnboardingProfile.mockResolvedValue(profileWithInstalled([]));
    fetchInferenceTrackedModels.mockResolvedValue([]);
    fetchInferencePreferences.mockResolvedValue({ preferredBackend: 'vllm' });

    const user = userEvent.setup();
    renderAiSettings();

    await waitFor(() => expect(screen.getByTestId('recommended-model-checkbox-m1')).not.toBeChecked());
    await user.click(screen.getByTestId('ai-settings-save-btn'));

    expect(screen.getByTestId('ai-settings-confirm-description')).toHaveTextContent(/restart your apps that use AI models/);
  });

  it('shows rescan error toast and skips profile refresh when rescan returns non-OK', async () => {
    rescanInferenceHardware.mockRejectedValue(new Error('HTTP 503'));

    const user = userEvent.setup();
    renderAiSettings();

    await waitFor(() => {
      expect(screen.getByTestId('hardware-profile-card')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('rescan-btn'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Rescan failed: HTTP 503');
    });

    expect(fetchInferenceOnboardingProfile).toHaveBeenCalledTimes(1);
  });
});
