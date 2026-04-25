import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubStatus, getDockerDesktopGuideContent } from './hub-status';

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> };
};

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: { architecture?: string };
};

const tauriWindow = window as TauriWindow;
const navigatorWithUserAgentData = window.navigator as NavigatorWithUserAgentData;
const originalUserAgent = navigator.userAgent;
const originalUserAgentData = navigatorWithUserAgentData.userAgentData;

function setUserAgent(userAgent: string, userAgentData?: { architecture?: string }) {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: userAgent,
    configurable: true,
  });

  if (userAgentData === undefined) {
    delete navigatorWithUserAgentData.userAgentData;
    return;
  }

  Object.defineProperty(window.navigator, 'userAgentData', {
    value: userAgentData,
    configurable: true,
  });
}

function restoreNavigator() {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: originalUserAgent,
    configurable: true,
  });

  if (originalUserAgentData === undefined) {
    delete navigatorWithUserAgentData.userAgentData;
    return;
  }

  Object.defineProperty(window.navigator, 'userAgentData', {
    value: originalUserAgentData,
    configurable: true,
  });
}

function renderWithTauriStatus(status: 'DockerNotAvailable' | 'Stopped' | 'Running', userAgent: string, userAgentData?: { architecture?: string }) {
  const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
    if (cmd === 'get_hub_status_command') {
      return status;
    }
    if (cmd === 'get_startup_phase_command') {
      return { status, phase: 'test phase', services: [] };
    }

    throw new Error(`Unexpected invoke command: ${cmd}`);
  });

  setUserAgent(userAgent, userAgentData);
  Object.defineProperty(tauriWindow, '__TAURI_INTERNALS__', {
    value: { invoke },
    configurable: true,
  });

  render(
    <HubStatus>
      <div>Hub child</div>
    </HubStatus>,
  );

  return { invoke };
}

