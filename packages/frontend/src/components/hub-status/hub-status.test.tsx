import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

// HubStatus uses useRevalidator, and (via useAppIntentDeepLinks) useNavigate.
// These tests render it without a Router, so stub both here.
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useRevalidator: () => ({ revalidate: revalidateMock, state: 'idle' as const }),
    useNavigate: () => vi.fn(),
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
      await vi.advanceTimersByTimeAsync(5000);
    });
    await flushAsyncWork();

    expect(invoke).toHaveBeenCalledWith('start_hub_command');
    expect(screen.getByText('Starting CI Hub')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Hub' })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
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
      await vi.advanceTimersByTimeAsync(5000);
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
      await vi.advanceTimersByTimeAsync(5000);
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

describe('HubStatus steady running and recovery', () => {
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
      await vi.advanceTimersByTimeAsync(5000);
    });
    await flushAsyncWork();

    expect(screen.getByText('Hub child')).toBeInTheDocument();
    expect(screen.queryByText('Starting CI Hub')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
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

  it('keeps the app mounted across a brief API probe miss after the hub is steady', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem('ci-hub-steady-running', '1');
    const reloadSpy = vi.spyOn(hubStatusModule, 'reloadCurrentWindow').mockImplementation(() => {});
    probeMocks.probeHealthyHubApiPort.mockResolvedValueOnce(null).mockResolvedValue(5002);

    mockMacTauriWithStatus(['Running', 'Running']);

    await flushAsyncWork();
    expect(screen.getByText('Hub child')).toBeInTheDocument();
    expect(screen.queryByText('Starting CI Hub')).not.toBeInTheDocument();
    expect(reloadSpy).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await flushAsyncWork();

    expect(screen.getByText('Hub child')).toBeInTheDocument();
    expect(screen.queryByText('Starting CI Hub')).not.toBeInTheDocument();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('keeps the app mounted through sustained probe misses while Docker reports Starting', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem('ci-hub-steady-running', '1');
    const reloadSpy = vi.spyOn(hubStatusModule, 'reloadCurrentWindow').mockImplementation(() => {});
    probeMocks.probeHealthyHubApiPort.mockResolvedValue(null);

    mockMacTauriWithStatus(['Starting', 'Starting', 'Starting', 'Starting']);

    await flushAsyncWork();
    expect(screen.getByText('Hub child')).toBeInTheDocument();
    expect(screen.queryByText('Starting CI Hub')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    await flushAsyncWork();

    expect(screen.getByText('Hub child')).toBeInTheDocument();
    expect(screen.queryByText('Starting CI Hub')).not.toBeInTheDocument();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('revalidates routes after the hub becomes healthy without a full window reload', async () => {
    vi.useFakeTimers();
    const reloadSpy = vi.spyOn(hubStatusModule, 'reloadCurrentWindow').mockImplementation(() => {});
    probeMocks.probeHealthyHubApiPort.mockResolvedValue(null);

    mockMacTauriWithStatus(['Stopped', 'Running']);

    await flushAsyncWork();
    expect(screen.getByRole('heading', { name: "CI Hub isn't running" })).toBeInTheDocument();

    probeMocks.probeHealthyHubApiPort.mockResolvedValue(5002);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
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

// ─── Startup screens: starting, stuck, stopped, couldn't start ───────────────

type TestServiceState = 'pending' | 'starting' | 'ready' | 'failed' | 'stopped' | 'not_started';

const CORE_SERVICES = [
  ['Database', 'ci-hub-db'],
  ['Message queue', 'ci-hub-queue'],
  ['Hub backend', 'ci-hub'],
  ['Router', 'traefik'],
] as const;

/** The four core rows in order, as the current desktop shell reports them. */
function coreServices(states: TestServiceState[], extra: Record<string, Record<string, unknown>> = {}) {
  return CORE_SERVICES.map(([label, container], index) => ({
    label,
    container,
    state: states[index],
    optional: false,
    detail: null,
    starting_secs: null,
    ...extra[container],
  }));
}

/** A current desktop shell's `get_startup_progress_command` payload. */
function startupProgress(overrides: Record<string, unknown> = {}) {
  return {
    services: coreServices(['ready', 'ready', 'starting', 'pending']),
    progress_pct: 69,
    image_pulled: 4,
    image_total: 4,
    image_pull_pct: 100,
    all_ready: false,
    start_in_progress: false,
    user_stopped: false,
    user_stopped_at_ms: null,
    start_error: null,
    start_failed_at_ms: null,
    docker_access: { state: 'available', detail: null },
    hub_api_live: false,
    ...overrides,
  };
}

type HubStatusFixture = 'Stopped' | 'Starting' | 'Running' | 'DockerNotAvailable' | { Error: { message: string } };

function mountStartupScreens({
  status,
  progress,
  handlers = {},
}: {
  status: HubStatusFixture | (() => HubStatusFixture);
  progress: unknown | (() => unknown);
  handlers?: Record<string, () => Promise<unknown>>;
}) {
  const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
    const handler = handlers[cmd];
    if (handler) return handler();
    switch (cmd) {
      case 'get_hub_status_command':
        return typeof status === 'function' ? status() : status;
      case 'get_startup_progress_command':
        return typeof progress === 'function' ? progress() : progress;
      case 'check_docker_access_command':
        return { state: 'available', detail: null };
      case 'is_stack_dev_mode_command':
        return false;
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

  return { invoke };
}

/** Let the status poll, the progress poll and the re-renders they cause all land (fake timers). */
async function settle() {
  for (let round = 0; round < 5; round += 1) {
    await flushAsyncWork();
  }
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Each counts-row entry as "{number}{label}", in order. */
function countsRow() {
  const counts = screen.getAllByRole('list').at(-1);
  if (!counts) throw new Error('No counts row');
  return within(counts)
    .getAllByRole('listitem')
    .map((item) => item.textContent);
}

/** A facts-row entry as "{label}{value}". */
function fact(label: string) {
  return screen.getByText(label, { selector: 'dt' }).parentElement?.textContent;
}

/** The time text at the right of the progress meta row, exactly as rendered. */
function metaTime() {
  return screen.getByText(/^\d+%$/).nextElementSibling?.textContent;
}

function rowFor(label: string) {
  const row = screen.getByText(label).closest('li');
  if (!row) throw new Error(`No service row for ${label}`);
  return row;
}

/** 9:25 PM on Sep 16, local time. Node's ICU may put a narrow no-break space before PM. */
const SEP_16_925_PM = new Date(2026, 8, 16, 21, 25).getTime();

describe('HubStatus startup screens', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('shows the starting screen with the facts and counts rows, and no optional services', async () => {
    probeMocks.probeHealthyHubApiPort.mockResolvedValue(null);
    const services = [
      ...coreServices(['ready', 'ready', 'starting', 'pending']),
      { label: 'Tunnel', container: 'cloudflared', state: 'ready', optional: true, detail: null, starting_secs: null },
    ];
    mountStartupScreens({ status: 'Starting', progress: startupProgress({ services }) });

    expect(await screen.findByRole('heading', { name: 'Starting CI Hub' })).toBeInTheDocument();
    expect(await screen.findByText('Services are coming online…')).toBeInTheDocument();
    // `find`, not `get`: the status line renders from `status` while the progress panel waits on the
    // progress poll, and on a loaded CI runner the panel was still the Initialising row here.
    expect(await screen.findByText('69%')).toBeInTheDocument();
    expect(metaTime()).toBe('0:00 elapsed');

    expect(fact('Images pulled')).toBe('Images pulled4 of 4 (100%)');
    expect(fact('Docker')).toBe('DockerRunning');
    expect(fact('Hub API')).toBe('Hub APINot answering yet');

    expect(rowFor('Database')).toHaveTextContent('Ready');
    expect(rowFor('Hub backend')).toHaveTextContent('Starting');
    expect(rowFor('Router')).toHaveTextContent('Waiting');
    expect(screen.queryByText('Tunnel')).not.toBeInTheDocument();

    // Zero counts stay; Stopped and Not started only join when they happen.
    expect(countsRow()).toEqual(['2Ready', '1Starting', '1Waiting', '0Failed']);
    expect(screen.queryByRole('button', { name: 'View logs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart Hub' })).not.toBeInTheDocument();
  });

  it('turns into "hasn\'t finished starting" after three minutes, with Restart Hub and Keep waiting', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    probeMocks.probeHealthyHubApiPort.mockResolvedValue(null);
    const { invoke } = mountStartupScreens({
      status: 'Starting',
      // A container in a restart loop: its own start time keeps resetting.
      progress: startupProgress({ services: coreServices(['ready', 'ready', 'starting', 'pending'], { 'ci-hub': { starting_secs: 30 } }) }),
      handlers: {
        restart_hub_command: async () => {
          throw new Error('Command restart_hub_command not allowed by ACL');
        },
        start_hub_command: async () => 'Hub started successfully',
      },
    });

    await settle();
    expect(screen.getByRole('heading', { name: 'Starting CI Hub' })).toBeInTheDocument();

    await advance(91_000);
    expect(screen.getByRole('heading', { name: 'Starting CI Hub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View logs' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart Hub' })).not.toBeInTheDocument();

    await advance(90_000);
    expect(screen.getByRole('heading', { name: "CI Hub hasn't finished starting" })).toBeInTheDocument();
    // The page has waited 3:01, so that is what the stuck service reports, not its own 30 s.
    expect(screen.getByText('Hub backend has been starting for 3 minutes. Restarting the Hub often clears this.')).toBeInTheDocument();
    expect(rowFor('Hub backend')).toHaveTextContent(/Starting for 3:0\d/);
    expect(fact('Hub API')).toBe('Hub APINot answering');
    expect(screen.getByRole('button', { name: 'View logs' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep waiting' }));
    expect(screen.getByRole('heading', { name: 'Starting CI Hub' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart Hub' })).not.toBeInTheDocument();

    await advance(179_000);
    expect(screen.getByRole('heading', { name: 'Starting CI Hub' })).toBeInTheDocument();
    await advance(2_000);
    expect(screen.getByRole('heading', { name: "CI Hub hasn't finished starting" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Restart Hub' }));
    expect(screen.queryByRole('button', { name: 'Restart Hub' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Starting CI Hub' })).toBeInTheDocument();
    expect(metaTime()).toBe('0:00 elapsed');
    await settle();

    // This origin may not restart: it starts instead of failing on the ACL.
    expect(invoke).toHaveBeenCalledWith('restart_hub_command');
    expect(invoke).toHaveBeenCalledWith('start_hub_command');
    expect(screen.getByRole('heading', { name: 'Starting CI Hub' })).toBeInTheDocument();
  });

  it('never goes stuck while a start is downloading images, and gives the services three minutes after', async () => {
    vi.useFakeTimers();
    probeMocks.probeHealthyHubApiPort.mockResolvedValue(null);
    let progress = startupProgress({
      services: coreServices(['pending', 'pending', 'pending', 'pending']),
      progress_pct: 33,
      image_pulled: 2,
      image_total: 4,
      image_pull_pct: 50,
      start_in_progress: true,
    });
    mountStartupScreens({ status: 'Starting', progress: () => progress });

    await settle();
    expect(screen.getByText('Downloading what CI Hub needs. The first start after an install or update can take a few minutes.')).toBeInTheDocument();
    expect(fact('Images pulled')).toBe('Images pulled2 of 4 (50%)');

    await advance(240_000);
    expect(screen.getByRole('heading', { name: 'Starting CI Hub' })).toBeInTheDocument();

    progress = { ...progress, image_pulled: 4, image_pull_pct: 100 };
    await advance(170_000);
    expect(screen.getByRole('heading', { name: 'Starting CI Hub' })).toBeInTheDocument();
    expect(screen.getByText('Services are coming online…')).toBeInTheDocument();

    await advance(15_000);
    expect(screen.getByRole('heading', { name: "CI Hub hasn't finished starting" })).toBeInTheDocument();
    expect(screen.getByText('CI Hub has been starting for 7 minutes. Restarting the Hub often clears this.')).toBeInTheDocument();
  });

  it('does not call missing images a download when no start is running', async () => {
    probeMocks.probeHealthyHubApiPort.mockResolvedValue(null);
    mountStartupScreens({ status: 'Starting', progress: startupProgress({ image_pulled: 3, image_total: 4, image_pull_pct: 75 }) });

    expect(await screen.findByText('Services are coming online…')).toBeInTheDocument();
    expect(screen.queryByText(/Downloading what CI Hub needs/)).not.toBeInTheDocument();
  });

  it('says when the user stopped the Hub, and Start Hub starts it with the button gone at once', async () => {
    probeMocks.probeHealthyHubApiPort.mockResolvedValue(null);
    let finishStart: (value: string) => void = () => {};
    const { invoke } = mountStartupScreens({
      status: 'Stopped',
      progress: startupProgress({
        services: coreServices(['stopped', 'stopped', 'stopped', 'stopped']),
        progress_pct: 15,
        user_stopped: true,
        user_stopped_at_ms: SEP_16_925_PM,
      }),
      handlers: {
        start_hub_command: () =>
          new Promise((resolve) => {
            finishStart = resolve;
          }),
      },
    });

    expect(await screen.findByRole('heading', { name: 'CI Hub is stopped' })).toBeInTheDocument();
    const line = await screen.findByText(/^You stopped it on /);
    // Date and time each stay on one line.
    expect(line.textContent).toMatch(/^You stopped it on Sep\u00a016 at 9:25[\u00a0\u202f]PM\. It stays stopped until you start it again\.$/);
    expect(metaTime()).toMatch(/^Stopped since Sep\u00a016, 9:25[\u00a0\u202f]PM$/);
    // Stopped reads 0% whatever the containers score.
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(fact('Hub API')).toBe('Hub APINot running');
    expect(rowFor('Router')).toHaveTextContent('Stopped');
    expect(countsRow()).toEqual(['0Ready', '0Starting', '0Waiting', '0Failed', '4Stopped']);
    expect(screen.getByText('Starting usually takes under a minute.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View logs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start Hub' }));

    expect(invoke).toHaveBeenCalledWith('start_hub_command');
    expect(screen.queryByRole('button', { name: 'Start Hub' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Starting CI Hub' })).toBeInTheDocument();
    expect(metaTime()).toBe('0:00 elapsed');

    await act(async () => {
      finishStart('Hub started successfully');
    });
  });

  it('says the Hub is not running when the user did not stop it, from an older shell without the new fields', async () => {
    probeMocks.probeHealthyHubApiPort.mockResolvedValue(null);
    mountStartupScreens({
      status: 'Stopped',
      progress: {
        services: [
          { label: 'Database', container: 'ci-hub-db', state: 'pending' },
          { label: 'Message queue', container: 'ci-hub-queue', state: 'pending' },
          { label: 'Hub backend', container: 'ci-hub', state: 'pending' },
          { label: 'Router', container: 'traefik', state: 'pending' },
          { label: 'Tunnel', container: 'cloudflared', state: 'unavailable', optional: true },
        ],
        progress_pct: 15,
        image_pulled: 4,
        image_total: 4,
        image_pull_pct: 100,
        all_ready: false,
      },
    });

    expect(await screen.findByRole('heading', { name: "CI Hub isn't running" })).toBeInTheDocument();
    expect(await screen.findByText('Start it to use CI Hub and your apps.')).toBeInTheDocument();
    expect(metaTime()).toBe('Not running');
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(fact('Docker')).toBe('DockerRunning');
    expect(fact('Hub API')).toBe('Hub APINot running');
    expect(rowFor('Database')).toHaveTextContent('Waiting');
    expect(screen.queryByText('Tunnel')).not.toBeInTheDocument();
    expect(countsRow()).toEqual(['0Ready', '0Starting', '4Waiting', '0Failed']);
    expect(screen.getByRole('button', { name: 'Start Hub' })).toBeInTheDocument();
  });

  it('shows why a core service failed in its row, copies the error, and Try again starts at once', async () => {
    probeMocks.probeHealthyHubApiPort.mockResolvedValue(null);
    const detail = 'driver failed programming external connectivity on endpoint ci-hub-db: Bind for 0.0.0.0:6543 failed: port is already allocated';
    const message = `Error response from daemon: ${detail}`;
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    let finishStart: (value: string) => void = () => {};
    const { invoke } = mountStartupScreens({
      status: { Error: { message } },
      progress: startupProgress({
        services: coreServices(['failed', 'not_started', 'not_started', 'not_started'], { 'ci-hub-db': { detail } }),
        progress_pct: 11,
        start_error: message,
        start_failed_at_ms: SEP_16_925_PM,
      }),
      handlers: {
        start_hub_command: () =>
          new Promise((resolve) => {
            finishStart = resolve;
          }),
      },
    });

    expect(await screen.findByRole('heading', { name: "CI Hub couldn't start" })).toBeInTheDocument();
    expect(await screen.findByText("Docker couldn't start the database. CI Hub won't retry on its own.")).toBeInTheDocument();
    const databaseRow = rowFor('Database');
    expect(databaseRow).toHaveTextContent('Failed');
    expect(within(databaseRow).getByText(detail)).toBeInTheDocument();
    // The status message says the same thing at more length: it is copied, not shown again.
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(rowFor('Router')).toHaveTextContent('Not started');
    expect(metaTime()).toMatch(/^Failed at 9:25[\u00a0\u202f]PM$/);
    expect(screen.getByText('11%')).toBeInTheDocument();
    expect(fact('Hub API')).toBe('Hub APINot running');
    expect(countsRow()).toEqual(['0Ready', '0Starting', '0Waiting', '1Failed', '3Not started']);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy error' }));
    });
    expect(writeText).toHaveBeenCalledWith(`${detail}\n\n${message}`);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(invoke).toHaveBeenCalledWith('start_hub_command');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Starting CI Hub' })).toBeInTheDocument();

    await act(async () => {
      finishStart('Hub started successfully');
    });
  });

  it('puts the error in the panel when no core service failed, and copies it without the Clipboard API', async () => {
    const rateLimited = "Docker Hub rate-limited image pulls from this machine's IP (HTTP 429). Wait several minutes.";
    const execCommand = vi.fn((_command: string) => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    mountStartupScreens({
      status: { Error: { message: rateLimited } },
      progress: startupProgress({
        services: coreServices(['not_started', 'not_started', 'not_started', 'not_started']),
        progress_pct: 0,
        start_error: rateLimited,
      }),
    });

    expect(await screen.findByRole('heading', { name: "CI Hub couldn't start" })).toBeInTheDocument();
    expect(await screen.findByText("CI Hub won't retry on its own until you try again.")).toBeInTheDocument();
    const panelError = screen.getByText(rateLimited);
    expect(panelError.closest('li')).toBeNull();
    // Neither this page's start nor a recorded failure time: plain "Failed".
    expect(metaTime()).toBe('Failed');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy error' }));
    });
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it("puts an older shell's error in the failed row when that row has no detail of its own", async () => {
    mountStartupScreens({
      status: { Error: { message: 'Hub has restarted 4 times. Open tray → View Logs for details.' } },
      progress: {
        services: [
          { label: 'Database', container: 'ci-hub-db', state: 'ready' },
          { label: 'Message queue', container: 'ci-hub-queue', state: 'ready' },
          { label: 'Hub backend', container: 'ci-hub', state: 'failed' },
          { label: 'Router', container: 'traefik', state: 'ready' },
        ],
        progress_pct: 75,
        image_pulled: 4,
        image_total: 4,
        image_pull_pct: 100,
        all_ready: false,
      },
    });

    expect(await screen.findByText("Docker couldn't start the Hub backend. CI Hub won't retry on its own.")).toBeInTheDocument();
    expect(within(rowFor('Hub backend')).getByText(/Hub has restarted 4 times/)).toBeInTheDocument();
    expect(countsRow()).toEqual(['3Ready', '0Starting', '0Waiting', '1Failed']);
  });

  it('explains an ACL denial of its own start, and keeps it on screen when the shell still says Stopped', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    probeMocks.probeHealthyHubApiPort.mockResolvedValue(null);
    const { invoke } = mountStartupScreens({
      status: 'Stopped',
      progress: startupProgress({ services: coreServices(['stopped', 'stopped', 'stopped', 'stopped']), progress_pct: 0 }),
      handlers: {
        start_hub_command: async () => {
          throw new Error('Command start_hub_command not allowed by ACL');
        },
      },
    });

    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Start Hub' }));
    await settle();

    expect(invoke).toHaveBeenCalledWith('start_hub_command');
    expect(screen.getByRole('heading', { name: "CI Hub couldn't start" })).toBeInTheDocument();
    const panelError = screen.getByText(/blocked this start command for the current page origin/);
    expect(panelError).toHaveTextContent('Command start_hub_command not allowed by ACL');
    expect(metaTime()).toBe('Failed after 0:00');

    await advance(5_000);
    expect(screen.getByRole('heading', { name: "CI Hub couldn't start" })).toBeInTheDocument();
    expect(screen.getByText(/blocked this start command for the current page origin/)).toBeInTheDocument();
  });

  it('View logs shows the desktop log inline, and Hide closes it', async () => {
    const { invoke } = mountStartupScreens({
      status: { Error: { message: 'boom' } },
      progress: startupProgress({ services: coreServices(['not_started', 'not_started', 'not_started', 'not_started']) }),
      handlers: { read_desktop_logs_command: async () => 'line1\nline2\nline3' },
    });

    const viewLogs = await screen.findByRole('button', { name: 'View logs' });
    await act(async () => {
      fireEvent.click(viewLogs);
    });

    expect(invoke).toHaveBeenCalledWith('read_desktop_logs_command');
    expect(await screen.findByText('Recent Logs')).toBeInTheDocument();
    expect(screen.getByText(/line1/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    });
    expect(screen.queryByText('Recent Logs')).not.toBeInTheDocument();
  });

  it('View logs opens the logs folder when the log cannot be read', async () => {
    const { invoke } = mountStartupScreens({
      status: { Error: { message: 'boom' } },
      progress: startupProgress({ services: coreServices(['not_started', 'not_started', 'not_started', 'not_started']) }),
      handlers: {
        read_desktop_logs_command: async () => {
          throw new Error('no log file');
        },
        open_logs_dir_command: async () => undefined,
      },
    });

    const viewLogs = await screen.findByRole('button', { name: 'View logs' });
    await act(async () => {
      fireEvent.click(viewLogs);
    });

    // openLogsFolder passes no arguments object.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_logs_dir_command', undefined));
    expect(screen.queryByText('Recent Logs')).not.toBeInTheDocument();
  });
});
