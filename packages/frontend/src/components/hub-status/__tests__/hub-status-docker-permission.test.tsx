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
/** The screen appears after a few invokes; a loaded CI box needs more than 1s. */
const SCREEN_TIMEOUT = { timeout: 5000 };
const PERMISSION_DETAIL =
  'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.54/info": dial unix /var/run/docker.sock: connect: permission denied';

/** The desktop app on Linux while Docker doesn't answer this user, for the reason `dockerAccess`. */
function renderDockerUnavailable(dockerAccess: string, userAgent = 'Mozilla/5.0 (X11; Linux x86_64)') {
  const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
    switch (cmd) {
      case 'get_hub_status_command':
        return 'DockerNotAvailable';
      case 'is_stack_dev_mode_command':
        return false;
      case 'check_docker_access_command':
        return { state: dockerAccess, detail: PERMISSION_DETAIL };
      case 'get_startup_progress_command':
        return {
          services: [],
          progress_pct: 0,
          image_pulled: 0,
          image_total: 4,
          image_pull_pct: 0,
          all_ready: false,
          // The Hub keeps running for whoever started it.
          hub_api_live: true,
          docker_access: { state: dockerAccess, detail: PERMISSION_DETAIL },
          docker_engine: null,
        };
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

  it('still offers to install Docker where it is missing', async () => {
    renderDockerUnavailable('not_installed');

    expect(await screen.findByRole('heading', { name: 'Docker Engine Required' }, SCREEN_TIMEOUT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto-Install Docker' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "Companion Hub can't use Docker" })).not.toBeInTheDocument();
  });
});
