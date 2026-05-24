import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiSetupStep } from '../ai-setup-step';
import type { HardwareProfileResponse } from '../../helpers/ai-setup-types';

const mockApiFetch = vi.fn();

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
      backend: 'ollama',
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
      backend: 'ollama',
      runtime: { backendModelId: 'phi4-mini', input: ['text'], pinnedByDefault: true, memoryFootprintMb: 2048 },
      tiers: { high: 'recommended', medium: 'recommended', low: 'available', cpuOnly: 'available' },
    },
    {
      id: 'qwen-coder',
      name: 'Qwen 2.5 Coder',
      description: 'Coding model',
      modality: 'code-generation',
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

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('pre-selects recommended models', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(highTierProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    const checkbox = screen.getByTestId('model-checkbox-phi-4-mini') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
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

  it('highlights OpenClaude and Hermes before other AI services', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(highTierProfile) });
    render(<AiSetupStep onComplete={onComplete} onSkip={onSkip} onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ai-setup-step')).toBeInTheDocument());

    await user.click(screen.getByTestId('cloud-toggle'));

    expect(screen.getByText('OpenClaude')).toBeInTheDocument();
    expect(screen.getByText('Hermes')).toBeInTheDocument();
    expect(screen.queryByTestId('cloud-provider-google')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('other-services-toggle'));
    expect(screen.getByTestId('cloud-provider-google')).toBeInTheDocument();
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
});
