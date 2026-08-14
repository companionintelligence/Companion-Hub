import { render, screen, userEvent, waitFor } from '@/tests/test-utils';
import { useAppContext } from '@/context/app-context';
import { checkForUpdates, fetchHostListenerStatus, getInstalledDesktopVersion, isTauri, performUpdate } from '@/lib/update-service';
import { sdkOk } from '@/tests/sdk-mock-helpers';
import toast from 'react-hot-toast';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { GeneralActionsContainer } from './general-actions';

const { getAutoUpdates, checkHubForUpdatesApi } = vi.hoisted(() => ({
  getAutoUpdates: vi.fn(),
  checkHubForUpdatesApi: vi.fn(),
}));

vi.mock('@/context/app-context', () => ({
  useAppContext: vi.fn(),
}));

vi.mock('@/api-client/sdk.gen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api-client/sdk.gen')>();
  return {
    ...actual,
    getAutoUpdates,
    setAutoUpdates: vi.fn(),
    restartOnboarding: vi.fn(),
    factoryReset: vi.fn(),
    checkForUpdates: checkHubForUpdatesApi,
  };
});

vi.mock('@/lib/hooks/use-demo-mode', () => ({
  useDemoMode: () => false,
}));

vi.mock('@/lib/update-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/update-service')>('@/lib/update-service');
  return {
    ...actual,
    checkForUpdates: vi.fn(),
    fetchHostListenerStatus: vi.fn(),
    getInstalledDesktopVersion: vi.fn(),
    isTauri: vi.fn(),
    performUpdate: vi.fn(),
  };
});

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../components/update-repo-modal/update-repo-modal', () => ({
  UpdateRepoModal: () => <div>Update repo</div>,
}));

