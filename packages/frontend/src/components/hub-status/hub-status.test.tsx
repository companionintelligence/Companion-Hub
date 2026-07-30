import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as hubStatusModule from './hub-status';

const { HubStatus, getDockerDesktopGuideContent } = hubStatusModule;

const revalidateMock = vi.fn();

const probeMocks = vi.hoisted(() => {
  const defaultProbe: (configureClient?: boolean) => Promise<number | null> = async () => null;
  return {
    probeHealthyHubApiPort: vi.fn<(configureClient?: boolean) => Promise<number | null>>(),
    defaultProbe,
  };
});

vi.mock('@/lib/tauri-hub-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri-hub-probe')>();
  probeMocks.defaultProbe = actual.probeHealthyHubApiPort;
  probeMocks.probeHealthyHubApiPort.mockImplementation(actual.probeHealthyHubApiPort);
  return {
    ...actual,
    probeHealthyHubApiPort: probeMocks.probeHealthyHubApiPort,
  };
});

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useRevalidator: () => ({ revalidate: revalidateMock, state: 'idle' as const }),
  };
});

vi.mock('@/lib/theme/theme', () => ({
  getLogo: () => '/logo.svg',
}));

beforeEach(() => {
  revalidateMock.mockClear();
  sessionStorage.clear();
  probeMocks.probeHealthyHubApiPort.mockReset();
  probeMocks.probeHealthyHubApiPort.mockImplementation(probeMocks.defaultProbe);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: typeof url === 'string' && url.includes('/api/health'),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    if (cmd === 'check_docker_access_command') {
      return { state: 'daemon_unavailable', detail: 'No container engine found at /var/run/docker.sock' };
    }
    if (cmd === 'is_stack_dev_mode_command') {
      return false;
    }
    if (cmd === 'get_startup_progress_command') {
      return { services: [], progress_pct: 0, image_pulled: 0, image_total: 0, image_pull_pct: 0, all_ready: false };
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
      alreadyInstalledTitle: 'If Docker Desktop is already installed:',
      alreadyInstalledSteps: [
        'Open Docker Desktop from your Start Menu',
        "Wait for Docker to start (you'll see the whale icon in your system tray)",
        'Come back here. The Hub will continue automatically',
      ],
      notInstalledTitle: 'If Docker Desktop is NOT installed:',
      notInstalledSteps: [
        'Download Docker Desktop for Windows',
        'Run the installer and follow the prompts',
        'Restart your computer if prompted',
        'Start Docker Desktop',
        'Come back here. The Hub will start automatically',
      ],
      hint: 'Docker Desktop requires Windows 10/11 with WSL2 enabled. If WSL is installed during setup, restart Windows before reopening CI Hub.',
    });
  });

  it('returns the Apple Silicon Docker Desktop dmg for macOS', () => {
    expect(getDockerDesktopGuideContent('macos', true)).toEqual({
      platformLabel: 'Mac',
      downloadUrl: 'https://desktop.docker.com/mac/main/arm64/Docker.dmg',
      alreadyInstalledTitle: 'If Docker Desktop is already installed:',
      alreadyInstalledSteps: [
        'Open Docker Desktop from your Applications folder',
        "Wait for Docker to start (you'll see the whale icon in your menu bar)",
        'Come back here. The Hub will continue automatically',
      ],
      notInstalledTitle: 'If Docker Desktop is NOT installed:',
      notInstalledSteps: [
        'Download Docker Desktop for Mac',
        'Open the .dmg and drag Docker to Applications',
        'Launch Docker Desktop and grant permissions',
        'Come back here. The Hub will start automatically',
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

    expect(await screen.findByRole('heading', { name: 'Docker Required' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download Docker Desktop for Windows' })).toHaveAttribute(
      'href',
      'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
    );
    expect(screen.getByText(/CI Hub needs a Docker engine/)).toBeInTheDocument();
    expect(screen.getByText('If Docker Desktop is already installed:')).toBeInTheDocument();
    expect(screen.getByText('Open Docker Desktop from your Start Menu')).toBeInTheDocument();
    expect(screen.getByText('If Docker Desktop is NOT installed:')).toBeInTheDocument();
    expect(screen.getByText('Run the installer and follow the prompts')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install Docker Desktop' })).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('get_hub_status_command');
    expect(invoke).not.toHaveBeenCalledWith('install_docker_command');
  });

  it('shows the Apple Silicon macOS download link and no install button', async () => {
    renderWithTauriStatus('DockerNotAvailable', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)', { architecture: 'arm' });

    expect(await screen.findByRole('heading', { name: 'Docker Required' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download Docker Desktop for Mac' })).toHaveAttribute(
      'href',
      'https://desktop.docker.com/mac/main/arm64/Docker.dmg',
    );
    expect(screen.getByText('Open Docker Desktop from your Applications folder')).toBeInTheDocument();
    expect(screen.getByText('Open the .dmg and drag Docker to Applications')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install Docker Desktop' })).not.toBeInTheDocument();
  });

  it('offers the WSL2 Docker Engine alternative on Windows and surfaces the restart state', async () => {
    const { invoke } = renderWithTauriStatus('DockerNotAvailable', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

    expect(await screen.findByText('Licensing-free alternative')).toBeInTheDocument();
    expect(screen.getByText(/paid subscription for organizations/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Auto-Install Docker Engine in WSL2' });

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'install_docker_engine_alternative_command') {
        return { state: 'needs_restart', detail: null };
      }
      if (cmd === 'get_hub_status_command') return 'DockerNotAvailable';
      if (cmd === 'check_docker_access_command') {
        return { state: 'daemon_unavailable', detail: '' };
      }
      return undefined;
    });

    fireEvent.click(button);
    await flushAsyncWork();

    expect(invoke).toHaveBeenCalledWith('install_docker_engine_alternative_command');
    expect(screen.getByText(/Restart Windows, then reopen CI Hub/)).toBeInTheDocument();
  });

  it('offers the Colima alternative on macOS and reports success', async () => {
    const { invoke } = renderWithTauriStatus('DockerNotAvailable', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)', { architecture: 'arm' });

    expect(await screen.findByText('Licensing-free alternative')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Auto-Install Colima' });

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'install_docker_engine_alternative_command') {
        return { state: 'completed', detail: null };
      }
      if (cmd === 'get_hub_status_command') return 'DockerNotAvailable';
      if (cmd === 'check_docker_access_command') {
        return { state: 'daemon_unavailable', detail: '' };
      }
      return undefined;
    });

    fireEvent.click(button);
    await flushAsyncWork();

    expect(invoke).toHaveBeenCalledWith('install_docker_engine_alternative_command');
    expect(screen.getByText(/Docker should become available momentarily/)).toBeInTheDocument();
  });

  it('does not show the alternative panel on Linux (the Engine is already licensing-free)', async () => {
    renderWithTauriStatus('DockerNotAvailable', 'Mozilla/5.0 (X11; Linux x86_64)');

    expect(await screen.findByRole('heading', { name: 'Docker Engine Required' })).toBeInTheDocument();
    expect(screen.queryByText('Licensing-free alternative')).not.toBeInTheDocument();
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
        case 'check_docker_access_command':
          return { state: 'daemon_unavailable', detail: null };
        case 'is_stack_dev_mode_command':
          return false;
        case 'get_startup_progress_command':
          return { services: [], progress_pct: 0, image_pulled: 0, image_total: 0, image_pull_pct: 0, all_ready: false };
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
    expect(screen.getByText('Starting CI Hub')).toBeInTheDocument();
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
        case 'check_docker_access_command':
          return { state: 'available', detail: null };
        case 'is_stack_dev_mode_command':
          return false;
        case 'get_startup_progress_command':
          return { services: [], progress_pct: 0, image_pulled: 0, image_total: 0, image_pull_pct: 0, all_ready: false };
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
    expect(screen.getByText('Starting CI Hub')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Hub' })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await flushAsyncWork();

    expect(screen.getByText('Hub child')).toBeInTheDocument();
  });

  it('does not auto-start the hub on Windows while Tauri is in stack-dev mode', async () => {
    vi.useFakeTimers();

    const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
      switch (cmd) {
        case 'get_hub_status_command':
          return 'Stopped';
        case 'is_stack_dev_mode_command':
          return true;
        case 'check_docker_access_command':
          return { state: 'available', detail: null };
        case 'get_startup_progress_command':
          return { services: [], progress_pct: 0, image_pulled: 0, image_total: 0, image_pull_pct: 0, all_ready: false };
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await flushAsyncWork();

    expect(invoke).not.toHaveBeenCalledWith('start_hub_command');
    expect(screen.getByRole('button', { name: 'Start Hub' })).toBeInTheDocument();
  });

  it('renders the normal app immediately when the hub is already running', async () => {
    renderWithTauriStatus('Running', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

    expect(await screen.findByText('Hub child')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Docker Required' })).not.toBeInTheDocument();
  });
});

describe('HubStatus diagnostics (View Logs / Open Logs Folder)', () => {
  function mockMacTauriWithStatus(statusSequence: string[], extraHandlers: Record<string, () => Promise<unknown>> = {}) {
    let callCount = 0;
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
      if (cmd === 'get_hub_status_command') {
        const status = statusSequence[Math.min(callCount++, statusSequence.length - 1)];
        return status;
      }
      const extraHandler = extraHandlers[cmd];
      if (extraHandler) {
        return extraHandler();
      }
      if (cmd === 'check_docker_access_command') {
        return { state: 'daemon_unavailable', detail: null };
      }
      if (cmd === 'get_startup_progress_command') {
        return { services: [], progress_pct: 0, image_pulled: 0, image_total: 0, image_pull_pct: 0, all_ready: false };
      }
      throw new Error(`Unexpected invoke command: ${cmd}`);
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

    return { invoke };
  }

  it('shows View Logs and Open Logs Folder buttons when the hub is Stopped', async () => {
    mockMacTauriWithStatus(['Stopped']);

    expect(await screen.findByRole('button', { name: 'View Logs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Logs Folder' })).toBeInTheDocument();
  });

  it('keeps a sticky start-failure screen and requires confirm before retry', async () => {
    const rateLimitError = "Docker Hub rate-limited image pulls from this machine's IP (HTTP 429). Wait several minutes.";
    let callCount = 0;
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
      if (cmd === 'get_hub_status_command') {
        callCount += 1;
        // Polling must keep returning Error — not flash back to Stopped.
        return { Error: { message: rateLimitError } };
      }
      if (cmd === 'start_hub_command') {
        return 'Hub started successfully';
      }
      if (cmd === 'check_docker_access_command') {
        return { state: 'available', detail: null };
      }
      if (cmd === 'get_startup_progress_command') {
        return { services: [], progress_pct: 0, image_pulled: 0, image_total: 0, image_pull_pct: 0, all_ready: false };
      }
      throw new Error(`Unexpected invoke command: ${cmd}`);
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

    expect(await screen.findByRole('heading', { name: 'Hub failed to start' })).toBeInTheDocument();
    expect(screen.getByText(/Docker Hub rate-limited/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Hub' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry Start' }));
    expect(screen.getByText(/Retry starting the Hub now/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('start_hub_command');

    fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));
    expect(screen.queryByText(/Retry starting the Hub now/)).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('start_hub_command');

    // Still sticky after more polls would have run
    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('heading', { name: 'Hub failed to start' })).toBeInTheDocument();
  });

  it('View Logs button fetches log content and shows it inline', async () => {
    const fakeLog = 'line1\nline2\nline3';
    const { invoke } = mockMacTauriWithStatus(['Stopped'], {
      read_desktop_logs_command: async () => fakeLog,
    });

    const viewLogsBtn = await screen.findByRole('button', { name: 'View Logs' });
    await act(async () => {
      fireEvent.click(viewLogsBtn);
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith('read_desktop_logs_command');
    expect(await screen.findByText('Recent Logs')).toBeInTheDocument();
    // The <pre> renders raw newline-separated text — check for a specific line.
    expect(screen.getByText(/line1/)).toBeInTheDocument();
  });

  it('hides the log panel when Hide is clicked', async () => {
    mockMacTauriWithStatus(['Stopped'], {
      read_desktop_logs_command: async () => 'some log',
    });

    const viewLogsBtn = await screen.findByRole('button', { name: 'View Logs' });
    await act(async () => {
      fireEvent.click(viewLogsBtn);
      await Promise.resolve();
    });

    expect(await screen.findByRole('button', { name: 'Hide' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    });

    expect(screen.queryByText('Recent Logs')).not.toBeInTheDocument();
  });

  it('renders Hub child immediately when status starts as Running (no prior non-running state)', async () => {
    mockMacTauriWithStatus(['Running']);
    expect(await screen.findByText('Hub child')).toBeInTheDocument();
    // No blocking screens should be shown
    expect(screen.queryByRole('button', { name: 'Start Hub' })).not.toBeInTheDocument();
    expect(screen.queryByText('Starting CI Hub')).not.toBeInTheDocument();
  });

  it('does not reload after a transient Starting blip once the hub is already running', async () => {
    vi.useFakeTimers();
    const reloadSpy = vi.spyOn(hubStatusModule, 'reloadCurrentWindow').mockImplementation(() => {});

    mockMacTauriWithStatus(['Running', 'Starting', 'Running']);

    await flushAsyncWork();
    expect(screen.getByText('Hub child')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await flushAsyncWork();

    expect(screen.getByText('Hub child')).toBeInTheDocument();
    expect(screen.queryByText('Starting CI Hub')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await flushAsyncWork();

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(screen.getByText('Hub child')).toBeInTheDocument();
  });

  it('opens the app when Docker reports Starting but the local API is already healthy', async () => {
    mockMacTauriWithStatus(['Starting']);

    expect(await screen.findByText('Hub child')).toBeInTheDocument();
    expect(screen.queryByText('Starting CI Hub')).not.toBeInTheDocument();
  });

  it('revalidates routes instead of reloading when the user refreshed while the hub was waking up', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem('ci-hub-steady-running', '1');
    const reloadSpy = vi.spyOn(hubStatusModule, 'reloadCurrentWindow').mockImplementation(() => {});
    const navEntry = { type: 'reload' } as PerformanceNavigationTiming;
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([navEntry]);
    probeMocks.probeHealthyHubApiPort.mockResolvedValueOnce(null).mockResolvedValue(5002);

    mockMacTauriWithStatus(['Starting', 'Starting']);

    await flushAsyncWork();
    expect(screen.getByText('Starting CI Hub')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await flushAsyncWork();

    expect(screen.getByText('Hub child')).toBeInTheDocument();
    expect(revalidateMock).toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('isUserInitiatedPageReload returns false when navigation timing is unavailable', () => {
    const original = performance.getEntriesByType;
    Object.defineProperty(performance, 'getEntriesByType', {
      configurable: true,
      value: undefined,
    });

    expect(hubStatusModule.isUserInitiatedPageReload()).toBe(false);

    Object.defineProperty(performance, 'getEntriesByType', {
      configurable: true,
      value: original,
    });
  });
});
