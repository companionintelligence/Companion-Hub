import { render, screen } from '@testing-library/react';
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

function renderWithTauriStatus(status: 'DockerNotAvailable' | 'Stopped', userAgent: string, userAgentData?: { architecture?: string }) {
  const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async (cmd: string) => {
    if (cmd === 'get_hub_status_command') {
      return status;
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

afterEach(() => {
  delete tauriWindow.__TAURI_INTERNALS__;
  restoreNavigator();
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

  it('keeps the existing stopped-state start button flow intact', async () => {
    renderWithTauriStatus('Stopped', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

    expect(await screen.findByRole('heading', { name: 'Hub Not Running' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Hub' })).toBeInTheDocument();
  });
});
