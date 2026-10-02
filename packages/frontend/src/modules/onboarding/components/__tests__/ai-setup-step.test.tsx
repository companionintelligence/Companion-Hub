import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiSetupStep } from '../ai-setup-step';
import type { HardwareProfileResponse } from '../../helpers/ai-setup-types';

const { fetchInferenceOnboardingProfile, fetchOllamaInstallStatus, fetchVllmInstallStatus, fetchLemonadeInstallStatus, rescanInferenceHardware } =
  vi.hoisted(() => ({
    fetchInferenceOnboardingProfile: vi.fn(),
    fetchOllamaInstallStatus: vi.fn(),
    fetchVllmInstallStatus: vi.fn(),
    fetchLemonadeInstallStatus: vi.fn(),
    rescanInferenceHardware: vi.fn(),
  }));

vi.mock('@/lib/inference/inference-api', () => ({
  fetchInferenceOnboardingProfile,
  fetchOllamaInstallStatus,
  fetchVllmInstallStatus,
  fetchLemonadeInstallStatus,
  rescanInferenceHardware,
}));

vi.mock('@/components/ui/Skeleton/Skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => <div data-testid="skeleton" className={className} />,
}));

const mockOpenExternal = vi.fn();
vi.mock('@/lib/helpers/open-external', () => ({
  openExternal: (...args: unknown[]) => mockOpenExternal(...args),
}));

vi.mock('../../helpers/use-marketplace-catalog-apps', () => ({
  useMarketplaceCatalogApps: () => ({
    apps: [],
    isLoading: false,
    isRetryingEmptyCatalog: false,
    isCatalogSettled: true,
    isError: false,
    refetch: vi.fn(),
  }),
}));

const mockUseQuery = vi.fn();
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: (...args: unknown[]) => mockUseQuery(...args),
    useMutation: () => ({ mutate: vi.fn(), isPending: false }),
    useQueryClient: () => ({ invalidateQueries: vi.fn(), getQueryData: vi.fn() }),
  };
});

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getStatus3Options: () => ({ queryKey: ['tailscale-status'], queryFn: vi.fn() }),
  getStatus3QueryKey: () => ['tailscale-status'],
}));

