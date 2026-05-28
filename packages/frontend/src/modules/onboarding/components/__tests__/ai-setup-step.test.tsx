import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiSetupStep } from '../ai-setup-step';
import type { HardwareProfileResponse } from '../../helpers/ai-setup-types';

const mockApiFetch = vi.fn();
const mockResponse = <T,>(data: T, ok = true) =>
  Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(data),
  });

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/components/ui/Skeleton/Skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => <div data-testid="skeleton" className={className} />,
}));

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
      name: 'Phi-4 Mini',
      description: 'Small language model',
      modality: 'text-generation',
      purpose: 'general',
      backend: 'vllm',
      runtime: { backendModelId: 'phi4-mini', input: ['text'], pinnedByDefault: true, memoryFootprintMb: 2048 },
      tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
    },
  ] as any,
  availableModels: [
    {
      id: 'phi-4-mini',
      name: 'Phi-4 Mini',
      description: 'Small language model',
      modality: 'text-generation',
      purpose: 'general',
      backend: 'vllm',
      runtime: { backendModelId: 'phi4-mini', input: ['text'], pinnedByDefault: true, memoryFootprintMb: 2048 },
      tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
    },
    {
      id: 'qwen-coder',
      name: 'Qwen 2.5 Coder',
      description: 'Coding model',
      modality: 'code-generation',
      purpose: 'coding',
      backend: 'vllm',
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
    recommended: 'vllm',
    available: [
      { type: 'ollama', running: true, healthy: true },
      { type: 'vllm', running: false, healthy: false },
    ],
  },
  resourceEstimate: {
    totalDiskMb: 2048,
    totalMemoryMb: 2048,
    availableMemoryMb: 24064,
  },
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

describe('AiSetupStep', () => {
  const onComplete = vi.fn();
  const onSkip = vi.fn();
  const onBack = vi.fn();
  const ollamaReadyStatus = {
    ready: true,
    running: true,
    endpointUrl: 'http://ci-hub-ollama:11434',
  };
  const ollamaMissingStatus = {
    ready: false,
    running: false,
    endpointUrl: 'http://ci-hub-ollama:11434',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window.navigator, 'platform', {
      configurable: true,
      value: 'Linux x86_64',
    });
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (X11; Linux x86_64)',
    });
  });

  it('shows loading skeleton while fetching profile', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {})); // never resolves
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    expect(screen.getByTestId('ai-setup-loading')).toBeInTheDocument();
  });

  it('shows error state when fetch fails', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('Network error'));
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-error')).toBeInTheDocument());
    expect(screen.getByText(/Failed to detect hardware/)).toBeInTheDocument();
  });

  it('renders hardware profile card with tier badge for high-tier hardware', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(highTierProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());
    expect(screen.getByTestId('tier-badge')).toHaveTextContent('High');
    expect(screen.getByTestId('hw-gpu')).toHaveTextContent('RTX 4090');
  });

  it('shows no GPU warning copy when gpu.available is false', async () => {
    const noGpuProfile: HardwareProfileResponse = {
      ...highTierProfile,
      hardware: {
        ...highTierProfile.hardware,
        gpu: {
          ...highTierProfile.hardware.gpu,
          available: false,
          model: '',
          runtimeAvailable: false,
          vendor: 'none',
          vramMb: 0,
        },
      },
    };

    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(noGpuProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.getByText('No GPU detected.')).toBeInTheDocument();
    expect(screen.getByText(/AI services will run on CPU only/)).toBeInTheDocument();
  });

  it('shows NVIDIA runtime setup guidance when NVIDIA GPU runtime is unavailable', async () => {
    const noRuntimeProfile: HardwareProfileResponse = {
      ...highTierProfile,
      hardware: {
        ...highTierProfile.hardware,
        gpu: {
          ...highTierProfile.hardware.gpu,
          available: true,
          runtimeAvailable: false,
          vendor: 'nvidia',
        },
      },
    };

    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(noRuntimeProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.getByTestId('nvidia-runtime-warning')).toBeInTheDocument();
    expect(screen.getByText(/NVIDIA GPU detected, but the container GPU runtime is not ready yet/i)).toBeInTheDocument();
  });

  it('shows AMD runtime warning copy when AMD GPU runtime is unavailable', async () => {
    const noRuntimeProfile: HardwareProfileResponse = {
      ...highTierProfile,
      hardware: {
        ...highTierProfile.hardware,
        gpu: {
          ...highTierProfile.hardware.gpu,
          available: true,
          runtimeAvailable: false,
          vendor: 'amd',
          model: 'Radeon RX 7900 XTX',
        },
      },
    };

    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(noRuntimeProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.getByText('Container GPU runtime not available.')).toBeInTheDocument();
    expect(screen.getByText(/containerized backends do not have ROCm access yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Host-side Ollama can still use the GPU/i)).toBeInTheDocument();
  });

  it('pre-selects recommended models', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(highTierProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    const checkbox = screen.getByTestId('model-checkbox-phi-4-mini') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('only pre-selects and submits models for the selected backend', async () => {
    const mixedBackendProfile: HardwareProfileResponse = {
      ...highTierProfile,
      backends: {
        recommended: 'ollama',
        available: [
          { type: 'ollama', running: true, healthy: true },
          { type: 'lemonade', running: true, healthy: true },
        ],
      },
      recommendedModels: [
        {
          id: 'phi-4-mini',
          name: 'Phi-4 Mini',
          description: 'Small language model',
          modality: 'text-generation',
          purpose: 'general',
          backend: 'ollama',
          runtime: { backendModelId: 'phi4-mini', input: ['text'], pinnedByDefault: true, memoryFootprintMb: 2048 },
          tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
        } as any,
        {
          id: 'whisper-base',
          name: 'Whisper Base',
          description: 'Speech-to-text',
          modality: 'stt',
          purpose: 'transcription',
          backend: 'lemonade',
          runtime: { backendModelId: 'whisper-base', input: ['audio'], pinnedByDefault: false, memoryFootprintMb: 200 },
          tiers: { high: 'recommended', medium: 'recommended', low: 'recommended', cpuOnly: 'recommended' },
        } as any,
      ],
      availableModels: [
        {
          id: 'phi-4-mini',
          name: 'Phi-4 Mini',
          description: 'Small language model',
          modality: 'text-generation',
          purpose: 'general',
          backend: 'ollama',
          runtime: { backendModelId: 'phi4-mini', input: ['text'], pinnedByDefault: true, memoryFootprintMb: 2048 },
          tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
        } as any,
        {
          id: 'whisper-base',
          name: 'Whisper Base',
          description: 'Speech-to-text',
          modality: 'stt',
          purpose: 'transcription',
          backend: 'lemonade',
          runtime: { backendModelId: 'whisper-base', input: ['audio'], pinnedByDefault: false, memoryFootprintMb: 200 },
          tiers: { high: 'recommended', medium: 'recommended', low: 'recommended', cpuOnly: 'recommended' },
        } as any,
      ],
    };

    const user = userEvent.setup();
    mockApiFetch.mockImplementationOnce(() => mockResponse(mixedBackendProfile)).mockImplementationOnce(() => mockResponse(ollamaReadyStatus));

    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.getByText(/1 model selected/)).toBeInTheDocument();
    expect(screen.queryByTestId('model-row-whisper-base')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('ai-continue-btn'));

    expect(onComplete).toHaveBeenCalledWith({
      selectedModels: ['phi-4-mini'],
      backend: 'ollama',
      cloudProviders: [],
      skipped: false,
    });
  });

  it('resets model recommendations when switching backends', async () => {
    const mixedBackendProfile: HardwareProfileResponse = {
      ...highTierProfile,
      backends: {
        recommended: 'ollama',
        available: [
          { type: 'ollama', running: true, healthy: true },
          { type: 'lemonade', running: true, healthy: true },
        ],
      },
      recommendedModels: [
        {
          id: 'phi-4-mini',
          name: 'Phi-4 Mini',
          description: 'Small language model',
          modality: 'text-generation',
          purpose: 'general',
          backend: 'ollama',
          runtime: { backendModelId: 'phi4-mini', input: ['text'], pinnedByDefault: true, memoryFootprintMb: 2048 },
          tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
        } as any,
        {
          id: 'whisper-base',
          name: 'Whisper Base',
          description: 'Speech-to-text',
          modality: 'stt',
          purpose: 'transcription',
          backend: 'lemonade',
          runtime: { backendModelId: 'whisper-base', input: ['audio'], pinnedByDefault: false, memoryFootprintMb: 200 },
          tiers: { high: 'recommended', medium: 'recommended', low: 'recommended', cpuOnly: 'recommended' },
        } as any,
      ],
      availableModels: [
        {
          id: 'phi-4-mini',
          name: 'Phi-4 Mini',
          description: 'Small language model',
          modality: 'text-generation',
          purpose: 'general',
          backend: 'ollama',
          runtime: { backendModelId: 'phi4-mini', input: ['text'], pinnedByDefault: true, memoryFootprintMb: 2048 },
          tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
        } as any,
        {
          id: 'whisper-base',
          name: 'Whisper Base',
          description: 'Speech-to-text',
          modality: 'stt',
          purpose: 'transcription',
          backend: 'lemonade',
          runtime: { backendModelId: 'whisper-base', input: ['audio'], pinnedByDefault: false, memoryFootprintMb: 200 },
          tiers: { high: 'recommended', medium: 'recommended', low: 'recommended', cpuOnly: 'recommended' },
        } as any,
      ],
    };

    const user = userEvent.setup();
    mockApiFetch.mockImplementationOnce(() => mockResponse(mixedBackendProfile)).mockImplementationOnce(() => mockResponse(ollamaReadyStatus));

    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    await user.click(screen.getByTestId('backend-option-lemonade'));

    expect(screen.queryByTestId('model-row-phi-4-mini')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-row-whisper-base')).toBeInTheDocument();
    expect(screen.getByText(/1 model selected/)).toBeInTheDocument();
  });

  it('allows toggling model selection', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(highTierProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    const checkbox = screen.getByTestId('model-checkbox-phi-4-mini') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);
    await user.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });

  it('hides model selection when tier is insufficient', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(insufficientProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.queryByTestId('model-card-title')).not.toBeInTheDocument();
    expect(screen.queryByTestId('backend-card-title')).not.toBeInTheDocument();
  });

  it('shows cloud provider inputs prominently when tier is insufficient', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(insufficientProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.getByTestId('cloud-inputs')).toBeInTheDocument();
    expect(screen.getByText(/can't run local AI models/)).toBeInTheDocument();
  });

  it('shows "Continue without AI" when insufficient and no cloud key entered', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(insufficientProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.getByTestId('ai-continue-btn')).toHaveTextContent('Continue without AI');
  });

  it('calls onComplete with config when Continue is clicked', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(highTierProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    await user.click(screen.getByTestId('ai-continue-btn'));

    expect(onComplete).toHaveBeenCalledWith({
      selectedModels: ['phi-4-mini'],
      backend: 'vllm',
      cloudProviders: [],
      skipped: false,
    });
  });

  it('calls onSkip when Skip button is clicked', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(highTierProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    await user.click(screen.getByTestId('ai-skip-btn'));
    expect(onSkip).toHaveBeenCalled();
  });

  it('calls onBack when Back button is clicked', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(highTierProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    await user.click(screen.getByTestId('ai-back-btn'));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows resource summary bar when models are selected', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(highTierProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.getByTestId('resource-summary')).toBeInTheDocument();
    expect(screen.getByText(/1 model selected/)).toBeInTheDocument();
  });

  it('shows resource warning when models exceed available memory', async () => {
    const overBudgetProfile = {
      ...highTierProfile,
      resourceEstimate: { totalDiskMb: 2048, totalMemoryMb: 2048, availableMemoryMb: 1024 },
    };
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(overBudgetProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    expect(screen.getByTestId('resource-warning')).toBeInTheDocument();
  });

  it('validates cloud API key format', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(highTierProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    // Expand cloud section
    await user.click(screen.getByTestId('cloud-toggle'));

    // Enter invalid OpenAI key
    const openaiInput = screen.getByTestId('cloud-key-openai');
    await user.type(openaiInput, 'invalid-key');

    expect(screen.getByTestId('cloud-error-openai')).toHaveTextContent('should start with "sk-"');
  });

  it('triggers rescan when Rescan button is clicked', async () => {
    const user = userEvent.setup();
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(highTierProfile) }) // initial fetch
      .mockResolvedValueOnce({ ok: true }) // rescan POST
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(highTierProfile) }); // re-fetch

    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    await user.click(screen.getByTestId('rescan-btn'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/inference/hardware/rescan', expect.objectContaining({ method: 'POST' }));
    });
  });

  it('shows rescan error and skips profile refresh when rescan returns non-OK', async () => {
    const user = userEvent.setup();
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(highTierProfile) }) // initial profile fetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(ollamaReadyStatus) }) // ollama status
      .mockResolvedValueOnce({ ok: false, status: 503 }); // rescan POST failure

    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    await user.click(screen.getByTestId('rescan-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('ai-setup-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/Failed to detect hardware: HTTP 503/)).toBeInTheDocument();

    const profileCalls = mockApiFetch.mock.calls.filter(([url]) => url === '/api/inference/onboarding-profile');
    expect(profileCalls).toHaveLength(1);
  });

  it('shows generic non-Linux NVIDIA guidance without Linux shell commands', async () => {
    const runtimeMissingProfile: HardwareProfileResponse = {
      ...highTierProfile,
      hardware: {
        ...highTierProfile.hardware,
        gpu: {
          ...highTierProfile.hardware.gpu,
          runtimeAvailable: false,
        },
      },
    };

    const platformDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
    Object.defineProperty(window.navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });

    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(runtimeMissingProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);

    await waitFor(() => expect(screen.getByTestId('nvidia-runtime-warning')).toBeInTheDocument());
    expect(screen.getByText(/Docker Desktop and confirm WSL2 GPU support is enabled/i)).toBeInTheDocument();
    expect(screen.queryByText(/sudo apt-get update/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sudo systemctl restart docker/i)).not.toBeInTheDocument();

    if (platformDescriptor) {
      Object.defineProperty(window.navigator, 'platform', platformDescriptor);
    }
  });

  it('shows Ollama setup card when Ollama backend is selected and container is not running', async () => {
    const ollamaProfile = {
      ...highTierProfile,
      backends: {
        recommended: 'ollama',
        available: highTierProfile.backends.available,
      },
    };

    mockApiFetch.mockImplementationOnce(() => mockResponse(ollamaProfile)).mockImplementationOnce(() => mockResponse(ollamaMissingStatus));

    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);

    await waitFor(() => {
      expect(screen.getByText('Ollama Container Not Running')).toBeInTheDocument();
    });
  });

  it('disables Continue while Ollama is not reachable', async () => {
    const ollamaProfile = {
      ...highTierProfile,
      backends: {
        recommended: 'ollama',
        available: highTierProfile.backends.available,
      },
    };

    mockApiFetch
      .mockImplementationOnce(() => mockResponse(ollamaProfile))
      .mockImplementationOnce(() =>
        mockResponse({
          ready: false,
          running: false,
          endpointUrl: 'http://ci-hub-ollama:11434',
          error: 'connect ECONNREFUSED',
        }),
      );

    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);

    await waitFor(() => expect(screen.getByText('Ollama Container Not Running')).toBeInTheDocument());
    expect(screen.getByTestId('ai-continue-btn')).toBeDisabled();
    expect(screen.getByText(/runs inside the Hub container stack/i)).toBeInTheDocument();
  });

  it('shows container-first setup guidance when Ollama container is not running', async () => {
    const ollamaProfile = {
      ...highTierProfile,
      backends: {
        recommended: 'ollama',
        available: highTierProfile.backends.available,
      },
    };

    mockApiFetch.mockImplementationOnce(() => mockResponse(ollamaProfile)).mockImplementationOnce(() => mockResponse(ollamaMissingStatus));

    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);

    await waitFor(() => expect(screen.getByText('Ollama Container Not Running')).toBeInTheDocument());
    expect(screen.getByText(/runs inside the Hub container stack/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check Ollama Connection' })).toBeInTheDocument();
  });

  it('keeps the hardware profile visible when Ollama installation fails', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window.navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });

    const ollamaProfile = {
      ...highTierProfile,
      backends: {
        recommended: 'ollama',
        available: highTierProfile.backends.available,
      },
    };

    const containerFailureMessage =
      'Ollama is managed by the ci-hub-ollama container. Start or restart that container and re-check http://ci-hub-ollama:11434.';

    mockApiFetch
      .mockImplementationOnce(() => mockResponse(ollamaProfile))
      .mockImplementationOnce(() => mockResponse(ollamaMissingStatus))
      .mockImplementationOnce(() => mockResponse({ success: false, message: containerFailureMessage }));

    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);

    await waitFor(() => expect(screen.getByText('Ollama Container Not Running')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Check Ollama Connection' }));

    await waitFor(() => {
      expect(screen.getByText(containerFailureMessage)).toBeInTheDocument();
    });
    expect(screen.getByTestId('hw-card-title')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-setup-error')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check Ollama Connection' })).toBeInTheDocument();
  });
});