vi.mock('@/components/markdown/markdown', () => ({
  Markdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

const mockUseAppContext = vi.mocked(useAppContext);
const mockCheckForUpdates = vi.mocked(checkForUpdates);
const mockCheckHubForUpdatesApi = vi.mocked(checkHubForUpdatesApi);
const mockGetInstalledDesktopVersion = vi.mocked(getInstalledDesktopVersion);
const mockIsTauri = vi.mocked(isTauri);
const mockPerformUpdate = vi.mocked(performUpdate);
const mockFetchHostListenerStatus = vi.mocked(fetchHostListenerStatus);
const mockToastSuccess = vi.mocked(toast.success);

describe('GeneralActionsContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseAppContext.mockReturnValue({
      version: {
        current: '4.7.0',
        latest: '4.7.0',
        body: '',
        releases: [],
      },
      refreshAppContext: vi.fn(),
    } as unknown as ReturnType<typeof useAppContext>);

    getAutoUpdates.mockResolvedValue(sdkOk({ enabled: true }));
    mockCheckHubForUpdatesApi.mockResolvedValue(sdkOk({ updateAvailable: false, latest: '4.7.0' }));
    mockIsTauri.mockReturnValue(false);
    mockGetInstalledDesktopVersion.mockResolvedValue(null);
    mockCheckForUpdates.mockResolvedValue(null);
    mockFetchHostListenerStatus.mockResolvedValue(false);
  });

  it('shows the stack version in the primary card and shell update in the shell card on desktop', async () => {
    mockIsTauri.mockReturnValue(true);
    mockGetInstalledDesktopVersion.mockResolvedValue('0.2.23');
    mockCheckForUpdates.mockResolvedValue({
      currentVersion: '0.2.23',
      latestVersion: '0.2.24',
      downloadUrl: 'https://dl.ci.computer/v0.2.24/linux/deb/x64/Companion%20Hub_0.2.24_amd64.deb',
      updateAvailable: true,
      platform: 'linux',
      manualDownload: true,
    });

    render(<GeneralActionsContainer />);

    expect(await screen.findByText('Current version: 4.7.0')).toBeInTheDocument();
    expect(screen.getByTestId('hub-shell-update-btn')).toHaveTextContent('Download 0.2.24');
    expect(screen.queryByTestId('hub-update-btn')).not.toBeInTheDocument();
  });

  it('shows manual update instructions matching the installer format on linux', async () => {
    mockIsTauri.mockReturnValue(true);
    mockGetInstalledDesktopVersion.mockResolvedValue('0.2.23');
    mockCheckForUpdates.mockResolvedValue({
      currentVersion: '0.2.23',
      latestVersion: '0.2.24',
      downloadUrl: 'https://dl.ci.computer/v0.2.24/linux/deb/x64/Companion%20Hub_0.2.24_amd64.deb',
      updateAvailable: true,
      platform: 'linux',
      manualDownload: true,
    });

    render(<GeneralActionsContainer />);

    const instructions = await screen.findByTestId('manual-update-instructions');
    expect(instructions).toHaveTextContent('Then install the app');
    expect(instructions).toHaveTextContent('sudo apt purge companion-hub -y');
    expect(instructions).toHaveTextContent('sudo apt install ./companion-hub_*.deb');
    expect(instructions).not.toHaveTextContent('rpm');
  });

  it('keeps manual update instructions visible after opening the installer download', async () => {
    mockIsTauri.mockReturnValue(true);
    mockGetInstalledDesktopVersion.mockResolvedValue('0.2.23');
    mockCheckForUpdates.mockResolvedValue({
      currentVersion: '0.2.23',
      latestVersion: '0.2.24',
      downloadUrl: 'https://dl.ci.computer/v0.2.24/linux/deb/x64/Companion%20Hub_0.2.24_amd64.deb',
      updateAvailable: true,
      platform: 'linux',
      manualDownload: true,
    });
    mockPerformUpdate.mockResolvedValue({
      ok: true,
      messageKey: 'SETTINGS_ACTIONS_DOWNLOAD_INSTALLER_OPENED',
      defaultMessage: 'Installer download opened in your browser.',
    });

    render(<GeneralActionsContainer />);

    await userEvent.click(await screen.findByTestId('hub-shell-update-btn'));

    expect(await screen.findByText('Installer download opened in your browser.')).toBeInTheDocument();
    expect(screen.getByTestId('manual-update-instructions')).toHaveTextContent('sudo apt purge companion-hub -y');
  });

  it('surfaces the manual download message after opening the linux installer', async () => {
    mockIsTauri.mockReturnValue(true);
    mockGetInstalledDesktopVersion.mockResolvedValue('0.2.23');
    mockCheckForUpdates.mockResolvedValue({
      currentVersion: '0.2.23',
      latestVersion: '0.2.24',
      downloadUrl: 'https://dl.ci.computer/v0.2.24/linux/deb/x64/Companion%20Hub_0.2.24_amd64.deb',
      updateAvailable: true,
      platform: 'linux',
      manualDownload: true,
    });
    mockPerformUpdate.mockResolvedValue({
      ok: true,
      messageKey: 'SETTINGS_ACTIONS_DOWNLOAD_INSTALLER_OPENED',
      defaultMessage: 'Installer download opened in your browser.',
    });

    render(<GeneralActionsContainer />);

    await userEvent.click(await screen.findByTestId('hub-shell-update-btn'));

    await waitFor(() => {
      expect(mockPerformUpdate).toHaveBeenCalled();
      expect(mockToastSuccess).toHaveBeenCalledWith('Installer download opened in your browser.');
    });
    expect(screen.getByText('Installer download opened in your browser.')).toBeInTheDocument();
  });

  it('checks stack updates from the API even when shell version detection fails', async () => {
    mockIsTauri.mockReturnValue(true);
    mockGetInstalledDesktopVersion.mockResolvedValue(null);

    render(<GeneralActionsContainer />);

    await userEvent.click(await screen.findByTestId('hub-check-updates-btn'));

    await waitFor(() => {
      expect(mockCheckHubForUpdatesApi).toHaveBeenCalled();
      expect(mockToastSuccess).toHaveBeenCalledWith('You are on the latest version.');
    });
    expect(screen.getByText('Current version: 4.7.0')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-shell-update-card')).toBeInTheDocument();
    expect(screen.getByTestId('host-listener-unavailable')).toHaveTextContent('Start Companion Hub');
  });

  it('tells the operator to start the desktop app when the host listener is down', async () => {
    mockFetchHostListenerStatus.mockResolvedValue(false);

    render(<GeneralActionsContainer />);

    expect(await screen.findByTestId('host-listener-unavailable')).toHaveTextContent(
      'The desktop app is not running, so the app shell cannot update right now',
    );
    expect(screen.queryByTestId('host-listener-ready')).not.toBeInTheDocument();
  });

  it('does not POST the host listener from the browser tab', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mockFetchHostListenerStatus.mockResolvedValue(false);

    render(<GeneralActionsContainer />);

    await screen.findByTestId('desktop-shell-update-card');
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('127.0.0.1:17400'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('shows macos install steps for a dmg download', async () => {
    mockIsTauri.mockReturnValue(true);
    mockGetInstalledDesktopVersion.mockResolvedValue('0.2.23');
    mockCheckForUpdates.mockResolvedValue({
      currentVersion: '0.2.23',
      latestVersion: '0.2.24',
      downloadUrl: 'https://dl.ci.computer/v0.2.24/macos/arm/Companion%20Hub_0.2.24_aarch64.dmg',
      updateAvailable: true,
      platform: 'macos',
      manualDownload: true,
    });

    render(<GeneralActionsContainer />);

    const instructions = await screen.findByTestId('manual-update-instructions');
    expect(instructions).toHaveTextContent('Open the downloaded DMG');
    expect(instructions).not.toHaveTextContent('apt purge');
  });

  it('labels the stack button as a stack-only update', async () => {
    mockIsTauri.mockReturnValue(false);
    mockUseAppContext.mockReturnValue({
      version: {
        current: '0.2.44',
        latest: '0.2.46',
        body: '',
        releases: [{ version: '0.2.46', body: 'Release 0.2.46' }],
      },
      refreshAppContext: vi.fn(),
    } as unknown as ReturnType<typeof useAppContext>);

    render(<GeneralActionsContainer />);

    expect(await screen.findByTestId('hub-update-btn')).toHaveTextContent('Update stack to 0.2.46');
  });

  it('shows only the latest release card when multiple versions are available', async () => {
    mockIsTauri.mockReturnValue(false);
    mockUseAppContext.mockReturnValue({
      version: {
        current: '0.2.44',
        latest: '0.2.46',
        body: '',
        releases: [
          { version: '0.2.46', body: 'Release 0.2.46' },
          { version: '0.2.45', body: 'Release 0.2.45' },
        ],
      },
      refreshAppContext: vi.fn(),
    } as unknown as ReturnType<typeof useAppContext>);

    render(<GeneralActionsContainer />);

    expect(await screen.findByTestId('hub-latest-release-card')).toBeInTheDocument();
    expect(screen.getByText('Version 0.2.46')).toBeInTheDocument();
    expect(screen.queryByText('Version 0.2.45')).not.toBeInTheDocument();
    expect(screen.queryByText('Release 0.2.46')).not.toBeInTheDocument();
  });
});
