import { render, screen } from '@testing-library/react';
import type { HardwareProfile } from '@ci-hub/common/types';
import { afterEach, describe, expect, it } from 'vitest';
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
