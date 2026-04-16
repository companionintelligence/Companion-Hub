import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HubStatus, getDockerDesktopGuideContent, pollDockerAccess, resolveDesktopPostInstallState } from './hub-status';

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

describe('resolveDesktopPostInstallState', () => {
  it('treats not-installed after install as an error instead of a starting loop', () => {
    expect(resolveDesktopPostInstallState({ state: 'not_installed', detail: 'docker: command not found' })).toEqual({
      installState: 'error',
      errorMessage: 'docker: command not found',
    });
  });

  it('keeps daemon-unavailable in the startup state', () => {
    expect(resolveDesktopPostInstallState({ state: 'daemon_unavailable', detail: 'Docker daemon starting' })).toEqual({
      installState: 'starting-daemon',
      errorMessage: 'Docker daemon starting',
    });
  });
});

describe('pollDockerAccess', () => {
  it('keeps polling until Docker becomes available', async () => {
    const invoke = vi
      .fn<(cmd: string) => Promise<unknown>>()
      .mockResolvedValueOnce({ state: 'daemon_unavailable', detail: 'daemon starting' })
      .mockResolvedValueOnce({ state: 'daemon_unavailable', detail: 'still starting' })
      .mockResolvedValueOnce({ state: 'available' });
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const result = await pollDockerAccess(invoke, {
      attempts: 5,
      delayMs: 1,
      sleepFn,
    });

    expect(result).toEqual({ state: 'available' });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it('returns permission denied immediately once detected', async () => {
    const invoke = vi
      .fn<(cmd: string) => Promise<unknown>>()
      .mockResolvedValueOnce({ state: 'daemon_unavailable', detail: 'daemon starting' })
      .mockResolvedValueOnce({ state: 'permission_denied', detail: 'dial unix /var/run/docker.sock: permission denied' });
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const result = await pollDockerAccess(invoke, {
      attempts: 5,
      delayMs: 1,
      sleepFn,
    });

    expect(result).toEqual({
      state: 'permission_denied',
      detail: 'dial unix /var/run/docker.sock: permission denied',
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it('returns the last daemon-unavailable result after timeout', async () => {
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>().mockResolvedValue({ state: 'daemon_unavailable', detail: 'daemon still starting' });
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const result = await pollDockerAccess(invoke, {
      attempts: 3,
      delayMs: 1,
      sleepFn,
    });

    expect(result).toEqual({ state: 'daemon_unavailable', detail: 'daemon still starting' });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it('returns the last not-installed result after a bounded poll window', async () => {
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>().mockResolvedValue({ state: 'not_installed', detail: 'docker: command not found' });
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const result = await pollDockerAccess(invoke, {
      attempts: 3,
      delayMs: 1,
      sleepFn,
    });

    expect(result).toEqual({ state: 'not_installed', detail: 'docker: command not found' });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });
});

describe('HubStatus desktop install flow', () => {
  it('shows success copy that matches Docker already being available', async () => {
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
      switch (cmd) {
        case 'get_hub_status_command':
          return 'DockerNotAvailable';
        case 'install_docker_command':
          return { state: 'completed' };
        case 'check_docker_access_command':
          return { state: 'available' };
        default:
          throw new Error(`Unexpected invoke command: ${cmd}`);
      }
    });

    const tauriWindow = window as Window & {
      __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> };
    };
    const originalUserAgent = navigator.userAgent;

    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true,
    });
    Object.defineProperty(tauriWindow, '__TAURI_INTERNALS__', {
      value: { invoke },
      configurable: true,
    });

    try {
      render(
        <HubStatus>
          <div>Hub child</div>
        </HubStatus>,
      );

      expect(await screen.findByRole('button', { name: 'Install Docker Desktop' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Install Docker Desktop' }));

      expect(await screen.findByText('Docker Desktop Installed')).toBeInTheDocument();
      expect(screen.getByText('Docker Desktop is ready. Companion Hub will start automatically.')).toBeInTheDocument();
    } finally {
      delete tauriWindow.__TAURI_INTERNALS__;
      Object.defineProperty(window.navigator, 'userAgent', {
        value: originalUserAgent,
        configurable: true,
      });
    }
  });
});
