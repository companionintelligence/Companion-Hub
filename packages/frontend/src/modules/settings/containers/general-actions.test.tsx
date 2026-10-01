import { render, screen, userEvent, waitFor } from '@/tests/test-utils';
import { useAppContext } from '@/context/app-context';
import {
  checkForUpdates,
  fetchHostListenerStatus,
  getDesktopRestartState,
  getInstalledDesktopVersion,
  isTauri,
  performUpdate,
  restartDesktopApp,
} from '@/lib/update-service';
import { factoryReset } from '@/api-client/sdk.gen';
import { sdkOk } from '@/tests/sdk-mock-helpers';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import { GeneralActionsContainer } from './general-actions';

const { getAutoUpdates, checkHubForUpdatesApi, getDesktopRelease } = vi.hoisted(() => ({
  getAutoUpdates: vi.fn(),
  checkHubForUpdatesApi: vi.fn(),
  getDesktopRelease: vi.fn(),
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
    getDesktopRelease,
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
    getDesktopRestartState: vi.fn(),
    getInstalledDesktopVersion: vi.fn(),
    isTauri: vi.fn(),
    performUpdate: vi.fn(),
    restartDesktopApp: vi.fn(),
  };
});

vi.mock('sonner', () => ({
  toast: {
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
const mockGetDesktopRestartState = vi.mocked(getDesktopRestartState);
const mockRestartDesktopApp = vi.mocked(restartDesktopApp);
const mockToastError = vi.mocked(toast.error);
const mockToastSuccess = vi.mocked(toast.success);
const mockFactoryReset = vi.mocked(factoryReset);
const jsdomUserAgent = navigator.userAgent;

describe('GeneralActionsContainer', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    Object.defineProperty(window.navigator, 'userAgent', { value: jsdomUserAgent, configurable: true });
  });

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
    mockGetDesktopRestartState.mockResolvedValue(null);
  });

  describe('after an update installed another desktop app version while this one was open', () => {
    beforeEach(() => {
      mockIsTauri.mockReturnValue(true);
      mockGetInstalledDesktopVersion.mockResolvedValue('0.2.77');
      mockCheckForUpdates.mockResolvedValue({
        currentVersion: '0.2.77',
        latestVersion: '0.2.78',
        downloadUrl: 'https://dl.ci.computer/v0.2.78/linux/deb/x64/Companion%20Hub_0.2.78_amd64.deb',
        updateAvailable: true,
        platform: 'linux',
        manualDownload: true,
      });
      mockGetDesktopRestartState.mockResolvedValue({ runningVersion: '0.2.77', installedVersion: '0.2.78', restartRequired: true });
    });

    it('asks for a restart instead of offering the download again', async () => {
      render(<GeneralActionsContainer />);

      const notice = await screen.findByTestId('desktop-restart-required');
      expect(notice).toHaveTextContent(
        'Companion Hub 0.2.78 is installed, but this window is still running 0.2.77. Restart the app to start using it.',
      );
      expect(screen.getByText(/This computer has Companion Hub 0.2.78 installed/)).toBeInTheDocument();
      expect(screen.queryByTestId('hub-shell-update-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('manual-update-instructions')).not.toBeInTheDocument();

      await userEvent.click(screen.getByTestId('desktop-restart-btn'));
      expect(mockRestartDesktopApp).toHaveBeenCalledTimes(1);
    });

    it('still asks when the new program did not say its version', async () => {
      mockGetDesktopRestartState.mockResolvedValue({ runningVersion: '0.2.77', installedVersion: null, restartRequired: true });
      render(<GeneralActionsContainer />);

      expect(await screen.findByTestId('desktop-restart-required')).toHaveTextContent(
        'A new version of Companion Hub is installed, but this window is still running 0.2.77.',
      );
      expect(screen.getByText(/This computer has Companion Hub 0.2.77 installed/)).toBeInTheDocument();
    });

    it('says how to restart by hand when the app refuses', async () => {
      mockRestartDesktopApp.mockResolvedValue(false);
      render(<GeneralActionsContainer />);

      await userEvent.click(await screen.findByTestId('desktop-restart-btn'));

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("Companion Hub couldn't restart itself. Quit it from the tray icon, then open it again."),
      );
      expect(screen.getByTestId('desktop-restart-btn')).toBeEnabled();
    });
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

  it('offers the desktop installer the Hub looked up when opened in a browser', async () => {
    const downloadUrl = 'https://dl.ci.computer/v0.2.77/linux/deb/x64/Companion%20Hub_0.2.77_amd64.deb';
    const actual = await vi.importActual<typeof import('@/lib/update-service')>('@/lib/update-service');
    mockCheckForUpdates.mockImplementation(actual.checkForUpdates);
    vi.stubEnv('CI_HUB_ENVIRONMENT', 'production');
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      configurable: true,
    });
    // A page cannot read the download server itself: it sends no CORS headers.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    getDesktopRelease.mockResolvedValue(sdkOk({ latestVersion: '0.2.77', downloadUrl }));
    mockPerformUpdate.mockResolvedValue({ ok: true, messageKey: 'SETTINGS_ACTIONS_DOWNLOAD_INSTALLER_OPENED' });

    render(<GeneralActionsContainer />);

    const download = await screen.findByTestId('hub-shell-update-btn');
    expect(download).toHaveTextContent('Download 0.2.77');
    expect(screen.queryByText('No download URL available for this platform.')).not.toBeInTheDocument();

    await userEvent.click(download);
    await waitFor(() => expect(mockPerformUpdate).toHaveBeenCalledWith(expect.objectContaining({ latestVersion: '0.2.77', downloadUrl })));
    expect(getDesktopRelease).toHaveBeenCalledWith({ query: { environment: 'production', platform: 'linux', arch: 'x86_64' } });
  });

  it('offers no desktop download on a phone', async () => {
    const actual = await vi.importActual<typeof import('@/lib/update-service')>('@/lib/update-service');
    mockCheckForUpdates.mockImplementation(actual.checkForUpdates);
    vi.stubEnv('CI_HUB_ENVIRONMENT', 'production');
    Object.defineProperty(window.navigator, 'userAgent', {
      value:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      configurable: true,
    });
    getDesktopRelease.mockResolvedValue(
      sdkOk({ latestVersion: '0.2.77', downloadUrl: 'https://dl.ci.computer/v0.2.77/macos/arm/Companion%20Hub_0.2.77_aarch64.dmg' }),
    );

    render(<GeneralActionsContainer />);

    // The card reads the same before the check ends, so wait for the check before looking at it.
    await waitFor(() => expect(mockCheckForUpdates.mock.settledResults).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('desktop-shell-update-card')).toHaveTextContent('No download URL available for this platform.'));
    expect(screen.queryByTestId('hub-shell-update-btn')).not.toBeInTheDocument();
    expect(getDesktopRelease).not.toHaveBeenCalled();
  });

  it('names the Auto-update stack switch after its title and keeps it from shrinking', async () => {
    render(<GeneralActionsContainer />);

    const toggle = await screen.findByRole('switch', { name: 'Auto-update stack' });
    expect(toggle).toHaveAccessibleDescription('Automatically pull and restart Docker stack images when updates are available');
    // jsdom does no layout. Without shrink-0, the description beside it squeezes the switch to a dot on a phone.
    expect(toggle).toHaveClass('shrink-0');
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

  it('asks for this device name before factory reset', async () => {
    mockUseAppContext.mockReturnValue({
      version: { current: '4.7.0', latest: '4.7.0', body: '', releases: [] },
      refreshAppContext: vi.fn(),
      userSettings: { ciHubDeviceSlug: 'core' },
    } as unknown as ReturnType<typeof useAppContext>);
    mockFactoryReset.mockResolvedValue({ data: { success: true } } as Awaited<ReturnType<typeof factoryReset>>);

    render(<GeneralActionsContainer />);

    await userEvent.click(await screen.findByTestId('factory-reset-btn'));
    expect(screen.getByLabelText('Type "core" to confirm')).toBeInTheDocument();
    expect(screen.queryByText('Type "factory-reset" to confirm')).not.toBeInTheDocument();

    const confirm = screen.getByTestId('factory-reset-confirm-btn');
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByTestId('factory-reset-confirmation-input'), 'factory-reset');
    expect(confirm).toBeDisabled();

    await userEvent.clear(screen.getByTestId('factory-reset-confirmation-input'));
    await userEvent.type(screen.getByTestId('factory-reset-confirmation-input'), 'core');
    expect(confirm).toBeEnabled();

    await userEvent.click(confirm);
    await waitFor(() => {
      expect(mockFactoryReset).toHaveBeenCalledWith({ body: { confirmation: 'core' } });
    });
  });
});