vi.mock('@/lib/hooks/use-tailscale-readiness-sync', () => ({
  useTailscaleReadinessSync: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// The Companion Memory card lazy-loads lottie-react, and lottie-web reaches for a canvas 2D context
// at import time, which jsdom doesn't provide. The failed import is cached, so once the first render
// hits it every later render in this file throws and comes up empty.
vi.mock('lottie-react', () => ({
  Lottie: () => null,
}));

// Onboarding pins inference to Ollama, so catalog fixtures use the Ollama backend.
const highTierProfile: HardwareProfileResponse = {
  hardware: {
    gpu: {
      available: true,
      vendor: 'nvidia',
      model: 'RTX 4090',
      vramMb: 24576,
      unifiedMemory: false,
      driverVersion: '550.0',
      runtimeAvailable: true,
    },
    npu: { available: false, model: '' },
    ram: { totalMb: 32768, availableMb: 24000 },
    cpu: { arch: 'x86_64', cores: 16, model: 'AMD Ryzen 9' },
    effectiveInferenceMemoryMb: 24576,
    tier: 'high',
  },
  tier: 'high',
  recommendedModels: [
    {
      id: 'phi-4-mini',
      displayName: 'Phi-4 Mini',
      description: 'Small language model',
      modality: 'llm',
      purpose: 'general',
      backend: 'ollama',
      runtime: { backendModelId: 'phi4-mini', input: ['text'], pinnedByDefault: true, memoryFootprintMb: 2048 },
      tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
    },
  ] as any,
  availableModels: [
    {
      id: 'phi-4-mini',
      displayName: 'Phi-4 Mini',
      description: 'Small language model',
      modality: 'llm',
      purpose: 'general',
      backend: 'ollama',
      runtime: { backendModelId: 'phi4-mini', input: ['text'], pinnedByDefault: true, memoryFootprintMb: 2048 },
      tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
    },
    {
      id: 'qwen-coder',
      displayName: 'Qwen 2.5 Coder',
      description: 'Coding model',
      modality: 'llm',
      purpose: 'coding',
      backend: 'ollama',
      runtime: { backendModelId: 'qwen2.5-coder', input: ['text'], pinnedByDefault: false, memoryFootprintMb: 4096 },
      tiers: { high: 'available', medium: 'available', low: 'unavailable', cpuOnly: 'unavailable' },
    },
  ] as any,
  memoryBudget: {
    totalVramMb: 24576,
    totalRamMb: 32768,
    systemReservedRamMb: 2048,
    dockerOverheadMb: 0,
    appContainerBudgetMb: 0,
    modelBudgetVramMb: 24064,
    modelBudgetRamMb: 30720,
    modelUsedVramMb: 0,
    modelUsedRamMb: 0,
    pinnedVramMb: 0,
    pinnedRamMb: 0,
    usage: { sampledAt: '2026-09-20T00:00:00.000Z', backends: [] },
  },
  backends: {
    recommended: 'ollama',
    available: [
      { type: 'ollama', running: true, healthy: true },
      { type: 'vllm', running: false, healthy: false },
    ],
  },
  resourceEstimate: { totalDiskMb: 2048, totalMemoryMb: 2048, availableMemoryMb: 24064, availableDiskMb: 500000, diskTotalMb: 1000000 },
  installedCatalogIds: ['phi-4-mini'],
};

const insufficientProfile: HardwareProfileResponse = {
  ...highTierProfile,
  tier: 'insufficient',
  hardware: {
    ...highTierProfile.hardware,
    tier: 'insufficient',
    gpu: { available: false, vendor: 'none', model: '', vramMb: 0, unifiedMemory: false, driverVersion: '', runtimeAvailable: false },
    ram: { totalMb: 2048, availableMb: 1024 },
  },
  recommendedModels: [],
  availableModels: [],
  resourceEstimate: { totalDiskMb: 0, totalMemoryMb: 0, availableMemoryMb: 0, availableDiskMb: 0, diskTotalMb: 0 },
  installedCatalogIds: [],
};

const ollamaReady = { ready: true, running: true, endpointUrl: 'http://ci-hub-ollama:11434' };
const ollamaMissing = { ready: false, running: false, endpointUrl: 'http://ci-hub-ollama:11434' };
const vllmReady = {
  ready: true,
  running: true,
  endpointUrl: 'http://host.docker.internal:8000',
  displayEndpoint: 'http://host.docker.internal:8000/v1',
};
const vllmMissing = { ready: false, running: false, endpointUrl: 'http://host.docker.internal:8000' };

// A model the Hub cannot pull — it only ever appears as installed while the host vLLM serves it.
const vllmModel = {
  id: 'qwen3-4b-instruct-vllm',
  displayName: 'Qwen 3 4B Instruct (vLLM)',
  description: 'Chat model served by host vLLM',
  modality: 'llm',
  purpose: 'general',
  backend: 'vllm',
  runtime: { backendModelId: 'Qwen/Qwen3-4B-Instruct-2507', input: ['text'], pinnedByDefault: false, memoryFootprintMb: 9123 },
  tiers: { high: 'recommended', medium: 'available', low: 'not-recommended', cpuOnly: 'not-recommended' },
};

/** A vLLM-recommended profile whose catalog is the host-served model above. */
const vllmProfile = (installedCatalogIds: string[] = []): HardwareProfileResponse =>
  ({
    ...highTierProfile,
    backends: { ...highTierProfile.backends, recommended: 'vllm' },
    recommendedModels: [vllmModel],
    availableModels: [vllmModel],
    installedCatalogIds,
  }) as any;

// Mutable API state read by the default mock; tests tweak it before rendering.
let api: {
  profile: HardwareProfileResponse;
  profileOk: boolean;
  profileReject: boolean;
  ollama: {
    ready: boolean;
    running: boolean;
    endpointUrl: string;
    bridgeUnreachable?: boolean;
    failureMode?: 'filtered' | 'refused' | 'dns' | 'none';
    remediationCommand?: string;
    displayEndpoint?: string;
    hint?: string;
    error?: string;
  };
  vllm: {
    ready: boolean;
    running: boolean;
    endpointUrl: string;
    displayEndpoint?: string;
  };
  rescanOk: boolean;
};

function renderStep(props: Partial<Parameters<typeof AiSetupStep>[0]> = {}) {
  const handlers = { onComplete: vi.fn(), onSkip: vi.fn(), onBack: vi.fn() };
  render(<AiSetupStep {...handlers} {...props} />);
  return handlers;
}

describe('AiSetupStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (X11; Linux x86_64)' });

    api = {
      profile: highTierProfile,
      profileOk: true,
      profileReject: false,
      ollama: ollamaReady,
      vllm: vllmMissing,
      rescanOk: true,
    };

    fetchInferenceOnboardingProfile.mockImplementation((_backend?: string) => {
      if (api.profileReject) return Promise.reject(new Error('Network error'));
      if (!api.profileOk) return Promise.reject(new Error('Failed'));
      return Promise.resolve(api.profile);
    });
    fetchOllamaInstallStatus.mockImplementation(() => Promise.resolve(api.ollama));
    fetchVllmInstallStatus.mockImplementation(() => Promise.resolve(api.vllm));
    fetchLemonadeInstallStatus.mockImplementation(() => Promise.resolve({ ready: false, running: false, endpointUrl: 'http://127.0.0.1:13305' }));
    rescanInferenceHardware.mockImplementation(async () => {
      if (!api.rescanOk) throw new Error('HTTP 503');
    });

    mockUseQuery.mockReturnValue({
      data: { installed: true, connected: false, ip: null, hostname: null, backendState: 'Stopped' },
      isLoading: false,
      isError: false,
    });
  });

  it('shows loading skeleton while fetching profile', () => {
    fetchInferenceOnboardingProfile.mockImplementation(() => new Promise(() => {}));
    renderStep();
    expect(screen.getByTestId('ai-setup-loading')).toBeInTheDocument();
  });

  it('shows error state when fetch fails', async () => {
    api.profileReject = true;
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-error')).toBeInTheDocument());
    expect(screen.getByText(/Couldn.t complete AI setup/)).toBeInTheDocument();
  });

  it('renders the system overview with tier badge and GPU for high-tier hardware', async () => {
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.getByTestId('hw-card-title')).toHaveTextContent('System Overview');
    expect(screen.getByTestId('tier-badge')).toHaveTextContent('High');
    expect(screen.getByTestId('hw-gpu')).toHaveTextContent('RTX 4090');
  });

  it('shows APU badge and shared VRAM for AMD unified-memory hardware', async () => {
    api.profile = {
      ...highTierProfile,
      tier: 'high',
      hardware: {
        ...highTierProfile.hardware,
        cpu: { arch: 'x86_64', cores: 32, model: 'RYZEN AI MAX+ 395 w/ Radeon 8060S' },
        ram: { totalMb: 125_829, availableMb: 115_000 },
        gpu: {
          available: true,
          vendor: 'amd',
          model: 'Radeon 8060S',
          vramMb: 125_829,
          unifiedMemory: true,
          driverVersion: '',
          runtimeAvailable: false,
        },
      },
    };
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.getByTestId('tier-badge')).toHaveTextContent('APU');
    expect(screen.getByTestId('hw-gpu')).toHaveTextContent('Radeon 8060S');
    expect(screen.getByText('Shared · APU')).toBeInTheDocument();
    expect(screen.queryByText('No GPU detected.')).not.toBeInTheDocument();
  });

  it('shows Apple Silicon with unified memory instead of no-GPU warnings', async () => {
    api.profile = {
      ...highTierProfile,
      tier: 'medium',
      hardware: {
        ...highTierProfile.hardware,
        tier: 'medium',
        cpu: { arch: 'arm64', cores: 10, model: 'Apple M1 Pro' },
        ram: { totalMb: 16384, availableMb: 12288 },
        gpu: {
          available: true,
          vendor: 'apple',
          model: 'Apple M1 Pro (Apple Silicon)',
          vramMb: 16384,
          unifiedMemory: true,
          driverVersion: '',
          runtimeAvailable: true,
        },
        effectiveInferenceMemoryMb: 12288,
      },
    };
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.getByTestId('tier-badge')).toHaveTextContent('Apple Silicon');
    expect(screen.getByTestId('hw-gpu')).toHaveTextContent('Apple M1 Pro (Apple Silicon)');
    expect(screen.getByText('Unified Memory')).toBeInTheDocument();
    expect(screen.queryByText('No GPU detected.')).not.toBeInTheDocument();
  });

  it('shows no GPU warning copy when gpu.available is false', async () => {
    api.profile = {
      ...highTierProfile,
      hardware: {
        ...highTierProfile.hardware,
        gpu: { ...highTierProfile.hardware.gpu, available: false, model: '', runtimeAvailable: false, vendor: 'none', vramMb: 0 },
      },
    };
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.getByText('No GPU detected.')).toBeInTheDocument();
    expect(screen.getByText(/AI services will run on CPU only/)).toBeInTheDocument();
  });

  it('shows NVIDIA runtime setup guidance when NVIDIA GPU runtime is unavailable', async () => {
    api.profile = {
      ...highTierProfile,
      hardware: { ...highTierProfile.hardware, gpu: { ...highTierProfile.hardware.gpu, available: true, runtimeAvailable: false, vendor: 'nvidia' } },
    };
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.getByTestId('nvidia-runtime-warning')).toBeInTheDocument();
    expect(screen.getByText(/NVIDIA GPU detected, but the container GPU runtime is not ready yet/i)).toBeInTheDocument();
  });

  it('hides host ROCm notice when AMD GPU already has host ROCm', async () => {
    api.profile = {
      ...highTierProfile,
      hardware: {
        ...highTierProfile.hardware,
        gpu: {
          ...highTierProfile.hardware.gpu,
          available: true,
          runtimeAvailable: false,
          hostRocmAvailable: true,
          hostRocmKfdAvailable: true,
          vendor: 'amd',
          model: 'Radeon RX 7900 XTX',
        },
      },
    };
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.queryByTestId('amd-host-rocm-ready')).not.toBeInTheDocument();
    expect(screen.queryByTestId('amd-host-rocm-hint')).not.toBeInTheDocument();
    expect(screen.queryByText(/Host ROCm detected/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Container GPU runtime not available.')).not.toBeInTheDocument();
  });

  it('shows host ROCm install hint when AMD GPU lacks host ROCm', async () => {
    api.profile = {
      ...highTierProfile,
      hardware: {
        ...highTierProfile.hardware,
        gpu: {
          ...highTierProfile.hardware.gpu,
          available: true,
          runtimeAvailable: false,
          hostRocmAvailable: false,
          vendor: 'amd',
          model: 'Radeon RX 7900 XTX',
        },
      },
    };
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.getByTestId('amd-host-rocm-hint')).toBeInTheDocument();
    expect(screen.getByText(/Install ROCm on the host/i)).toBeInTheDocument();
    expect(screen.queryByText('Container GPU runtime not available.')).not.toBeInTheDocument();
  });

  it('shows generic non-Linux NVIDIA guidance without Linux shell commands', async () => {
    Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'Win32' });
    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    api.profile = {
      ...highTierProfile,
      hardware: { ...highTierProfile.hardware, gpu: { ...highTierProfile.hardware.gpu, runtimeAvailable: false } },
    };
    renderStep();
    await waitFor(() => expect(screen.getByTestId('nvidia-runtime-warning')).toBeInTheDocument());
    expect(screen.getByText(/Docker Desktop and confirm WSL2 GPU support is enabled/i)).toBeInTheDocument();
    expect(screen.queryByText(/sudo apt-get update/i)).not.toBeInTheDocument();
  });

  it('pre-selects only models already installed in Ollama', async () => {
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect((screen.getByTestId('model-checkbox-phi-4-mini') as HTMLInputElement).checked).toBe(true);
  });

  it('does not pre-select recommended models that are not installed', async () => {
    api.profile = { ...highTierProfile, installedCatalogIds: [] };
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect((screen.getByTestId('model-checkbox-phi-4-mini') as HTMLInputElement).checked).toBe(false);
    // No install-block-reason: selecting no models is allowed (users can add AI later in Settings).
    expect(screen.queryByTestId('install-block-reason')).not.toBeInTheDocument();
  });

  it('submits only Ollama-backed models with the agent framework and exposure', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    // qwen-coder is not recommended, so it lives in the Advanced "Other Models" drawer, not the grid.
    expect(screen.getByTestId('model-checkbox-phi-4-mini')).toBeInTheDocument();
    expect(screen.getByText('1 model selected')).toBeInTheDocument();

    await user.click(screen.getByTestId('ai-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith({
      agentFrameworks: ['openclaw'],
      selectedModels: ['phi-4-mini'],
      ollamaSelectedModelIds: ['phi-4-mini'],
      backend: 'ollama',
      cloudProviders: [],
      preferredModelId: 'phi-4-mini',
      remoteAccess: ['cloudflare'],
      exposureMode: 'cloudflare',
      skipped: false,
      installedCatalogIds: ['phi-4-mini'],
      installBlocked: false,
      installBlockReason: undefined,
    });
  });

  it('shows the inference backend selection card', async () => {
    renderStep();
    await waitFor(() => expect(screen.getByTestId('backend-selection-embedded')).toBeInTheDocument());
    const inferenceSetup = screen.getByTestId('inference-setup-section');
    expect(inferenceSetup).toHaveTextContent('Set up inference');
    expect(inferenceSetup).toContainElement(screen.getByTestId('backend-selection-embedded'));
    expect(inferenceSetup).toContainElement(screen.getByTestId('selected-backend-setup'));
    expect(inferenceSetup).not.toHaveTextContent('Choose a backend, then make sure it is ready to run your models.');
    expect(inferenceSetup).not.toHaveTextContent('Inference Backend');
    expect(inferenceSetup).not.toHaveTextContent('The backend runs AI models locally on your hardware.');
    expect(screen.getByTestId('backend-option-ollama')).toBeInTheDocument();
    expect(screen.getByTestId('backend-option-vllm')).toBeInTheDocument();
  });

  it('offers oMLX on Apple Silicon and hides vLLM and Lemonade', async () => {
    api.profile = {
      ...highTierProfile,
      hardware: {
        ...highTierProfile.hardware,
        gpu: { ...highTierProfile.hardware.gpu, vendor: 'apple', model: 'Apple M2 Max', unifiedMemory: true },
        cpu: { ...highTierProfile.hardware.cpu, arch: 'arm64', model: 'Apple M2 Max' },
        os: { platform: 'darwin', name: 'macOS', version: '15.6' },
      },
      backends: {
        recommended: 'omlx',
        available: [
          { type: 'ollama', running: true, healthy: true },
          { type: 'vllm', running: false, healthy: false },
          { type: 'lemonade', running: false, healthy: false },
          { type: 'omlx', running: false, healthy: false },
        ],
      },
    };

    renderStep();
    await waitFor(() => expect(screen.getByTestId('backend-option-omlx')).toBeInTheDocument());

    const optionIds = Array.from(screen.getByTestId('backend-options').querySelectorAll('label')).map((label) => label.dataset.testid);
    expect(optionIds).toEqual(['backend-option-ollama', 'backend-option-omlx']);
    expect(screen.queryByTestId('backend-option-vllm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('backend-option-lemonade')).not.toBeInTheDocument();
    expect(screen.getByTestId('backend-option-omlx').querySelector('input') as HTMLInputElement).toBeChecked();
  });

  it('hides oMLX on Linux and keeps Ollama, vLLM, and Lemonade when the GPU is AMD', async () => {
    api.profile = {
      ...highTierProfile,
      hardware: {
        ...highTierProfile.hardware,
        gpu: { ...highTierProfile.hardware.gpu, vendor: 'amd', runtimeAvailable: true },
        os: { platform: 'linux', name: 'Ubuntu', version: '24.04' },
      },
      backends: {
        recommended: 'ollama',
        available: [
          { type: 'ollama', running: true, healthy: true },
          { type: 'vllm', running: false, healthy: false },
          { type: 'lemonade', running: false, healthy: false },
          { type: 'omlx', running: false, healthy: false },
        ],
      },
    };

    renderStep();
    await waitFor(() => expect(screen.getByTestId('backend-option-ollama')).toBeInTheDocument());

    expect(screen.queryByTestId('backend-option-omlx')).not.toBeInTheDocument();
    expect(screen.getByTestId('backend-option-lemonade')).toBeInTheDocument();
    expect(screen.queryByTestId('backend-option-vllm')).not.toBeInTheDocument();
  });

  it('shows only inference memory beside capabilities on recommended model cards', async () => {
    const sourceModel = highTierProfile.recommendedModels[0];
    if (!sourceModel) throw new Error('Test fixture is missing a recommended model');
    const model = {
      ...sourceModel,
      runtime: { ...sourceModel.runtime, memoryFootprintMb: 23552 },
      requirements: { diskMb: 24064 },
    };
    api.profile = {
      ...highTierProfile,
      recommendedModels: [model] as any,
      availableModels: [model] as any,
    };

    renderStep();
    await waitFor(() => expect(screen.getByTestId('model-row-phi-4-mini')).toBeInTheDocument());

    const modelCard = screen.getByTestId('model-row-phi-4-mini');
    // The figure says what it is — the icon it used to rely on is too small to read.
    expect(modelCard).toHaveTextContent('23.0 GB VRAM');
    expect(modelCard).not.toHaveTextContent('23.5 GB');
    expect(modelCard).not.toHaveTextContent('Disk');
    expect(modelCard.querySelector('[data-testid="model-meta-inline"]')).toBeInTheDocument();
  });

  it('does not block Continue on vLLM path when Ollama is down', async () => {
    api.profile = {
      ...highTierProfile,
      backends: { ...highTierProfile.backends, recommended: 'vllm' },
    };
    api.ollama = ollamaMissing;
    api.vllm = vllmReady;
    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    await user.click(screen.getByTestId('backend-option-vllm'));
    await waitFor(() => expect(screen.getByText('vLLM detected')).toBeInTheDocument());
    expect(screen.getByTestId('ai-continue-btn')).not.toBeDisabled();
  });

  it('disables Continue when vLLM is selected but not reachable', async () => {
    api.profile = {
      ...highTierProfile,
      backends: { ...highTierProfile.backends, recommended: 'vllm' },
    };
    api.vllm = vllmMissing;
    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    await user.click(screen.getByTestId('backend-option-vllm'));
    await waitFor(() => expect(screen.getByText('vLLM not detected')).toBeInTheDocument());
    expect(screen.getByTestId('ai-continue-btn')).toBeDisabled();
  });

  it('refreshes the model list on vLLM re-check so a newly served model reads as installed', async () => {
    api.profile = vllmProfile();
    api.vllm = vllmReady;

    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    // `backends.recommended` is vLLM, so the step already opens on that backend.
    await waitFor(() => expect(screen.getByText('vLLM detected')).toBeInTheDocument());

    // Nothing is served by the host vLLM server yet, so the card is not selectable.
    expect((screen.getByTestId('model-checkbox-qwen3-4b-instruct-vllm') as HTMLInputElement).checked).toBe(false);

    // The operator loads the model on the host — the next profile fetch reports it installed.
    api.profile = vllmProfile(['qwen3-4b-instruct-vllm']);
    await user.click(screen.getByTestId('vllm-recheck-btn'));

    await waitFor(() => expect((screen.getByTestId('model-checkbox-qwen3-4b-instruct-vllm') as HTMLInputElement).checked).toBe(true));
  });

  it('keeps the selected backend when re-checking, rather than resetting to the recommended one', async () => {
    api.profile = {
      ...highTierProfile,
      backends: { ...highTierProfile.backends, recommended: 'ollama' },
    };
    api.vllm = vllmReady;

    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    await user.click(screen.getByTestId('backend-option-vllm'));
    await waitFor(() => expect(screen.getByText('vLLM detected')).toBeInTheDocument());

    // Scope the assertion to the re-check: picking the backend already fetched a vLLM profile, so
    // without this the expectation below passes even when Re-check refetches nothing at all.
    fetchInferenceOnboardingProfile.mockClear();
    await user.click(screen.getByTestId('vllm-recheck-btn'));

    // Still on vLLM — the refetch must happen, and must not snap back to the recommended backend.
    await waitFor(() => expect(fetchInferenceOnboardingProfile).toHaveBeenCalledWith('vllm', '', '', ''));
    expect(screen.getByText('vLLM detected')).toBeInTheDocument();
  });

  it('does not discard model choices the operator already made when re-checking', async () => {
    api.profile = vllmProfile(['qwen3-4b-instruct-vllm']);
    api.vllm = vllmReady;

    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('vLLM detected')).toBeInTheDocument());

    // Installed models start selected; the operator deliberately opts out of this one.
    const checkbox = () => screen.getByTestId('model-checkbox-qwen3-4b-instruct-vllm') as HTMLInputElement;
    await waitFor(() => expect(checkbox().checked).toBe(true));
    await user.click(checkbox());
    expect(checkbox().checked).toBe(false);

    await user.click(screen.getByTestId('vllm-recheck-btn'));

    // Re-check refreshes what is installed — it must not re-tick a deliberate opt-out.
    await waitFor(() => expect(fetchVllmInstallStatus).toHaveBeenCalledTimes(2));
    expect(checkbox().checked).toBe(false);
  });

  it('keeps a model ticked while the re-check refresh is still in flight', async () => {
    const secondModel = {
      ...vllmModel,
      id: 'qwen3-8b-vllm',
      displayName: 'Qwen 3 8B (vLLM)',
      runtime: { ...vllmModel.runtime, backendModelId: 'Qwen/Qwen3-8B' },
    };
    const bothServed = {
      ...vllmProfile(['qwen3-4b-instruct-vllm', 'qwen3-8b-vllm']),
      recommendedModels: [vllmModel, secondModel],
      availableModels: [vllmModel, secondModel],
    } as any;
    api.profile = bothServed;
    api.vllm = vllmReady;

    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    const first = () => screen.getByTestId('model-checkbox-qwen3-4b-instruct-vllm') as HTMLInputElement;
    await waitFor(() => expect(first().checked).toBe(true));

    // Hold the refresh open so the operator's click lands while the fetch is still running.
    let release: (() => void) | undefined;
    fetchInferenceOnboardingProfile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(bothServed);
        }),
    );
    await user.click(screen.getByTestId('vllm-recheck-btn'));
    await waitFor(() => expect(release).toBeDefined());

    await user.click(first());
    expect(first().checked).toBe(false);

    release?.();

    // The refresh must merge onto the live selection, not the snapshot taken when it started.
    await waitFor(() => expect(fetchInferenceOnboardingProfile).toHaveBeenCalledTimes(2));
    expect(first().checked).toBe(false);
  });

  it('does not wipe the installed model list when re-checking a backend that is down', async () => {
    api.profile = vllmProfile(['qwen3-4b-instruct-vllm']);
    api.vllm = vllmReady;

    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    const checkbox = () => screen.getByTestId('model-checkbox-qwen3-4b-instruct-vllm') as HTMLInputElement;
    await waitFor(() => expect(checkbox().checked).toBe(true));

    // The operator restarts the host vLLM server and re-checks while it is still booting. The
    // profile endpoint swallows its own health-check failure and answers 200 with nothing served.
    api.vllm = vllmMissing;
    api.profile = vllmProfile([]);
    await user.click(screen.getByTestId('vllm-recheck-btn'));
    await waitFor(() => expect(fetchVllmInstallStatus).toHaveBeenCalledTimes(2));

    // Adopting that answer would drop the card back into the "open Hugging Face" branch this
    // feature exists to leave, so an unreachable probe must not trigger the refresh at all.
    expect(checkbox().checked).toBe(true);
    expect(fetchInferenceOnboardingProfile).toHaveBeenCalledTimes(1);
  });

  it('keeps the step usable when the profile refresh fails during a re-check', async () => {
    api.profile = vllmProfile();
    api.vllm = vllmReady;

    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('vLLM detected')).toBeInTheDocument());

    // The refresh is a best-effort enhancement — a transient failure must not replace the
    // whole step with the error screen and lose the operator's in-progress setup.
    api.profileReject = true;
    await user.click(screen.getByTestId('vllm-recheck-btn'));

    await waitFor(() => expect(fetchVllmInstallStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('ai-setup-error')).not.toBeInTheDocument();
  });

  it('does not let a slow rescan snap the backend away from the one just picked', async () => {
    api.profile = { ...highTierProfile, backends: { ...highTierProfile.backends, recommended: 'ollama' } };
    api.vllm = vllmReady;

    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    // Hold the rescan's profile fetch open so the backend switch below answers first.
    let release: (() => void) | undefined;
    fetchInferenceOnboardingProfile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(api.profile);
        }),
    );
    await user.click(screen.getByTestId('rescan-btn'));
    await waitFor(() => expect(release).toBeDefined());

    await user.click(screen.getByTestId('backend-option-vllm'));
    await waitFor(() => expect(screen.getByText('vLLM detected')).toBeInTheDocument());

    release?.();
    // `rescanning` clears in the same `finally` that follows the discarded write, so an enabled
    // Rescan button is proof the late answer has been fully processed.
    await waitFor(() => expect(screen.getByTestId('rescan-btn')).not.toBeDisabled());

    // That answer recommends Ollama. Applying it would drag the operator off the backend they
    // picked while it was in flight, and reset their models to Ollama's defaults.
    expect(screen.getByText('vLLM detected')).toBeInTheDocument();
  });

  it('does not let a superseded backend switch overwrite the profile with the abandoned backend', async () => {
    api.profile = highTierProfile;

    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    const ollamaModel = () => screen.getByTestId('model-checkbox-phi-4-mini') as HTMLInputElement;
    await waitFor(() => expect(ollamaModel().checked).toBe(true));

    // Switching to vLLM hangs; the operator changes their mind before it answers.
    let release: (() => void) | undefined;
    fetchInferenceOnboardingProfile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(vllmProfile(['qwen3-4b-instruct-vllm']));
        }),
    );
    await user.click(screen.getByTestId('backend-option-vllm'));
    await waitFor(() => expect(release).toBeDefined());

    await user.click(screen.getByTestId('backend-option-ollama'));
    await waitFor(() => expect(ollamaModel().checked).toBe(true));

    await act(async () => {
      release?.();
    });

    // The abandoned vLLM answer must not land: it would leave `profile` — and the selection
    // derived from it — describing a backend the operator is no longer on.
    expect(ollamaModel().checked).toBe(true);
  });

  it('does not raise the error screen for a superseded profile request that failed', async () => {
    api.profile = { ...highTierProfile, backends: { ...highTierProfile.backends, recommended: 'ollama' } };
    api.vllm = vllmReady;

    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    let fail: (() => void) | undefined;
    fetchInferenceOnboardingProfile.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error('Network error'));
        }),
    );
    await user.click(screen.getByTestId('rescan-btn'));
    await waitFor(() => expect(fail).toBeDefined());

    await user.click(screen.getByTestId('backend-option-vllm'));
    await waitFor(() => expect(screen.getByText('vLLM detected')).toBeInTheDocument());

    fail?.();
    await waitFor(() => expect(screen.getByTestId('rescan-btn')).not.toBeDisabled());

    // The switch that superseded it already succeeded, so the step is fine — tearing it down over
    // the older request's failure would discard a working setup.
    expect(screen.queryByTestId('ai-setup-error')).not.toBeInTheDocument();
    expect(screen.getByText('vLLM detected')).toBeInTheDocument();
  });

  it('keeps the chosen engine and the ticked models when hardware is rescanned', async () => {
    api.profile = { ...highTierProfile, recommendedModels: highTierProfile.availableModels };
    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('model-checkbox-phi-4-mini')).toBeInTheDocument());

    await user.click(screen.getByTestId('model-checkbox-phi-4-mini'));
    await user.click(screen.getByTestId('model-checkbox-qwen-coder'));
    expect((screen.getByTestId('model-checkbox-phi-4-mini') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('model-checkbox-qwen-coder') as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByTestId('rescan-btn'));
    await waitFor(() => expect(screen.getByTestId('rescan-btn')).not.toBeDisabled());

    expect((screen.getByTestId('model-checkbox-phi-4-mini') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('model-checkbox-qwen-coder') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('backend-option-ollama').querySelector('input')).toBeChecked();
  });

  it('keeps a chosen engine that is not the recommendation when hardware is rescanned', async () => {
    api.vllm = vllmReady;
    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('backend-option-vllm')).toBeInTheDocument());
    await user.click(screen.getByTestId('backend-option-vllm'));
    await waitFor(() => expect(screen.getByTestId('backend-option-vllm').querySelector('input')).toBeChecked());

    await user.click(screen.getByTestId('rescan-btn'));
    await waitFor(() => expect(screen.getByTestId('rescan-btn')).not.toBeDisabled());

    expect(screen.getByTestId('backend-option-vllm').querySelector('input')).toBeChecked();
  });

  it('drops a ticked model the rescan no longer lists', async () => {
    api.profile = { ...highTierProfile, recommendedModels: highTierProfile.availableModels };
    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('model-checkbox-qwen-coder')).toBeInTheDocument());
    await user.click(screen.getByTestId('model-checkbox-qwen-coder'));

    api.profile = {
      ...highTierProfile,
      recommendedModels: highTierProfile.availableModels.filter((model) => model.id !== 'qwen-coder'),
      availableModels: highTierProfile.availableModels.filter((model) => model.id !== 'qwen-coder'),
    };
    await user.click(screen.getByTestId('rescan-btn'));
    await waitFor(() => expect(screen.getByTestId('rescan-btn')).not.toBeDisabled());

    expect(screen.queryByTestId('model-checkbox-qwen-coder')).not.toBeInTheDocument();
    expect((screen.getByTestId('model-checkbox-phi-4-mini') as HTMLInputElement).checked).toBe(true);
  });

  it('reports the same engine block on the embedded config that disables Continue', async () => {
    api.ollama = ollamaMissing;
    const onConfigChange = vi.fn();
    renderStep({ embedded: true, onConfigChange });
    await waitFor(() => expect(screen.getByText('Ollama not detected')).toBeInTheDocument());
    await waitFor(() => expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ engineBlocked: true })));
  });

  it('does not block finish on a weak machine that has no local engine', async () => {
    api.profile = insufficientProfile;
    api.ollama = ollamaMissing;
    const onConfigChange = vi.fn();
    renderStep({ embedded: true, onConfigChange });
    await waitFor(() => expect(screen.getByTestId('cloud-keys-section')).toBeInTheDocument());
    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
    const latest = onConfigChange.mock.calls.at(-1)?.[0] as { engineBlocked?: boolean };
    expect(latest.engineBlocked).toBeUndefined();
  });

  it('gives model tiles and access options a visible focus ring without showing the checkbox', async () => {
    renderStep();
    await waitFor(() => expect(screen.getByTestId('model-row-phi-4-mini')).toBeInTheDocument());

    expect(screen.getByTestId('model-checkbox-phi-4-mini')).toHaveClass('sr-only');
    expect(screen.getByTestId('model-row-phi-4-mini').className).toContain('has-[:focus-visible]:ring-2');
    expect(screen.getByTestId('access-cloudflare')).toHaveClass('sr-only');
    expect(screen.getByTestId('access-cloudflare').closest('label')?.className).toContain('has-[:focus-visible]:ring-2');
  });

  it('allows toggling model selection', async () => {
    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    const checkbox = screen.getByTestId('model-checkbox-phi-4-mini') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);
    await user.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });

  it('hides the local-model steps when tier is insufficient', async () => {
    api.profile = insufficientProfile;
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.queryByTestId('model-card-title')).not.toBeInTheDocument();
    expect(screen.queryByTestId('backend-card-title')).not.toBeInTheDocument();
  });

  it('shows cloud provider inputs prominently when tier is insufficient', async () => {
    api.profile = insufficientProfile;
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.getByTestId('access-methods-card')).toBeInTheDocument();
    expect(screen.getByTestId('agent-apps-card')).toBeInTheDocument();
    expect(screen.queryByTestId('inference-setup-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-section-toggle-7')).not.toBeInTheDocument();
    expect(screen.getByTestId('cloud-keys-section')).toHaveTextContent('5');
    expect(screen.getByTestId('cloud-inputs')).toBeInTheDocument();
    expect(screen.getByText(/can't run local AI models/)).toBeInTheDocument();
  });

  it('shows "Continue without AI" when insufficient and no cloud key entered', async () => {
    api.profile = insufficientProfile;
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.getByTestId('ai-continue-btn')).toHaveTextContent('Continue to Private VPN without AI');
  });

  it('calls onComplete with config when Continue is clicked', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    await user.click(screen.getByTestId('ai-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith({
      agentFrameworks: ['openclaw'],
      selectedModels: ['phi-4-mini'],
      ollamaSelectedModelIds: ['phi-4-mini'],
      backend: 'ollama',
      cloudProviders: [],
      preferredModelId: 'phi-4-mini',
      remoteAccess: ['cloudflare'],
      exposureMode: 'cloudflare',
      skipped: false,
      installedCatalogIds: ['phi-4-mini'],
      installBlocked: false,
      installBlockReason: undefined,
    });
  });

  it('derives embedding and vision defaults from installed onboarding models', async () => {
    api.profile = {
      ...highTierProfile,
      recommendedModels: [
        ...highTierProfile.recommendedModels,
        {
          id: 'nomic-embed-text',
          displayName: 'Nomic Embed',
          description: 'Embedding model',
          modality: 'embedding',
          purpose: 'general',
          backend: 'ollama',
          runtime: { backendModelId: 'nomic-embed-text', input: ['text'], pinnedByDefault: true, memoryFootprintMb: 512 },
          tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
        },
        {
          id: 'gemma-vision',
          displayName: 'Gemma Vision',
          description: 'Vision model',
          modality: 'llm',
          purpose: 'general',
          backend: 'ollama',
          metadata: { capabilities: { vision: true } },
          runtime: { backendModelId: 'gemma-vision', input: ['text', 'image'], pinnedByDefault: true, memoryFootprintMb: 2048 },
          tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
        },
      ] as any,
      availableModels: [
        ...highTierProfile.availableModels,
        {
          id: 'nomic-embed-text',
          displayName: 'Nomic Embed',
          description: 'Embedding model',
          modality: 'embedding',
          purpose: 'general',
          backend: 'ollama',
          runtime: { backendModelId: 'nomic-embed-text', input: ['text'], pinnedByDefault: true, memoryFootprintMb: 512 },
          tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
        },
        {
          id: 'gemma-vision',
          displayName: 'Gemma Vision',
          description: 'Vision model',
          modality: 'llm',
          purpose: 'general',
          backend: 'ollama',
          metadata: { capabilities: { vision: true } },
          runtime: { backendModelId: 'gemma-vision', input: ['text', 'image'], pinnedByDefault: true, memoryFootprintMb: 2048 },
          tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
        },
      ] as any,
      installedCatalogIds: ['phi-4-mini', 'nomic-embed-text', 'gemma-vision'],
    };

    const user = userEvent.setup();
    const { onComplete } = renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    await user.click(screen.getByTestId('ai-continue-btn'));

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredModelId: 'phi-4-mini',
        preferredEmbeddingModelId: 'nomic-embed-text',
        preferredVisionModelId: 'gemma-vision',
      }),
    );
  });

  it('does not treat non-LLM models with generic purposes as the default chat model', async () => {
    api.profile = {
      ...highTierProfile,
      recommendedModels: [
        {
          id: 'embed-first',
          displayName: 'Embed First',
          description: 'Embedding model',
          modality: 'embedding',
          purpose: 'general',
          backend: 'ollama',
          runtime: { backendModelId: 'embed-first', input: ['text'], pinnedByDefault: true, memoryFootprintMb: 512 },
          tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
        },
        ...highTierProfile.recommendedModels,
      ] as any,
      availableModels: [
        {
          id: 'embed-first',
          displayName: 'Embed First',
          description: 'Embedding model',
          modality: 'embedding',
          purpose: 'general',
          backend: 'ollama',
          runtime: { backendModelId: 'embed-first', input: ['text'], pinnedByDefault: true, memoryFootprintMb: 512 },
          tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
        },
        ...highTierProfile.availableModels,
      ] as any,
      installedCatalogIds: ['embed-first', 'phi-4-mini'],
    };

    const user = userEvent.setup();
    const { onComplete } = renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    await user.click(screen.getByTestId('ai-continue-btn'));

    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ preferredModelId: 'phi-4-mini' }));
  });

  it('features OpenClaw and Hermes and defaults to the first selected recommended model', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.getByTestId('agent-apps-card')).toBeInTheDocument();
    expect(screen.getByTestId('agent-openclaw')).toBeInTheDocument();
    expect(screen.getByTestId('agent-hermes')).toBeInTheDocument();
    // OpenClaw is the default selection.
    expect(screen.getByTestId('agent-openclaw')).toHaveAttribute('aria-pressed', 'true');

    // The default-model picker is hidden — the agent automatically uses the first selected recommended model.
    expect(screen.queryByTestId('preferred-model-select')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('ai-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ preferredModelId: 'phi-4-mini' }));
  });

  it('links each agent to its available companion apps without changing the selection', async () => {
    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.getByTestId('openclaw-client-ios')).toHaveAttribute(
      'href',
      'https://apps.apple.com/us/app/openclaw-ai-that-does-things/id6780396132',
    );
    expect(screen.getByTestId('openclaw-client-android')).toHaveAttribute('href', 'https://play.google.com/store/apps/details?id=ai.openclaw.app');
    expect(screen.getByTestId('openclaw-client-desktop')).toHaveAttribute('href', 'https://github.com/openclaw/openclaw/releases');
    expect(screen.getByTestId('hermes-client-hermex-for-ios')).toHaveAttribute('href', 'https://apps.apple.com/us/app/hermex/id6767006319');

    await user.click(screen.getByTestId('openclaw-client-ios'));
    expect(screen.getByTestId('agent-openclaw')).toHaveAttribute('aria-pressed', 'true');
  });

  it('lets the user add Hermes as a second agent framework (multi-select)', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    // OpenClaw starts selected; checking Hermes adds it without deselecting OpenClaw.
    await user.click(screen.getByTestId('agent-hermes'));
    expect(screen.getByTestId('agent-hermes')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('agent-openclaw')).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByTestId('ai-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ agentFrameworks: ['openclaw', 'hermes'] }));
  });

  it('lets the user deselect the agent entirely (no agent framework)', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    // OpenClaw is selected by default; clicking it again toggles it off.
    expect(screen.getByTestId('agent-openclaw')).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByTestId('agent-openclaw'));
    expect(screen.getByTestId('agent-openclaw')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('agent-none-hint')).toBeInTheDocument();

    await user.click(screen.getByTestId('ai-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ agentFrameworks: [] }));
  });

  it('defaults to Web access and lets the user add Private VPN', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect((screen.getByTestId('access-cloudflare') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('access-tailscale') as HTMLInputElement).checked).toBe(false);
    // Local-only note is reserved for when every remote option is off.
    expect(screen.queryByTestId('access-local-baseline')).not.toBeInTheDocument();
    expect(screen.queryByTestId('access-this-computer')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('ai-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ exposureMode: 'cloudflare' }));
  });

  it('keeps Web selected by default even when a Cloudflare tunnel is already available', async () => {
    renderStep({ cloudflareAvailable: true });
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect((screen.getByTestId('access-cloudflare') as HTMLInputElement).checked).toBe(true);
  });

  it('shows Tailscale setup inline when Private VPN is selected', async () => {
    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.queryByTestId('tailscale-setup-inline')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('access-tailscale'));
    expect(screen.getByTestId('tailscale-setup-inline')).toBeInTheDocument();
  });

  it('does not clear remote access when all agent harnesses are deselected', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderStep({ cloudflareAvailable: true });
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect((screen.getByTestId('access-cloudflare') as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByTestId('agent-openclaw'));
    expect((screen.getByTestId('access-cloudflare') as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByTestId('ai-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ agentFrameworks: [], exposureMode: 'cloudflare' }));
  });

  it('allows local-only access when remote options are deselected', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderStep({ cloudflareAvailable: true });
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    await user.click(screen.getByTestId('access-cloudflare'));
    expect((screen.getByTestId('access-cloudflare') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('access-local-baseline')).toBeInTheDocument();

    await user.click(screen.getByTestId('ai-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ agentFrameworks: ['openclaw'], exposureMode: 'local' }));
  });

  it('does not restore remote access when re-selecting a harness while another remains selected', async () => {
    const user = userEvent.setup();
    renderStep({ cloudflareAvailable: true });
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    await user.click(screen.getByTestId('agent-hermes'));
    await user.click(screen.getByTestId('access-cloudflare'));
    expect((screen.getByTestId('access-cloudflare') as HTMLInputElement).checked).toBe(false);

    await user.click(screen.getByTestId('agent-openclaw'));
    await user.click(screen.getByTestId('agent-openclaw'));
    expect((screen.getByTestId('access-cloudflare') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('agent-hermes')).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onSkip when Skip button is clicked', async () => {
    const user = userEvent.setup();
    const { onSkip } = renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    await user.click(screen.getByTestId('ai-skip-btn'));
    expect(onSkip).toHaveBeenCalled();
  });

  it('calls onBack when Back button is clicked', async () => {
    const user = userEvent.setup();
    const { onBack } = renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    await user.click(screen.getByTestId('ai-back-btn'));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows resource summary bar when models are selected', async () => {
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.getByTestId('resource-summary')).toBeInTheDocument();
    expect(screen.getByText('1 model selected')).toBeInTheDocument();
  });

  it('neither warns nor blocks when a selection is larger than the free inference memory', async () => {
    const bigModel = {
      id: 'qwen-coder',
      displayName: 'Qwen 2.5 Coder',
      description: 'Coding model',
      modality: 'llm',
      purpose: 'coding',
      backend: 'ollama',
      requirements: { diskMb: 4096 },
      runtime: { backendModelId: 'qwen2.5-coder', input: ['text'], pinnedByDefault: false, memoryFootprintMb: 24000 },
      tiers: { high: 'available', medium: 'available', low: 'unavailable', cpuOnly: 'unavailable' },
    };
    api.profile = {
      ...highTierProfile,
      installedCatalogIds: [],
      recommendedModels: [bigModel] as any,
      availableModels: [bigModel] as any,
      resourceEstimate: {
        totalDiskMb: 4096,
        totalMemoryMb: 24000,
        availableMemoryMb: 4096,
        availableDiskMb: 500000,
        diskTotalMb: 1000000,
      },
    };

    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByTestId('model-checkbox-qwen-coder'));

    // No warning and no block: the selection is judged by disk, and the memory row is a plain
    // gauge of what the engines hold now (4 GB of a 24 GB budget free), not of the selection.
    expect(screen.queryByTestId('resource-memory-warning')).not.toBeInTheDocument();
    expect(screen.queryByTestId('resource-warning')).not.toBeInTheDocument();
    // The fixture's VRAM budget is 24 064 MB with 4 096 MB free.
    expect(screen.getByTestId('resource-memory-summary')).toHaveTextContent(/4\.0 GB inference memory free \/ 23\.5 GB inference memory total/);
  });

  it('does not block when selected models are already installed in Ollama', async () => {
    api.profile = {
      ...highTierProfile,
      installedCatalogIds: ['phi-4-mini', 'qwen-coder'],
      resourceEstimate: {
        totalDiskMb: 6144,
        totalMemoryMb: 6144,
        availableMemoryMb: 2048,
        availableDiskMb: 1024,
        diskTotalMb: 1000000,
      },
    };

    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.queryByTestId('resource-warning')).not.toBeInTheDocument();
    expect(screen.getByTestId('resource-memory-note')).toHaveTextContent(/already in Ollama/i);
  });

  it('shows resource warning when selected models exceed available disk', async () => {
    // The summary bar tracks download size (disk), not RAM: a recommended model larger than the
    // free disk must trip the warning even when there is plenty of memory.
    const bigModel = {
      id: 'phi-4-mini',
      displayName: 'Phi-4 Mini',
      description: 'Small language model',
      modality: 'llm',
      purpose: 'general',
      backend: 'ollama',
      requirements: { diskMb: 60000 },
      runtime: { backendModelId: 'phi4-mini', input: ['text'], pinnedByDefault: true, memoryFootprintMb: 2048 },
      tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
    };
    api.profile = {
      ...highTierProfile,
      installedCatalogIds: [],
      recommendedModels: [bigModel] as any,
      availableModels: [bigModel] as any,
      resourceEstimate: { totalDiskMb: 60000, totalMemoryMb: 2048, availableMemoryMb: 24064, availableDiskMb: 1024, diskTotalMb: 1000000 },
    };
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByTestId('model-checkbox-phi-4-mini'));
    expect(screen.getByTestId('resource-warning')).toBeInTheDocument();
  });

  it('validates cloud API key format in the Advanced step', async () => {
    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.getByTestId('step-section-toggle-7')).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByTestId('step-section-toggle-7'));
    await user.type(screen.getByTestId('cloud-key-openai'), 'invalid-key');
    expect(screen.getByTestId('cloud-error-openai')).toHaveTextContent('should start with "sk-"');
  });

  it('triggers rescan when Rescan button is clicked', async () => {
    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    await user.click(screen.getByTestId('rescan-btn'));
    await waitFor(() => expect(rescanInferenceHardware).toHaveBeenCalled());
  });

  it('shows an error when rescan returns non-OK', async () => {
    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    api.rescanOk = false;
    await user.click(screen.getByTestId('rescan-btn'));
    await waitFor(() => expect(screen.getByTestId('ai-setup-error')).toBeInTheDocument());
    expect(screen.getByText(/Couldn.t complete AI setup/)).toBeInTheDocument();
  });

  it('shows the Ollama setup card when Ollama is not detected on the host', async () => {
    api.ollama = ollamaMissing;
    renderStep();
    await waitFor(() => expect(screen.getByText('Ollama not detected')).toBeInTheDocument());
  });

  it('renders ollama.com as an external link when Ollama is not detected', async () => {
    api.ollama = ollamaMissing;
    renderStep();
    await waitFor(() => expect(screen.getByText('Ollama not detected')).toBeInTheDocument());

    expect(screen.getByRole('link', { name: 'ollama.com' })).toHaveAttribute('href', 'https://ollama.com');
  });

  it('shows bridge-specific guidance when Ollama is installed but unreachable from the Hub container', async () => {
    api.ollama = {
      ...ollamaMissing,
      bridgeUnreachable: true,
      error: 'connect ECONNREFUSED 172.17.0.1:11434',
      hint: 'Ollama may already be installed on this machine, but the Hub container could not connect to it. Ensure the Ollama app is running (check the menu bar), then re-check.',
    };
    renderStep();
    await waitFor(() => expect(screen.getByText('Ollama not reachable from Hub')).toBeInTheDocument());
    expect(screen.getByText(/may already be installed on this machine/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Get Ollama/i })).not.toBeInTheDocument();
  });

  it('shows the firewall command and hides auto-install when the bridge is filtered', async () => {
    api.ollama = {
      ...ollamaMissing,
      bridgeUnreachable: true,
      failureMode: 'filtered',
      error: 'timeout of 5000ms exceeded',
      hint: "The Hub container's packets to 172.17.0.1:11434 are being dropped by ufw — this is a host firewall problem, not a problem with Ollama.",
      remediationCommand: 'sudo ufw allow from 172.18.0.0/16 to 172.17.0.1 port 11434 proto tcp',
    };
    renderStep();
    await waitFor(() => expect(screen.getByText('Ollama not reachable from Hub')).toBeInTheDocument());

    expect(screen.getByTestId('ollama-remediation-command')).toHaveTextContent(
      'sudo ufw allow from 172.18.0.0/16 to 172.17.0.1 port 11434 proto tcp',
    );
    expect(screen.getByText(/not inside the container/i)).toBeInTheDocument();
    // The auto-install button is deliberately NOT asserted here: this suite never
    // stubs window.__TAURI_INTERNALS__, so it is absent regardless of failureMode
    // and the assertion would pass with the guard deleted. That behaviour is
    // covered in ollama-setup-card.test.tsx, which does install a Tauri mock.
  });

  it('surfaces the bridge diagnosis on the profile-failure screen instead of blaming hardware detection', async () => {
    api.profileReject = true;
    api.ollama = {
      ...ollamaMissing,
      bridgeUnreachable: true,
      failureMode: 'filtered',
      hint: 'The Hub container’s packets are being dropped by ufw — this is a host firewall problem.',
      remediationCommand: 'sudo ufw allow from 172.18.0.0/16 to 172.17.0.1 port 11434 proto tcp',
    };
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-error')).toBeInTheDocument());

    expect(screen.getByText(/host firewall problem/i)).toBeInTheDocument();
    expect(screen.getByText(/sudo ufw allow from 172\.18\.0\.0\/16/)).toBeInTheDocument();
  });

  it('disables Continue while Ollama is not reachable', async () => {
    api.ollama = { ...ollamaMissing, error: 'connect ECONNREFUSED' };
    renderStep();
    await waitFor(() => expect(screen.getByText('Ollama not detected')).toBeInTheDocument());
    expect(screen.getByTestId('ai-continue-btn')).toBeDisabled();
    expect(screen.getByText(/isn't installed or running on this machine/i)).toBeInTheDocument();
  });

  it('opens ollama.com when Ollama is not installed', async () => {
    const user = userEvent.setup();
    api.ollama = ollamaMissing;
    renderStep();
    await waitFor(() => expect(screen.getByText('Ollama not detected')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Get Ollama/i }));
    expect(mockOpenExternal).toHaveBeenCalledWith('https://ollama.com');
    expect(screen.getByTestId('hw-card-title')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-setup-error')).not.toBeInTheDocument();
  });
});
