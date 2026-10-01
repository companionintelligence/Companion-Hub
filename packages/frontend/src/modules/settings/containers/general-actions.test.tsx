import { act, render, screen, userEvent, waitFor, within } from '@/tests/test-utils';
import { useAppContext } from '@/context/app-context';
import {
  checkForUpdates,
  type DesktopUpdateCallbacks,
  type DesktopUpdateOutcome,
  fetchHostListenerStatus,
  getDesktopRestartState,
  getInstalledDesktopVersion,
  installDesktopUpdate,
  isTauri,
  performUpdate,
  restartDesktopApp,
  type UpdateInfo,
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
    installDesktopUpdate: vi.fn(),
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
const mockInstallDesktopUpdate = vi.mocked(installDesktopUpdate);
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
    expect(await screen.findByTestId('hub-shell-install-btn')).toHaveTextContent('Update to 0.2.24');
    expect(screen.queryByTestId('hub-shell-update-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hub-update-btn')).not.toBeInTheDocument();
  });

  it('shows manual update instructions matching the installer format on linux', async () => {
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
    // The Hub can't reach the listener of a desktop app up to 0.2.77 even while the app runs.
    expect(mockFetchHostListenerStatus).toHaveBeenCalled();
    expect(screen.queryByTestId('host-listener-unavailable')).not.toBeInTheDocument();
    expect(screen.getByTestId('desktop-shell-update-card')).not.toHaveTextContent(/not running/i);
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

  it('tells a browser where to update the desktop app when the Hub cannot reach it', async () => {
    mockFetchHostListenerStatus.mockResolvedValue(false);

    render(<GeneralActionsContainer />);

    const where = await screen.findByTestId('host-listener-unavailable');
    expect(where).toHaveTextContent(
      'Open Companion Hub on the computer that runs this Hub and update it there, or run companion-hub update in a terminal on that computer.',
    );
    expect(where.querySelector('code')).toHaveTextContent('companion-hub update');
    expect(where).not.toHaveTextContent(/not running/i);
    expect(screen.queryByTestId('host-listener-ready')).not.toBeInTheDocument();
  });

  describe('in the desktop window', () => {
    function offerDesktopUpdate(downloadUrl = 'https://dl.ci.computer/v0.2.78/linux/deb/x64/Companion%20Hub_0.2.78_amd64.deb') {
      const update: UpdateInfo = {
        currentVersion: '0.2.77',
        latestVersion: '0.2.78',
        downloadUrl,
        updateAvailable: true,
        platform: 'linux',
        manualDownload: true,
      };
      mockIsTauri.mockReturnValue(true);
      mockGetInstalledDesktopVersion.mockResolvedValue('0.2.77');
      mockCheckForUpdates.mockResolvedValue(update);
      return update;
    }

    /** Lets a test drive the install: report steps, start the Hub again, then end it. */
    function controlInstall() {
      let callbacks: DesktopUpdateCallbacks = {};
      let finish: (outcome: DesktopUpdateOutcome) => void = () => {};
      mockInstallDesktopUpdate.mockImplementation((_info, given) => {
        callbacks = given ?? {};
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      return {
        progress: (phase: string) => act(() => callbacks.onProgress?.({ phase, message: '' })),
        restartingHub: () => act(() => callbacks.onRestartingHub?.()),
        finish: (outcome: DesktopUpdateOutcome) => act(() => finish(outcome)),
      };
    }

    it('installs the update in one click and shows its steps, with the password hint for a package', async () => {
      const update = offerDesktopUpdate();
      const install = controlInstall();

      render(<GeneralActionsContainer />);

      const button = await screen.findByTestId('hub-shell-install-btn');
      expect(button).toHaveTextContent('Update to 0.2.78');
      // Nothing to do by hand while the app can install the update itself.
      expect(screen.queryByTestId('manual-update-instructions')).not.toBeInTheDocument();
      expect(screen.queryByTestId('hub-shell-update-btn')).not.toBeInTheDocument();

      await userEvent.click(button);
      expect(mockInstallDesktopUpdate).toHaveBeenCalledWith(update, expect.any(Object));
      expect(mockPerformUpdate).not.toHaveBeenCalled();
      expect(screen.getByTestId('hub-shell-install-btn')).toBeDisabled();
      expect(screen.getByTestId('desktop-update-progress')).toHaveTextContent('Starting the update…');

      await install.progress('download');
      expect(screen.getByTestId('desktop-update-progress')).toHaveTextContent('Downloading Companion Hub 0.2.78…');
      await install.progress('install');
      expect(screen.getByTestId('desktop-update-progress')).toHaveTextContent(
        'Installing Companion Hub 0.2.78…Your computer may ask for your password.',
      );
      await install.progress('relaunch');
      expect(screen.getByTestId('desktop-update-progress')).toHaveTextContent(
        "Companion Hub 0.2.78 is installed. The app restarts now; if it doesn't come back, open Companion Hub again.",
      );
    });

    it('gives no password hint for an AppImage, which the app replaces itself', async () => {
      offerDesktopUpdate('https://dl.ci.computer/v0.2.78/linux/appimage/x64/Companion%20Hub_0.2.78_amd64.AppImage');
      const install = controlInstall();

      render(<GeneralActionsContainer />);
      await userEvent.click(await screen.findByTestId('hub-shell-install-btn'));
      await install.progress('install');

      expect(screen.getByTestId('desktop-update-progress')).toHaveTextContent('Installing Companion Hub 0.2.78…');
      expect(screen.getByTestId('desktop-update-progress')).not.toHaveTextContent('password');
    });

    it('starts the Hub again after a failed install, then offers the download and the steps', async () => {
      const update = offerDesktopUpdate();
      const install = controlInstall();
      mockPerformUpdate.mockResolvedValue({ ok: true, messageKey: 'SETTINGS_ACTIONS_DOWNLOAD_INSTALLER_OPENED' });

      render(<GeneralActionsContainer />);
      await userEvent.click(await screen.findByTestId('hub-shell-install-btn'));
      await install.progress('install');
      await install.restartingHub();
      expect(screen.getByTestId('desktop-update-progress')).toHaveTextContent("The update didn't install. Starting your Hub again…");

      await install.finish({ state: 'failed', reason: 'error', error: 'Package installation failed', hub: 'restarted' });

      const failed = screen.getByTestId('desktop-update-failed');
      expect(failed).toHaveTextContent("The update didn't install: Package installation failed");
      expect(failed).toHaveTextContent('The update had stopped your Hub, so it was started again.');
      expect(within(failed).getByTestId('manual-update-instructions')).toHaveTextContent('Then install the app');
      // Another try is one click away too.
      expect(screen.getByTestId('hub-shell-install-btn')).toBeEnabled();

      await userEvent.click(within(failed).getByTestId('hub-shell-update-btn'));
      await waitFor(() => expect(mockPerformUpdate).toHaveBeenCalledWith(update));
      expect(await within(failed).findByText('Installer download opened in your browser.')).toBeInTheDocument();
    });

    it('says when the Hub did not start again', async () => {
      offerDesktopUpdate();
      const install = controlInstall();

      render(<GeneralActionsContainer />);
      await userEvent.click(await screen.findByTestId('hub-shell-install-btn'));
      await install.finish({
        state: 'failed',
        reason: 'error',
        error: 'Package installation failed',
        hub: 'restart-failed',
        hubError: 'Docker is not running',
      });

      expect(screen.getByTestId('desktop-update-failed')).toHaveTextContent(
        "The update stopped your Hub, and it didn't start again: Docker is not running",
      );
    });

    it('offers the download when the desktop app is too old to install from here', async () => {
      offerDesktopUpdate();
      const install = controlInstall();

      render(<GeneralActionsContainer />);
      await userEvent.click(await screen.findByTestId('hub-shell-install-btn'));
      await install.finish({
        state: 'failed',
        reason: 'unsupported',
        error: 'Command perform_desktop_update_command not allowed by ACL',
        hub: 'running',
      });

      const failed = screen.getByTestId('desktop-update-failed');
      expect(failed).toHaveTextContent("This desktop app can't install updates from here. Download the installer instead.");
      expect(failed).not.toHaveTextContent('ACL');
      expect(within(failed).getByTestId('hub-shell-update-btn')).toHaveTextContent('Download 0.2.78');
      expect(within(failed).getByTestId('manual-update-instructions')).toBeInTheDocument();
    });

    it('says another install is already running, with nothing to do by hand', async () => {
      offerDesktopUpdate();
      const install = controlInstall();

      render(<GeneralActionsContainer />);
      await userEvent.click(await screen.findByTestId('hub-shell-install-btn'));
      await install.finish({ state: 'failed', reason: 'busy', error: 'Host update already in progress', hub: 'running' });

      expect(screen.getByTestId('desktop-update-busy')).toHaveTextContent(
        'The desktop app is already installing an update. It restarts when the update is done.',
      );
      expect(screen.queryByTestId('desktop-update-failed')).not.toBeInTheDocument();
      expect(screen.queryByTestId('manual-update-instructions')).not.toBeInTheDocument();
    });

    it('keeps the download when there is no newer version to install', async () => {
      mockIsTauri.mockReturnValue(true);
      mockGetInstalledDesktopVersion.mockResolvedValue('0.2.78');
      mockCheckForUpdates.mockResolvedValue({
        currentVersion: '0.2.78',
        latestVersion: '0.2.78',
        downloadUrl: 'https://dl.ci.computer/v0.2.78/linux/deb/x64/Companion%20Hub_0.2.78_amd64.deb',
        updateAvailable: false,
        platform: 'linux',
        manualDownload: true,
      });

      render(<GeneralActionsContainer />);

      expect(await screen.findByTestId('hub-shell-update-btn')).toHaveTextContent('Download 0.2.78');
      expect(screen.getByText('This computer is already on the latest desktop app. You can still download the installer.')).toBeInTheDocument();
      expect(screen.queryByTestId('hub-shell-install-btn')).not.toBeInTheDocument();
    });
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
