import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiSetupStep } from '../ai-setup-step';
import type { HardwareProfileResponse } from '../../helpers/ai-setup-types';

const mockApiFetch = vi.fn();
const mockResponse = <T,>(data: T, ok = true, status = ok ? 200 : 500) => Promise.resolve({ ok, status, json: () => Promise.resolve(data) });

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/components/ui/Skeleton/Skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => <div data-testid="skeleton" className={className} />,
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
  resourceEstimate: { totalDiskMb: 2048, totalMemoryMb: 2048, availableMemoryMb: 24064 },
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
  resourceEstimate: { totalDiskMb: 0, totalMemoryMb: 0, availableMemoryMb: 0 },
};

const ollamaReady = { ready: true, running: true, endpointUrl: 'http://ci-hub-ollama:11434' };
const ollamaMissing = { ready: false, running: false, endpointUrl: 'http://ci-hub-ollama:11434' };

// Mutable API state read by the default mock; tests tweak it before rendering.
let api: {
  profile: HardwareProfileResponse;
  profileOk: boolean;
  profileReject: boolean;
  ollama: { ready: boolean; running: boolean; endpointUrl: string; error?: string };
  rescanOk: boolean;
  install: { success: boolean; message: string };
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
      install: { success: true, message: '' },
    };

    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/inference/onboarding-profile') {
        if (api.profileReject) return Promise.reject(new Error('Network error'));
        return mockResponse(api.profile, api.profileOk);
      }
      if (url === '/api/inference/ollama/status') return mockResponse(api.ollama);
      if (url === '/api/inference/ollama/install') return mockResponse(api.install);
      if (url === '/api/inference/hardware/rescan') return mockResponse({}, api.rescanOk);
      return mockResponse({});
    });
  });

  it('shows loading skeleton while fetching profile', () => {
    mockApiFetch.mockImplementation(() => new Promise(() => {}));
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

  it('shows AMD runtime warning copy when AMD GPU runtime is unavailable', async () => {
    api.profile = {
      ...highTierProfile,
      hardware: {
        ...highTierProfile.hardware,
        gpu: { ...highTierProfile.hardware.gpu, available: true, runtimeAvailable: false, vendor: 'amd', model: 'Radeon RX 7900 XTX' },
      },
    };
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.getByText('Container GPU runtime not available.')).toBeInTheDocument();
    expect(screen.getByText(/Host-side Ollama can still use the GPU/i)).toBeInTheDocument();
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

  it('pre-selects recommended models', async () => {
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect((screen.getByTestId('model-checkbox-phi-4-mini') as HTMLInputElement).checked).toBe(true);
  });

  it('submits only Ollama-backed models with the agent framework and exposure', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    // qwen-coder is not recommended, so it lives in the Advanced "Other Models" drawer, not the grid.
    expect(screen.getByTestId('model-checkbox-phi-4-mini')).toBeInTheDocument();
    expect(screen.getByText(/1 model selected/)).toBeInTheDocument();

    await user.click(screen.getByTestId('ai-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith({
      agentFramework: 'openclaw',
      selectedModels: ['phi-4-mini'],
      backend: 'ollama',
      cloudProviders: [],
      preferredModelId: 'phi-4-mini',
      exposureMode: 'local',
      skipped: false,
    });
  });

  it('shows Ollama as the default backend and disables vLLM and Lemonade', async () => {
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.getByTestId('backend-option-ollama')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('backend-option-vllm')).toBeDisabled();
    expect(screen.getByTestId('backend-option-lemonade')).toBeDisabled();
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
      agentFramework: 'openclaw',
      selectedModels: ['phi-4-mini'],
      backend: 'ollama',
      cloudProviders: [],
      preferredModelId: 'phi-4-mini',
      exposureMode: 'local',
      skipped: false,
    });
  });

  it('features OpenClaw and Hermes and selects a preferred agent model', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.getByTestId('agent-apps-card')).toBeInTheDocument();
    expect(screen.getByTestId('agent-openclaw')).toBeInTheDocument();
    expect(screen.getByTestId('agent-hermes')).toBeInTheDocument();
    // OpenClaw is the default selection.
    expect(screen.getByTestId('agent-openclaw')).toHaveAttribute('aria-pressed', 'true');

    const select = screen.getByTestId('preferred-model-select') as HTMLSelectElement;
    expect(select.value).toBe('phi-4-mini');
    await user.selectOptions(select, 'qwen-coder');
    expect(select.value).toBe('qwen-coder');

    await user.click(screen.getByTestId('ai-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ preferredModelId: 'qwen-coder', selectedModels: expect.arrayContaining(['phi-4-mini', 'qwen-coder']) }),
    );
  });

  it('lets the user switch the agent framework to Hermes', async () => {
    const user = userEvent.setup();
    const { onComplete } = renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    await user.click(screen.getByTestId('agent-hermes'));
    expect(screen.getByTestId('agent-hermes')).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByTestId('ai-continue-btn'));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ agentFramework: 'hermes' }));
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
    expect(screen.getByText(/1 model selected/)).toBeInTheDocument();
  });

  it('shows resource warning when models exceed available memory', async () => {
    api.profile = { ...highTierProfile, resourceEstimate: { totalDiskMb: 2048, totalMemoryMb: 2048, availableMemoryMb: 1024 } };
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.getByTestId('resource-warning')).toBeInTheDocument();
  });

  it('validates cloud API key format in the Advanced drawer', async () => {
    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    // Advanced is open by default; open the Cloud API Keys drawer, then enter an invalid key.
    await user.click(screen.getByTestId('cloud-toggle'));
    await user.type(screen.getByTestId('cloud-key-openai'), 'invalid-key');
    expect(screen.getByTestId('cloud-error-openai')).toHaveTextContent('should start with "sk-"');
  });

  it('triggers rescan when Rescan button is clicked', async () => {
    const user = userEvent.setup();
    renderStep();
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    await user.click(screen.getByTestId('rescan-btn'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/inference/hardware/rescan', expect.objectContaining({ method: 'POST' })));
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

  it('shows the Ollama setup card when the Ollama container is not running', async () => {
    api.ollama = ollamaMissing;
    renderStep();
    await waitFor(() => expect(screen.getByText('Ollama Container Not Running')).toBeInTheDocument());
  });

  it('disables Continue while Ollama is not reachable', async () => {
    api.ollama = { ...ollamaMissing, error: 'connect ECONNREFUSED' };
    renderStep();
    await waitFor(() => expect(screen.getByText('Ollama Container Not Running')).toBeInTheDocument());
    expect(screen.getByTestId('ai-continue-btn')).toBeDisabled();
    expect(screen.getByText(/runs inside the Hub container stack/i)).toBeInTheDocument();
  });

  it('keeps the system overview visible when an Ollama connection check fails', async () => {
    const user = userEvent.setup();
    api.ollama = ollamaMissing;
    api.install = { success: false, message: 'Ollama is managed by the ci-hub-ollama container. Start or restart it and re-check.' };
    renderStep();
    await waitFor(() => expect(screen.getByText('Ollama Container Not Running')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Check Ollama Connection' }));
    await waitFor(() => expect(screen.getByText(api.install.message)).toBeInTheDocument());
    expect(screen.getByTestId('hw-card-title')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-setup-error')).not.toBeInTheDocument();
  });
});