function mockWindowsTauri(invoke: (cmd: string) => Promise<unknown>) {
  setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  Object.defineProperty(tauriWindow, '__TAURI_INTERNALS__', {
    value: { invoke },
    configurable: true,
  });
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  delete tauriWindow.__TAURI_INTERNALS__;
  restoreNavigator();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('getDockerDesktopGuideContent', () => {
  it('returns the Windows Docker Desktop installer guide', () => {
    expect(getDockerDesktopGuideContent('windows', false)).toEqual({
      platformLabel: 'Windows',
      downloadUrl: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
      manualSteps: [
        'Download Docker Desktop for Windows',
        'Run the installer and follow the prompts',
        'Restart your computer if prompted',
        'Start Docker Desktop',
        'Come back here — the Hub will start automatically',
      ],
      hint: 'Docker Desktop requires Windows 10/11 with WSL2 enabled. If WSL is installed during setup, restart Windows before reopening Companion Hub.',
    });
  });

  it('returns the Apple Silicon Docker Desktop dmg for macOS', () => {
    expect(getDockerDesktopGuideContent('macos', true)).toEqual({
      platformLabel: 'Mac',
      downloadUrl: 'https://desktop.docker.com/mac/main/arm64/Docker.dmg',
      manualSteps: [
        'Download Docker Desktop for Mac',
        'Open the .dmg and drag Docker to Applications',
        'Launch Docker Desktop and grant permissions',
        'Come back here — the Hub will start automatically',
      ],
    });
  });

  it('returns the Intel Docker Desktop dmg for macOS', () => {
    expect(getDockerDesktopGuideContent('macos', false).downloadUrl).toBe('https://desktop.docker.com/mac/main/amd64/Docker.dmg');
  });
});

describe('HubStatus Docker guidance', () => {
  it('shows Windows manual guidance with a direct download link and no install button', async () => {
    const { invoke } = renderWithTauriStatus('DockerNotAvailable', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

    expect(await screen.findByRole('heading', { name: 'Docker Desktop Required' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download Docker Desktop for Windows' })).toHaveAttribute(
      'href',
      'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
    );
    expect(
      screen.getByText(
        'Download Docker Desktop for your Windows machine. Companion Hub will keep checking and continue automatically once Docker is ready.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Run the installer and follow the prompts')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install Docker Desktop' })).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('get_hub_status_command');
    expect(invoke).not.toHaveBeenCalledWith('install_docker_command');
  });

  it('shows the Apple Silicon macOS download link and no install button', async () => {
    renderWithTauriStatus('DockerNotAvailable', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)', { architecture: 'arm' });

    expect(await screen.findByRole('heading', { name: 'Docker Desktop Required' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download Docker Desktop for Mac' })).toHaveAttribute(
      'href',
      'https://desktop.docker.com/mac/main/arm64/Docker.dmg',
    );
    expect(screen.getByText('Open the .dmg and drag Docker to Applications')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install Docker Desktop' })).not.toBeInTheDocument();
  });

  it('shows Linux manual guidance and docs only, with no install button', async () => {
    renderWithTauriStatus('DockerNotAvailable', 'Mozilla/5.0 (X11; Linux x86_64)');

    expect(await screen.findByRole('heading', { name: 'Docker Engine Required' })).toBeInTheDocument();
    expect(screen.getByText('curl -fsSL https://get.docker.com | sh')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View Docker Install Guide' })).toHaveAttribute('href', 'https://docs.docker.com/engine/install/');
    expect(screen.queryByRole('button', { name: 'Install Docker' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install Docker Desktop' })).not.toBeInTheDocument();
  });

  it('auto-starts the hub on Windows once Docker becomes available while the app stays open', async () => {
    vi.useFakeTimers();

    let getHubStatusCallCount = 0;
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
      switch (cmd) {
        case 'get_hub_status_command':
          getHubStatusCallCount += 1;
          if (getHubStatusCallCount === 1) return 'DockerNotAvailable';
          if (getHubStatusCallCount === 2) return 'Stopped';
          return 'Running';
        case 'get_startup_phase_command':
          return { status: 'Starting', phase: 'Waiting for health checks', services: [] };
        case 'start_hub_command':
          return 'Hub started successfully';
        default:
          throw new Error(`Unexpected invoke command: ${cmd}`);
      }
    });

    mockWindowsTauri(invoke);

    render(
      <HubStatus>
        <div>Hub child</div>
      </HubStatus>,
    );

    await flushAsyncWork();
    expect(screen.getByRole('link', { name: 'Download Docker Desktop for Windows' })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await flushAsyncWork();

    expect(invoke).toHaveBeenCalledWith('start_hub_command');
    expect(screen.getByText('Hub Starting…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Hub' })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await flushAsyncWork();

    expect(screen.getByText('Hub child')).toBeInTheDocument();
  });

  it('auto-starts the hub on Windows when Docker is already available but the hub is stopped', async () => {
    vi.useFakeTimers();

    let getHubStatusCallCount = 0;
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
      switch (cmd) {
        case 'get_hub_status_command':
          getHubStatusCallCount += 1;
          return getHubStatusCallCount === 1 ? 'Stopped' : 'Running';
        case 'get_startup_phase_command':
          return { status: 'Stopped', phase: 'No containers found', services: [] };
        case 'start_hub_command':
          return 'Hub started successfully';
        default:
          throw new Error(`Unexpected invoke command: ${cmd}`);
      }
    });

    mockWindowsTauri(invoke);

    render(
      <HubStatus>
        <div>Hub child</div>
      </HubStatus>,
    );

    await flushAsyncWork();

    expect(invoke).toHaveBeenCalledWith('start_hub_command');
    expect(screen.getByText('Hub Starting…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Hub' })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await flushAsyncWork();

    expect(screen.getByText('Hub child')).toBeInTheDocument();
  });

  it('renders the normal app immediately when the hub is already running', async () => {
    renderWithTauriStatus('Running', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

    expect(await screen.findByText('Hub child')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Docker Desktop Required' })).not.toBeInTheDocument();
  });
});

describe('HubStatus startup phase and diagnostics', () => {
  it('shows phase-level progress during startup with service health', async () => {
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
      switch (cmd) {
        case 'get_hub_status_command':
          return 'Starting';
        case 'get_startup_phase_command':
          return {
            status: 'Starting',
            phase: 'Waiting for health checks: ci-os-hub',
            services: [
              { name: 'ci-hub-db', state: 'running', health: 'healthy' },
              { name: 'ci-os-hub', state: 'running', health: 'starting' },
            ],
          };
        default:
          throw new Error(`Unexpected invoke command: ${cmd}`);
      }
    });

    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)');
    Object.defineProperty(tauriWindow, '__TAURI_INTERNALS__', {
      value: { invoke },
      configurable: true,
    });

    render(
      <HubStatus>
        <div>Hub child</div>
      </HubStatus>,
    );

    expect(await screen.findByText('Hub Starting…')).toBeInTheDocument();
    expect(screen.getByText('Waiting for health checks: ci-os-hub')).toBeInTheDocument();
    expect(screen.getByText('ci-hub-db')).toBeInTheDocument();
    expect(screen.getByText('ci-os-hub')).toBeInTheDocument();
    expect(screen.getByText('healthy')).toBeInTheDocument();
    expect(screen.getByText('starting')).toBeInTheDocument();
  });

  it('shows View Logs and Open Logs Folder buttons during startup', async () => {
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
      switch (cmd) {
        case 'get_hub_status_command':
          return 'Starting';
        case 'get_startup_phase_command':
          return { status: 'Starting', phase: 'Waiting to start', services: [] };
        default:
          throw new Error(`Unexpected invoke command: ${cmd}`);
      }
    });

    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)');
    Object.defineProperty(tauriWindow, '__TAURI_INTERNALS__', {
      value: { invoke },
      configurable: true,
    });

    render(
      <HubStatus>
        <div>Hub child</div>
      </HubStatus>,
    );

    expect(await screen.findByText('Hub Starting…')).toBeInTheDocument();
    expect(screen.getByText('View Logs')).toBeInTheDocument();
    expect(screen.getByText('Open Logs Folder')).toBeInTheDocument();
  });

  it('shows View Logs and Open Logs Folder buttons on error state', async () => {
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
      switch (cmd) {
        case 'get_hub_status_command':
          return { Error: { message: 'Hub crashed' } };
        case 'get_startup_phase_command':
          return { status: { Error: { message: 'Hub crashed' } }, phase: 'Hub crashed', services: [] };
        default:
          throw new Error(`Unexpected invoke command: ${cmd}`);
      }
    });

    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)');
    Object.defineProperty(tauriWindow, '__TAURI_INTERNALS__', {
      value: { invoke },
      configurable: true,
    });

    render(
      <HubStatus>
        <div>Hub child</div>
      </HubStatus>,
    );

    expect(await screen.findByText('Hub Error')).toBeInTheDocument();
    expect(screen.getAllByText('Hub crashed')).toHaveLength(2); // error message + phase detail
    expect(screen.getByText('View Logs')).toBeInTheDocument();
    expect(screen.getByText('Open Logs Folder')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart Hub' })).toBeInTheDocument();
  });
});
