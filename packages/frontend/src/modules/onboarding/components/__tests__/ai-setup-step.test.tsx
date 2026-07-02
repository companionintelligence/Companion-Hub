import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiSetupStep } from '../ai-setup-step';
import type { HardwareProfileResponse } from '../../helpers/ai-setup-types';

const { fetchInferenceOnboardingProfile, fetchOllamaInstallStatus, rescanInferenceHardware } = vi.hoisted(() => ({
  fetchInferenceOnboardingProfile: vi.fn(),
  fetchOllamaInstallStatus: vi.fn(),
  rescanInferenceHardware: vi.fn(),
}));

vi.mock('@/lib/inference/inference-api', () => ({
  fetchInferenceOnboardingProfile,
  fetchOllamaInstallStatus,
  rescanInferenceHardware,
}));

vi.mock('@/components/ui/Skeleton/Skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => <div data-testid="skeleton" className={className} />,
}));

const mockOpenExternal = vi.fn();
vi.mock('@/lib/helpers/open-external', () => ({
  openExternal: (...args: unknown[]) => mockOpenExternal(...args),
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
    displayEndpoint?: string;
    hint?: string;
    error?: string;
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
      rescanOk: true,
    };

    fetchInferenceOnboardingProfile.mockImplementation(() => {
      if (api.profileReject) return Promise.reject(new Error('Network error'));
      if (!api.profileOk) return Promise.reject(new Error('Failed'));
      return Promise.resolve(api.profile);
    });
    fetchOllamaInstallStatus.mockImplementation(() => Promise.resolve(api.ollama));
    rescanInferenceHardware.mockImplementation(async () => {
      if (!api.rescanOk) throw new Error('HTTP 503');
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
    expect(screen.getByText(/Failed to detect hardware/)).toBeInTheDocument();
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

  it('shows host ROCm ready notice when AMD GPU has host ROCm', async () => {
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
    expect(screen.getByTestId('amd-host-rocm-ready')).toBeInTheDocument();
    expect(screen.getByText(/Host ROCm detected/i)).toBeInTheDocument();
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
      backend: 'ollama',
      cloudProviders: [],
      preferredModelId: 'phi-4-mini',
      remoteAccess: [],
      exposureMode: 'local',
      skipped: false,
      installedCatalogIds: ['phi-4-mini'],
      installBlocked: false,
      installBlockReason: undefined,
    });
  });

  it('hides the inference backend selection (Ollama is the only option)', async () => {
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    // The backend picker is hidden — Ollama is implied. The config still defaults to it (see Continue test).
    expect(screen.queryByTestId('backend-option-ollama')).not.toBeInTheDocument();
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
      backend: 'ollama',
      cloudProviders: [],
      preferredModelId: 'phi-4-mini',
      remoteAccess: [],
      exposureMode: 'local',
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

  it('lets the user choose Tailscale or Web remote access for their agent', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect((screen.getByTestId('agent-access-tailscale') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('agent-access-cloudflare') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('agent-access-hint')).toBeInTheDocument();

    await user.click(screen.getByTestId('agent-access-cloudflare'));
    expect((screen.getByTestId('agent-access-cloudflare') as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByTestId('ai-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ exposureMode: 'cloudflare' }));
  });

  it('defaults agent remote access to Web when a Cloudflare tunnel is available', async () => {
    renderStep({ cloudflareAvailable: true });
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect((screen.getByTestId('agent-access-cloudflare') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('agent-access-hint')).not.toBeInTheDocument();
  });

  it('clears remote access when all agent harnesses are deselected', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderStep({ cloudflareAvailable: true });
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect((screen.getByTestId('agent-access-cloudflare') as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByTestId('agent-openclaw'));
    expect((screen.getByTestId('agent-access-cloudflare') as HTMLInputElement).checked).toBe(false);

    await user.click(screen.getByTestId('ai-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ agentFrameworks: [], exposureMode: 'local' }));
  });

  it('restores default remote access when re-selecting a harness from zero', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderStep({ cloudflareAvailable: true });
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    await user.click(screen.getByTestId('agent-openclaw'));
    expect((screen.getByTestId('agent-access-cloudflare') as HTMLInputElement).checked).toBe(false);

    await user.click(screen.getByTestId('agent-openclaw'));
    expect((screen.getByTestId('agent-access-cloudflare') as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByTestId('ai-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ agentFrameworks: ['openclaw'], exposureMode: 'cloudflare' }));
  });

  it('does not restore remote access when re-selecting a harness while another remains selected', async () => {
    const user = userEvent.setup();
    renderStep({ cloudflareAvailable: true });
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    await user.click(screen.getByTestId('agent-hermes'));
    await user.click(screen.getByTestId('agent-access-cloudflare'));
    expect((screen.getByTestId('agent-access-cloudflare') as HTMLInputElement).checked).toBe(false);

    await user.click(screen.getByTestId('agent-openclaw'));
    await user.click(screen.getByTestId('agent-openclaw'));
    expect((screen.getByTestId('agent-access-cloudflare') as HTMLInputElement).checked).toBe(false);
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

  it('warns but does not block when new downloads exceed inference memory', async () => {
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

    expect(screen.getByTestId('resource-memory-warning')).toHaveTextContent(/You can continue/i);
    expect(screen.queryByTestId('resource-warning')).not.toBeInTheDocument();
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

    // Advanced is now a numbered step with the Cloud API Keys shown inline (no accordion).
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
    expect(screen.getByText(/Failed to detect hardware/)).toBeInTheDocument();
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
