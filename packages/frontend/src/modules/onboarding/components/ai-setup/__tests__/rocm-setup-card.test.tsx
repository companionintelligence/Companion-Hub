import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HardwareProfile } from '@ci-hub/common/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RocmSetupCard } from '../rocm-setup-card';

const mockFetchRocmInstallStatus = vi.fn();
const mockRescanInferenceHardware = vi.fn();
const mockSaveRocmInstallState = vi.fn();

vi.mock('@/lib/inference/inference-api', () => ({
  fetchRocmInstallStatus: (...args: unknown[]) => mockFetchRocmInstallStatus(...args),
  rescanInferenceHardware: (...args: unknown[]) => mockRescanInferenceHardware(...args),
  saveRocmInstallState: (...args: unknown[]) => mockSaveRocmInstallState(...args),
}));

const mockOpenExternal = vi.fn();
vi.mock('@/lib/helpers/open-external', () => ({
  openExternal: (...args: unknown[]) => mockOpenExternal(...args),
}));

type TauriWindow = Window & { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } };

const originalUserAgent = navigator.userAgent;
const originalPlatform = navigator.platform;

function setNavigatorPlatform(userAgent: string, platform: string) {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
  Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
}

function installTauriMock(invoke: (cmd: string) => Promise<unknown>) {
  (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
}

function makeHardware(overrides: Partial<HardwareProfile['gpu']> = {}): HardwareProfile {
  return {
    gpu: {
      available: true,
      vendor: 'amd',
      model: 'Radeon 8060S',
      vramMb: 96_000,
      unifiedMemory: true,
      driverVersion: '',
      runtimeAvailable: false,
      hostRocmAvailable: false,
      ...overrides,
    },
    npu: { available: false, model: '' },
    ram: { totalMb: 125_000, availableMb: 115_000 },
    cpu: { arch: 'x86_64', cores: 32, model: 'RYZEN AI MAX+ 395' },
    effectiveInferenceMemoryMb: 125_000,
    tier: 'high',
  };
}

const ubuntuMissingStatus = {
  hostRocmAvailable: false,
  runtimeRocmAvailable: false,
  installPhase: 'idle' as const,
  canAutoInstall: true,
  platformHint: 'linux-ubuntu' as const,
};

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  setNavigatorPlatform(originalUserAgent, originalPlatform);
  vi.clearAllMocks();
});

describe('RocmSetupCard', () => {
  it('hides the card when host ROCm is already available', async () => {
    mockFetchRocmInstallStatus.mockResolvedValue({
      hostRocmAvailable: true,
      hostRocmKfdAvailable: true,
      runtimeRocmAvailable: true,
      installPhase: 'completed',
      canAutoInstall: false,
      platformHint: 'linux-ubuntu',
    });

    const { container } = render(
      <RocmSetupCard hardware={makeHardware({ hostRocmAvailable: true, hostRocmKfdAvailable: true })} onRescan={vi.fn()} />,
    );

    await waitFor(() => expect(mockFetchRocmInstallStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/Host ROCm detected/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('amd-host-rocm-hint')).not.toBeInTheDocument();
  });

  it('hides the card from status when hardware scan is stale but ROCm is ready', async () => {
    mockFetchRocmInstallStatus.mockResolvedValue({
      hostRocmAvailable: true,
      hostRocmKfdAvailable: true,
      runtimeRocmAvailable: true,
      installPhase: 'completed',
      canAutoInstall: false,
      platformHint: 'linux-ubuntu',
    });

    const { container } = render(<RocmSetupCard hardware={makeHardware({ hostRocmAvailable: false })} onRescan={vi.fn()} />);

    await waitFor(() => expect(mockFetchRocmInstallStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/Install ROCm on the host/i)).not.toBeInTheDocument();
  });

  it('shows reboot banner when install phase is reboot_required', async () => {
    mockFetchRocmInstallStatus.mockResolvedValue({
      ...ubuntuMissingStatus,
      installPhase: 'reboot_required',
    });

    render(<RocmSetupCard hardware={makeHardware()} onRescan={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('rocm-reboot-required')).toBeInTheDocument());
    expect(screen.getByTestId('rocm-verify-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('rocm-install-btn')).not.toBeInTheDocument();
  });

  it('invokes install_rocm_command on Ubuntu desktop', async () => {
    setNavigatorPlatform('Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64');
    mockFetchRocmInstallStatus.mockResolvedValue(ubuntuMissingStatus);
    const invoke = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ state: 'reboot_required', detail: null }), 50);
        }),
    );
    installTauriMock(invoke);
    const user = userEvent.setup();

    render(<RocmSetupCard hardware={makeHardware()} onRescan={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('rocm-install-btn')).toBeInTheDocument());
    await user.click(screen.getByTestId('rocm-install-btn'));

    await waitFor(() => expect(screen.getByTestId('rocm-installing')).toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith('install_rocm_command');
  });

  it('shows Windows guidance without an install button', async () => {
    mockFetchRocmInstallStatus.mockResolvedValue({
      ...ubuntuMissingStatus,
      canAutoInstall: false,
      platformHint: 'windows',
    });

    render(<RocmSetupCard hardware={makeHardware()} onRescan={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('rocm-windows-guidance')).toBeInTheDocument());
    expect(screen.queryByTestId('rocm-install-btn')).not.toBeInTheDocument();
  });
});
