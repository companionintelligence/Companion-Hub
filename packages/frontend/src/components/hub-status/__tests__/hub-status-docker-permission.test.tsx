import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HubStatus } from '../hub-status';

vi.mock('@/lib/update-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/update-service')>();
  return { ...actual, isDesktopUpdateRunning: () => false };
});

// HubStatus uses useRevalidator and (via useAppIntentDeepLinks) useNavigate.
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
/** The screen appears after a few invokes; a loaded CI box needs more than 1s. */
const SCREEN_TIMEOUT = { timeout: 5000 };
const PERMISSION_DETAIL =
  'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.54/info": dial unix /var/run/docker.sock: connect: permission denied';

/** The desktop app on Linux while Docker doesn't answer this user, for the reason `dockerAccess`. */
function renderDockerUnavailable(dockerAccess: string, userAgent = 'Mozilla/5.0 (X11; Linux x86_64)', { progressHangs = false } = {}) {
  let access = dockerAccess;
  const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
    if (cmd === 'get_startup_progress_command' && progressHangs) return new Promise<never>(() => undefined);
    switch (cmd) {
      case 'get_hub_status_command':
        return 'DockerNotAvailable';
      case 'is_stack_dev_mode_command':
        return false;
      case 'check_docker_access_command':
        return { state: access, detail: PERMISSION_DETAIL };
      case 'get_startup_progress_command':
        return {
          services: [],
          progress_pct: 0,
          image_pulled: 0,
          image_total: 4,
          image_pull_pct: 0,
          all_ready: false,
          // The shell only probes the Hub API while Docker answers.
          hub_api_live: false,
          // `docker info` prints the client's version after the error.
          docker_access: { state: access, detail: `${PERMISSION_DETAIL}\nClient: Docker Engine - Community\n Version:    29.6.0` },
          docker_engine: null,
        };
      case 'install_docker_command':
        // The install starts the daemon, which refuses this user until they log in again.
        access = 'permission_denied';
        return { state: 'needs_restart', detail: null };
      default:
        throw new Error(`Unexpected invoke command: ${cmd}`);
    }
  });

  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
  Object.defineProperty(tauriWindow, '__TAURI_INTERNALS__', { value: { invoke }, configurable: true });

  render(
    <HubStatus>
      <div>Hub child</div>
    </HubStatus>,
  );

  return { invoke };
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false })),
  );
});

afterEach(() => {
  delete tauriWindow.__TAURI_INTERNALS__;
  Object.defineProperty(window.navigator, 'userAgent', { value: originalUserAgent, configurable: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HubStatus when Docker refuses this user (Companion-Hub#2535)', () => {
  it('says to join the docker group instead of offering to install Docker', async () => {
    renderDockerUnavailable('permission_denied');

    expect(await screen.findByRole('heading', { name: "Companion Hub can't use Docker" }, SCREEN_TIMEOUT)).toBeInTheDocument();
    expect(screen.getByText("Your account isn't allowed to use Docker. Add it to the docker group, then log out and back in.")).toBeInTheDocument();
    expect(screen.getByText('sudo usermod -aG docker $USER')).toBeInTheDocument();
    expect(await screen.findByText('No permission')).toBeInTheDocument();
    expect(screen.getByText(PERMISSION_DETAIL)).toBeInTheDocument();
    expect(screen.queryByText(/Client: Docker Engine/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Companion Hub' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Docker Engine Required' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Auto-Install Docker' })).not.toBeInTheDocument();
    expect(screen.queryByText(/get\.docker\.com/)).not.toBeInTheDocument();
  });

  it('copies the command', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText } }));
    renderDockerUnavailable('permission_denied');

    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }, SCREEN_TIMEOUT));
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('sudo usermod -aG docker $USER');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('leaves the Linux command out on other systems', async () => {
    renderDockerUnavailable('permission_denied', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

    expect(await screen.findByRole('heading', { name: "Companion Hub can't use Docker" }, SCREEN_TIMEOUT)).toBeInTheDocument();
    expect(screen.queryByText('sudo usermod -aG docker $USER')).not.toBeInTheDocument();
  });

  it('keeps the install result once Docker installed from the page refuses this user', async () => {
    const { invoke } = renderDockerUnavailable('not_installed');
    const progressReads = () => invoke.mock.calls.filter(([cmd]) => cmd === 'get_startup_progress_command').length;

    fireEvent.click(await screen.findByRole('button', { name: 'Auto-Install Docker' }, SCREEN_TIMEOUT));
    expect(await screen.findByText(/Docker installed\. Log out and back in/)).toBeInTheDocument();
    const readsAtInstall = progressReads();
    await vi.waitFor(() => expect(progressReads()).toBeGreaterThan(readsAtInstall), { timeout: 5000 });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/Docker installed\. Log out and back in/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "Companion Hub can't use Docker" })).not.toBeInTheDocument();
  });

  it('stops waiting for the read of why Docker refused after a while', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderDockerUnavailable('not_installed', undefined, { progressHangs: true });
      expect(await screen.findByRole('status', { name: 'Checking hub status' })).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000);
      });

      expect(await screen.findByRole('heading', { name: 'Docker Engine Required' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still offers to install Docker where it is missing', async () => {
    renderDockerUnavailable('not_installed');

    expect(await screen.findByRole('heading', { name: 'Docker Engine Required' }, SCREEN_TIMEOUT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto-Install Docker' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "Companion Hub can't use Docker" })).not.toBeInTheDocument();
  });
});
