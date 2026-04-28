import { act, fireEvent, render, screen } from '@testing-library/react';
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
const { startupEventListeners, mockListen } = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const listenMock = vi.fn(async (eventName: string, callback: (event: { payload: unknown }) => void) => {
    listeners.set(eventName, callback);
    return () => {
      listeners.delete(eventName);
    };
  });
  return {
    startupEventListeners: listeners,
    mockListen: listenMock,
  };
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}));

function emitStartupProgress(payload: unknown) {
  const listener = startupEventListeners.get('hub-startup-progress');
  if (listener) {
    listener({ payload });
  }
}

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

    if (cmd === 'get_startup_progress_command') {
      return null;
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
  startupEventListeners.clear();
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
        case 'start_hub_command':
          return 'Hub started successfully';
        case 'get_startup_progress_command':
          return null;
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
    expect(screen.queryByText('Hub Starting…') ?? screen.queryByText('Hub child')).toBeInTheDocument();
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
        case 'start_hub_command':
          return 'Hub started successfully';
        case 'get_startup_progress_command':
          return null;
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
    expect(screen.queryByText('Hub Starting…') ?? screen.queryByText('Hub child')).toBeInTheDocument();
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

  it('keeps startup UI visible while polling still reports Stopped and renders pull-stage progress updates', async () => {
    vi.useFakeTimers();

    let allowRunning = false;
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
      switch (cmd) {
        case 'get_hub_status_command':
          return allowRunning ? 'Running' : 'Stopped';
        case 'start_hub_command':
          return 'Hub started successfully';
        case 'get_startup_progress_command':
          return null;
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

    await flushAsyncWork();
    expect(screen.getByRole('button', { name: 'Start Hub' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start Hub' }));

    await flushAsyncWork();
    expect(screen.getByText('Hub Starting…')).toBeInTheDocument();

    await act(async () => {
      emitStartupProgress({
        session_id: 'startup-1',
        phase: 'pulling_images',
        status_text: 'Pulling images: ci-hub-db Pulling',
        current_item: 'ci-hub-db',
        attempt: 1,
        terminal_state: null,
      });
    });

    expect(screen.getByText('Pulling images')).toBeInTheDocument();
    expect(screen.getByText('Current item: ci-hub-db')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await flushAsyncWork();

    expect(screen.getByText('Hub Starting…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Hub' })).not.toBeInTheDocument();

    await act(async () => {
      emitStartupProgress({
        session_id: 'startup-1',
        phase: 'completed',
        status_text: 'Hub startup completed successfully.',
        current_item: null,
        attempt: 1,
        terminal_state: 'success',
      });
      allowRunning = true;
      await vi.advanceTimersByTimeAsync(3000);
    });
    await flushAsyncWork();

    expect(screen.getByText('Hub child')).toBeInTheDocument();
  });

  it('transitions to error state when startup emits terminal error progress', async () => {
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
      switch (cmd) {
        case 'get_hub_status_command':
          return 'Stopped';
        case 'start_hub_command':
          return 'Hub started successfully';
        case 'get_startup_progress_command':
          return null;
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

    fireEvent.click(await screen.findByRole('button', { name: 'Start Hub' }));

    await act(async () => {
      emitStartupProgress({
        session_id: 'startup-2',
        phase: 'failed',
        status_text: 'docker compose up -d failed after all retry attempts.',
        current_item: null,
        attempt: 3,
        terminal_state: 'error',
      });
    });

    expect(await screen.findByText('Hub Error')).toBeInTheDocument();
    expect(screen.getByText('docker compose up -d failed after all retry attempts.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart Hub' })).toBeInTheDocument();
  });
});
