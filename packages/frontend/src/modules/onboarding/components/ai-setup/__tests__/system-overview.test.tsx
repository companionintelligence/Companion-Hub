import { fireEvent, render, screen } from '@testing-library/react';
import type { HardwareProfile } from '@ci-hub/common/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemOverview } from '../system-overview';

const originalUserAgent = navigator.userAgent;
const originalPlatform = navigator.platform;

function setNavigatorPlatform(userAgent: string, platform: string) {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
  Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
}

function makeHardware(gpuOverrides: Partial<HardwareProfile['gpu']> = {}): HardwareProfile {
  return {
    gpu: {
      available: true,
      vendor: 'nvidia',
      model: 'RTX 4090',
      vramMb: 24_576,
      unifiedMemory: false,
      driverVersion: '535',
      // Runtime missing → the setup guidance block renders.
      runtimeAvailable: false,
      ...gpuOverrides,
    },
    npu: { available: false, model: '' },
    ram: { totalMb: 64_000, availableMb: 48_000 },
    cpu: { arch: 'x86_64', cores: 16, model: 'AMD Ryzen 9' },
    effectiveInferenceMemoryMb: 64_000,
    tier: 'high',
  };
}

describe('SystemOverview — NVIDIA runtime-missing guidance', () => {
  afterEach(() => {
    setNavigatorPlatform(originalUserAgent, originalPlatform);
  });

  it('shows in-distro toolkit steps (not "open Docker Desktop") for a Windows WSL2 engine', () => {
    // Windows desktop client, but the daemon is a native WSL2 engine.
    setNavigatorPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32');
    render(<SystemOverview hardware={makeHardware({ containerHostKind: 'wsl-engine' })} tier="high" onRescan={async () => {}} />);

    // Linux-style distro steps are shown, with the WSL-specific note.
    expect(screen.getByText(/Manual install \(distribution-specific\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Docker Engine inside WSL2/i)).toBeInTheDocument();
    // Must NOT tell a WSL2-engine user to open Docker Desktop.
    expect(screen.queryByText(/open Docker Desktop/i)).not.toBeInTheDocument();
  });

  it('shows the Docker Desktop guidance for a Docker Desktop host', () => {
    setNavigatorPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32');
    render(<SystemOverview hardware={makeHardware({ containerHostKind: 'docker-desktop' })} tier="high" onRescan={async () => {}} />);

    expect(screen.getByText(/open Docker Desktop/i)).toBeInTheDocument();
    expect(screen.queryByText(/Docker Engine inside WSL2/i)).not.toBeInTheDocument();
  });
});

describe('SystemOverview: whether the NVIDIA driver answers', () => {
  afterEach(() => {
    setNavigatorPlatform(originalUserAgent, originalPlatform);
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('does not call the GPU ready when the runtime is listed but the driver does not answer', () => {
    render(
      <SystemOverview
        hardware={makeHardware({ runtimeAvailable: true, hostNvidiaAvailable: false, driverVersion: '' })}
        tier="high"
        onRescan={async () => {}}
      />,
    );

    expect(screen.getByTestId('nvidia-driver-warning')).toHaveTextContent("driver isn't answering");
    expect(screen.queryByTestId('nvidia-runtime-ready')).not.toBeInTheDocument();
  });

  it('asks for the driver before the toolkit steps, which can not help without it', () => {
    render(
      <SystemOverview
        hardware={makeHardware({ runtimeAvailable: false, hostNvidiaAvailable: false, driverVersion: '' })}
        tier="high"
        onRescan={async () => {}}
      />,
    );

    expect(screen.getByTestId('nvidia-driver-warning')).toBeInTheDocument();
    expect(screen.queryByTestId('nvidia-runtime-warning')).not.toBeInTheDocument();
  });

  it('keeps the ready message when the driver answers, or on a profile that does not say', () => {
    const { rerender } = render(
      <SystemOverview hardware={makeHardware({ runtimeAvailable: true, hostNvidiaAvailable: true })} tier="high" onRescan={async () => {}} />,
    );
    expect(screen.getByTestId('nvidia-runtime-ready')).toBeInTheDocument();

    rerender(<SystemOverview hardware={makeHardware({ runtimeAvailable: true })} tier="high" onRescan={async () => {}} />);
    expect(screen.getByTestId('nvidia-runtime-ready')).toBeInTheDocument();
  });

  it('offers a Rescan at the end of the steps', () => {
    render(<SystemOverview hardware={makeHardware({ hostNvidiaAvailable: true })} tier="high" onRescan={async () => {}} />);

    expect(screen.getByTestId('nvidia-runtime-warning')).toContainElement(screen.getByTestId('nvidia-rescan-btn'));
  });

  it('on desktop Linux offers the install instead of promising a retry on reopening', () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: async () => null };
    render(
      <SystemOverview
        hardware={makeHardware({ hostNvidiaAvailable: true, containerHostKind: 'native-linux' })}
        tier="high"
        onRescan={async () => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Run this automatically' })).toBeInTheDocument();
    expect(screen.getByTestId('nvidia-runtime-warning')).not.toHaveTextContent('Close and reopen');
    expect(screen.getByTestId('nvidia-runtime-warning')).not.toHaveTextContent('Automatic setup runs during startup');
  });

  it('installs through the desktop app, waits for the Hub to come back, then rescans', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const invoke = vi.fn().mockResolvedValue('NVIDIA container runtime installed.');
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    const health = vi.fn().mockRejectedValueOnce(new TypeError('the Hub is restarting with Docker')).mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', health);
    const onRescan = vi.fn().mockResolvedValue(undefined);
    render(<SystemOverview hardware={makeHardware({ hostNvidiaAvailable: true, containerHostKind: 'native-linux' })} tier="high" onRescan={onRescan} />);

    fireEvent.click(screen.getByRole('button', { name: 'Run this automatically' }));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(onRescan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(7_000);

    expect(invoke).toHaveBeenCalledWith('install_nvidia_runtime_command');
    expect(health).toHaveBeenCalledTimes(2);
    expect(onRescan).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows why the install failed', async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockRejectedValue('Authorization was cancelled or denied.'),
    };
    render(<SystemOverview hardware={makeHardware({ hostNvidiaAvailable: true, containerHostKind: 'native-linux' })} tier="high" onRescan={async () => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Run this automatically' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Authorization was cancelled or denied.');
  });

  it('keeps the retry step in a browser, where cihub up does the setup', () => {
    render(<SystemOverview hardware={makeHardware({ hostNvidiaAvailable: true, containerHostKind: 'native-linux' })} tier="high" onRescan={async () => {}} />);

    expect(screen.getByTestId('nvidia-runtime-warning')).toHaveTextContent('Close and reopen');
  });
});
