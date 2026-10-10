import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HubStatus } from '../hub-status';

vi.mock('@/lib/update-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/update-service')>();
  return { ...actual, isDesktopUpdateRunning: () => false };
});

// HubStatus uses useRevalidator, and (via useAppIntentDeepLinks) useNavigate.
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useRevalidator: () => ({ revalidate: vi.fn(), state: 'idle' as const }),
    useNavigate: () => vi.fn(),
  };
});

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> };
};

const tauriWindow = window as TauriWindow;
const originalUserAgent = navigator.userAgent;
/** The screen appears after three invokes (status, stack-dev mode, engine); a loaded CI box needs more than 1s. */
const SCREEN_TIMEOUT = { timeout: 5000 };

/** The desktop app as a Windows Hub sees it while Docker doesn't answer, on the engine `dockerEngine`. */
function renderDockerDown(dockerEngine: string, startEngine: () => Promise<unknown> = async () => 'started') {
  const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
    switch (cmd) {
      case 'get_hub_status_command':
        return 'DockerNotAvailable';
      case 'is_stack_dev_mode_command':
        return false;
      case 'check_docker_access_command':
        return { state: 'daemon_unavailable', detail: 'Cannot connect to the Docker daemon at tcp://127.0.0.1:2375.' };
      case 'get_startup_progress_command':
        return {
          services: [],
          progress_pct: 0,
          image_pulled: 0,
          image_total: 4,
          image_pull_pct: 0,
          all_ready: false,
          docker_access: { state: 'daemon_unavailable', detail: null },
          docker_engine: dockerEngine,
        };
      case 'start_wsl_engine_command':
        return startEngine();
      default:
        throw new Error(`Unexpected invoke command: ${cmd}`);
    }
  });

  Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true });
  Object.defineProperty(tauriWindow, '__TAURI_INTERNALS__', { value: { invoke }, configurable: true });

  render(
    <HubStatus>
      <div>Hub child</div>
    </HubStatus>,
  );

  return { invoke };
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  delete tauriWindow.__TAURI_INTERNALS__;
  Object.defineProperty(window.navigator, 'userAgent', { value: originalUserAgent, configurable: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HubStatus when Docker in WSL stops (CI-Hub#1935)', () => {
  it('says WSL stopped the engine and offers to start it, with no Docker Desktop steps', async () => {
    renderDockerDown('wsl-engine');

    expect(await screen.findByRole('heading', { name: "Docker in WSL isn't running" }, SCREEN_TIMEOUT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start engine' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'CI Hub' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Docker Required' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download Docker Desktop/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Auto-Install Docker Engine in WSL2' })).not.toBeInTheDocument();
  });

  it('starts the engine from the button and says why when it does not start', async () => {
    let failStart: (reason: Error) => void = () => undefined;
    const { invoke } = renderDockerDown(
      'wsl-engine',
      () =>
        new Promise((_resolve, reject) => {
          failStart = reject;
        }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Start engine' }, SCREEN_TIMEOUT));
    await flushAsyncWork();

    expect(invoke).toHaveBeenCalledWith('start_wsl_engine_command');
    expect(screen.getByText(/Starting the engine/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start engine' })).not.toBeInTheDocument();

    await act(async () => {
      failStart(new Error('WSL distro Ubuntu stopped right away (exit code 1).'));
    });

    expect(screen.getByText('WSL distro Ubuntu stopped right away (exit code 1).')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start engine' })).toBeInTheDocument();
  });

  it('keeps saying the engine is starting once it answers, until the status poll moves on', async () => {
    let finishStart: (value: unknown) => void = () => undefined;
    renderDockerDown(
      'wsl-engine',
      () =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Start engine' }, SCREEN_TIMEOUT));
    await flushAsyncWork();
    vi.useFakeTimers();
    await act(async () => {
      finishStart('started');
    });

    // The next status poll hasn't run yet. The button coming back here would read as a failed start.
    expect(screen.getByText(/Starting the engine/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start engine' })).not.toBeInTheDocument();

    // Docker still doesn't answer 15 s on (WSL stopped it again): the button is back.
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.getByRole('button', { name: 'Start engine' })).toBeInTheDocument();
  });

  it('keeps the Docker Desktop guide on Docker Desktop', async () => {
    renderDockerDown('desktop');

    expect(await screen.findByRole('heading', { name: 'Docker Required' }, SCREEN_TIMEOUT)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download Docker Desktop for Windows' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start engine' })).not.toBeInTheDocument();
  });
});
