import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkForUpdates,
  getDesktopRestartState,
  getInstalledDesktopVersion,
  isHubUpdateAvailable,
  isStackUpdateAvailable,
  isTrustedDownloadUrl,
  manualUpdateFileName,
  performStackUpdate,
  performUpdate,
  requiresManualDesktopUpdate,
  restartDesktopApp,
} from '@/lib/update-service';
import { sdkFail, sdkOk } from '@/tests/sdk-mock-helpers';

const { mockSdkPerformUpdate, mockGetDesktopRelease } = vi.hoisted(() => ({
  mockSdkPerformUpdate: vi.fn(),
  mockGetDesktopRelease: vi.fn(),
}));

vi.mock('@/api-client/sdk.gen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api-client/sdk.gen')>();
  return {
    ...actual,
    performUpdate: (...args: unknown[]) => mockSdkPerformUpdate(...args),
    getDesktopRelease: (...args: unknown[]) => mockGetDesktopRelease(...args),
  };
});

const mockInvoke = vi.fn();
const mockOpenExternal = vi.fn();
const mockPlatform = vi.fn();
const mockArch = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/plugin-os', () => ({
  arch: (...args: unknown[]) => mockArch(...args),
  platform: (...args: unknown[]) => mockPlatform(...args),
}));

vi.mock('@/lib/helpers/open-external', () => ({
  openExternal: (...args: unknown[]) => mockOpenExternal(...args),
}));

const jsdomUserAgent = navigator.userAgent;
const MAC_SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const MAC_DMG_URL = 'https://dl.ci.computer/v0.2.77/macos/arm/Companion%20Hub_0.2.77_aarch64.dmg';
const MAC_CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function setBrowser(userAgent: string, maxTouchPoints = 0) {
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
}

/** Chromium's client hints; `architecture` is what it reports for the CPU, or the error it refuses with. */
function setClientHints(architecture: string | Error) {
  const getHighEntropyValues = vi.fn(() => (architecture instanceof Error ? Promise.reject(architecture) : Promise.resolve({ architecture })));
  Object.defineProperty(window.navigator, 'userAgentData', { value: { getHighEntropyValues }, configurable: true });
}

describe('update-service', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    Object.defineProperty(window.navigator, 'userAgent', { value: jsdomUserAgent, configurable: true });
    delete (window.navigator as { maxTouchPoints?: number }).maxTouchPoints;
    delete (window.navigator as { userAgentData?: unknown }).userAgentData;
  });

  beforeEach(() => {
    vi.stubEnv('CI_HUB_ENVIRONMENT', 'production');
  });

  it('rejects untrusted manual download URLs before opening them', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });

    await expect(
      performUpdate({
        currentVersion: '0.2.23',
        latestVersion: '0.2.24',
        downloadUrl: 'https://evil.example.com/file.dmg',
        updateAvailable: true,
        platform: 'linux',
        manualDownload: true,
      }),
    ).resolves.toEqual({
      ok: false,
      messageKey: 'SETTINGS_ACTIONS_UPDATE_NO_DOWNLOAD_URL',
    });
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('reads the desktop release version from Tauri for update checks', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });
    mockInvoke.mockResolvedValue('v0.2.24');

    await expect(getInstalledDesktopVersion()).resolves.toBe('0.2.24');
    expect(mockInvoke).toHaveBeenCalledWith('get_desktop_release_version_command');
  });

  it('asks the desktop app whether an update replaced it', async () => {
    await expect(getDesktopRestartState()).resolves.toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });
    mockInvoke.mockResolvedValueOnce({ runningVersion: '0.2.77', installedVersion: '0.2.78', restartRequired: true });
    await expect(getDesktopRestartState()).resolves.toEqual({ runningVersion: '0.2.77', installedVersion: '0.2.78', restartRequired: true });
    expect(mockInvoke).toHaveBeenCalledWith('get_desktop_restart_state_command');

    // Desktop apps from before the command reject it.
    mockInvoke.mockRejectedValueOnce(new Error('Command get_desktop_restart_state_command not found'));
    await expect(getDesktopRestartState()).resolves.toBeNull();
  });

  it('reports whether the desktop app took the restart', async () => {
    await expect(restartDesktopApp()).resolves.toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });
    mockInvoke.mockResolvedValueOnce(undefined);
    await expect(restartDesktopApp()).resolves.toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith('restart_desktop_app_command');

    mockInvoke.mockRejectedValueOnce('Companion Hub is already running the installed version');
    await expect(restartDesktopApp()).resolves.toBe(false);
  });

  it('uses the native tauri updater command for desktop update checks', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });
    mockPlatform.mockResolvedValue('linux');
    mockInvoke.mockResolvedValue({
      currentVersion: '0.2.24',
      latestVersion: '0.2.24',
      downloadUrl: '',
      updateAvailable: false,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    await expect(checkForUpdates('0.2.24')).resolves.toEqual({
      currentVersion: '0.2.24',
      latestVersion: '0.2.24',
      downloadUrl: '',
      updateAvailable: false,
      platform: 'linux',
      manualDownload: true,
    });
    expect(mockInvoke).toHaveBeenCalledWith('check_desktop_update_command');
    expect(mockGetDesktopRelease).not.toHaveBeenCalled();
  });

  it('falls back to the fetch path when the native tauri update check fails', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });
    mockPlatform.mockResolvedValue('linux');
    mockArch.mockResolvedValue('x86_64');
    mockInvoke.mockRejectedValue(new Error('native update check failed'));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ version: 'v0.2.25' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            version: '0.2.25',
            platforms: {
              'linux-x86_64': {
                deb: { url: 'https://dl.ci.computer/v0.2.25/linux/deb/x64/Companion%20Hub_0.2.25_amd64.deb', size: 123 },
              },
            },
          }),
        }),
    );

    await expect(checkForUpdates('0.2.24')).resolves.toEqual({
      currentVersion: '0.2.24',
      latestVersion: '0.2.25',
      downloadUrl: 'https://dl.ci.computer/v0.2.25/linux/deb/x64/Companion%20Hub_0.2.25_amd64.deb',
      updateAvailable: true,
      platform: 'linux',
      manualDownload: true,
    });
    expect(mockInvoke).toHaveBeenCalledWith('check_desktop_update_command');
    expect(mockGetDesktopRelease).not.toHaveBeenCalled();
  });

  describe('in a browser', () => {
    // What a page sees when it reads a download server that sends no CORS headers.
    const corsBlockedFetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));

    beforeEach(() => {
      setBrowser(MAC_SAFARI_UA);
      vi.stubGlobal('fetch', corsBlockedFetch);
    });

    it('asks the Hub for the release instead of reading the download server', async () => {
      mockGetDesktopRelease.mockResolvedValue(sdkOk({ latestVersion: 'v0.2.77', downloadUrl: MAC_DMG_URL }));

      await expect(checkForUpdates()).resolves.toEqual({
        currentVersion: '0.2.77',
        latestVersion: '0.2.77',
        downloadUrl: MAC_DMG_URL,
        updateAvailable: false,
        platform: 'macos',
        manualDownload: true,
      });
      expect(mockGetDesktopRelease).toHaveBeenCalledWith({ query: { environment: 'production', platform: 'macos', arch: 'aarch64' } });
      expect(corsBlockedFetch).not.toHaveBeenCalled();
    });

    it('drops an installer URL this page does not trust', async () => {
      vi.stubEnv('CI_HUB_ENVIRONMENT', 'dev');
      mockGetDesktopRelease.mockResolvedValue(sdkOk({ latestVersion: '0.2.77', downloadUrl: MAC_DMG_URL }));

      await expect(checkForUpdates()).resolves.toMatchObject({ latestVersion: '0.2.77', downloadUrl: '' });
      expect(mockGetDesktopRelease).toHaveBeenCalledWith({ query: { environment: 'dev', platform: 'macos', arch: 'aarch64' } });
    });

    it.each([
      ['the Hub found no release', () => sdkOk({ latestVersion: null, downloadUrl: null })],
      ['the Hub request fails', () => sdkFail(500)],
    ])('reports no update when %s', async (_case, response) => {
      mockGetDesktopRelease.mockResolvedValue(response());

      await expect(checkForUpdates()).resolves.toBeNull();
      expect(mockGetDesktopRelease).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'Windows',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        { platform: 'windows', arch: 'x86_64' },
        'https://dl.ci.computer/v0.2.77/windows/x64/Companion%20Hub_0.2.77_x64-setup.exe',
      ],
      ['macOS', MAC_SAFARI_UA, { platform: 'macos', arch: 'aarch64' }, MAC_DMG_URL],
      [
        'Linux',
        'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
        { platform: 'linux', arch: 'x86_64' },
        'https://dl.ci.computer/v0.2.77/linux/deb/x64/Companion%20Hub_0.2.77_amd64.deb',
      ],
    ])('offers the %s installer on a desktop browser', async (_os, userAgent, target, downloadUrl) => {
      setBrowser(userAgent);
      mockGetDesktopRelease.mockResolvedValue(sdkOk({ latestVersion: '0.2.77', downloadUrl }));

      await expect(checkForUpdates()).resolves.toMatchObject({ latestVersion: '0.2.77', downloadUrl, platform: target.platform });
      expect(mockGetDesktopRelease).toHaveBeenCalledWith({ query: { environment: 'production', ...target } });
    });

    // Chrome's user agent says "Intel Mac" on Apple silicon too; its client hints tell the two apart.
    it.each([
      ['an Intel Mac', 'x86', 'x86_64', 'https://dl.ci.computer/v0.2.77/macos/intel/Companion%20Hub_0.2.77_x64.dmg'],
      ['an Apple silicon Mac', 'arm', 'aarch64', MAC_DMG_URL],
    ])('asks for the installer that runs on %s when Chrome reports its CPU', async (_mac, architecture, arch, downloadUrl) => {
      setBrowser(MAC_CHROME_UA);
      setClientHints(architecture);
      mockGetDesktopRelease.mockResolvedValue(sdkOk({ latestVersion: '0.2.77', downloadUrl }));

      await expect(checkForUpdates()).resolves.toMatchObject({ latestVersion: '0.2.77', downloadUrl, platform: 'macos' });
      expect(mockGetDesktopRelease).toHaveBeenCalledWith({ query: { environment: 'production', platform: 'macos', arch } });
    });

    it('asks for the Windows on Arm installer when Chrome reports an Arm CPU', async () => {
      setBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
      setClientHints('arm');
      mockGetDesktopRelease.mockResolvedValue(sdkOk({ latestVersion: '0.2.77', downloadUrl: null }));

      await checkForUpdates();
      expect(mockGetDesktopRelease).toHaveBeenCalledWith({ query: { environment: 'production', platform: 'windows', arch: 'aarch64' } });
    });

    it('goes by the user agent when the browser refuses the client hint', async () => {
      setBrowser(MAC_CHROME_UA);
      setClientHints(new Error('NotAllowedError'));
      mockGetDesktopRelease.mockResolvedValue(sdkOk({ latestVersion: '0.2.77', downloadUrl: MAC_DMG_URL }));

      await checkForUpdates();
      expect(mockGetDesktopRelease).toHaveBeenCalledWith({ query: { environment: 'production', platform: 'macos', arch: 'aarch64' } });
    });

    it.each([
      [
        'an iPhone',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        5,
      ],
      [
        'an Android phone',
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
        5,
      ],
      [
        'an iPad',
        'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        5,
      ],
      // iPadOS Safari asks for desktop sites by default, so only the touch points give it away.
      ['an iPad that reports itself as a Mac', MAC_SAFARI_UA, 5],
    ])('offers %s no installer and does not ask the Hub', async (_device, userAgent, maxTouchPoints) => {
      setBrowser(userAgent, maxTouchPoints);
      mockGetDesktopRelease.mockResolvedValue(sdkOk({ latestVersion: '0.2.77', downloadUrl: MAC_DMG_URL }));

      await expect(checkForUpdates()).resolves.toBeNull();
      expect(mockGetDesktopRelease).not.toHaveBeenCalled();
      expect(corsBlockedFetch).not.toHaveBeenCalled();
    });
  });

  it('accepts dl.ci.computer HTTPS URLs for production builds', () => {
    expect(isTrustedDownloadUrl('https://dl.ci.computer/v0.2.18/macos/arm/Companion%20Hub_0.2.18_aarch64.dmg')).toBe(true);
  });

  it('accepts dl-dev.ci.computer HTTPS URLs for dev builds', () => {
    vi.stubEnv('CI_HUB_ENVIRONMENT', 'dev');
    expect(isTrustedDownloadUrl('https://dl-dev.ci.computer/v0.2.18/macos/arm/Companion%20Hub_0.2.18_aarch64.dmg')).toBe(true);
  });

  it('rejects non-HTTPS URLs', () => {
    expect(isTrustedDownloadUrl('http://dl.ci.computer/v0.2.18/file.dmg')).toBe(false);
  });

  it('rejects other hosts', () => {
    expect(isTrustedDownloadUrl('https://evil.example.com/file.dmg')).toBe(false);
  });

  it('rejects subdomain suffix attacks', () => {
    expect(isTrustedDownloadUrl('https://dl.ci.computer.evil.com/file.dmg')).toBe(false);
  });

  it('rejects host name embedded in query string', () => {
    expect(isTrustedDownloadUrl('https://evil.com/?dl.ci.computer')).toBe(false);
  });

  it('rejects path traversal segments', () => {
    expect(isTrustedDownloadUrl('https://dl.ci.computer/v0.2.18/../evil.dmg')).toBe(false);
  });

  it('rejects percent-encoded path traversal segments', () => {
    expect(isTrustedDownloadUrl('https://dl.ci.computer/v0.2.18/%2e%2e/evil.dmg')).toBe(false);
    expect(isTrustedDownloadUrl('https://dl.ci.computer/v0.2.18/%2E%2E/evil.dmg')).toBe(false);
    expect(isTrustedDownloadUrl('https://dl.ci.computer/v0.2.18/%252e%252e/evil.dmg')).toBe(false);
  });

  describe('isStackUpdateAvailable', () => {
    it('returns true when latest semver is greater than current', () => {
      expect(isStackUpdateAvailable('1.0.0', '1.1.0')).toBe(true);
    });

    it('returns false when versions match or current is newer', () => {
      expect(isStackUpdateAvailable('1.1.0', '1.1.0')).toBe(false);
      expect(isStackUpdateAvailable('1.2.0', '1.1.0')).toBe(false);
    });

    it('returns false for invalid semver', () => {
      expect(isStackUpdateAvailable('nightly', '1.1.0')).toBe(false);
    });
  });

  describe('isHubUpdateAvailable', () => {
    it('uses app-context versions in browser/stack mode', () => {
      expect(isHubUpdateAvailable(false, null, '1.0.0', '1.2.0')).toBe(true);
      expect(isHubUpdateAvailable(false, null, '1.2.0', '1.2.0')).toBe(false);
    });

    it('uses desktop manifest in Tauri mode', () => {
      const desktopUpdate = {
        currentVersion: '1.0.0',
        latestVersion: '1.2.0',
        downloadUrl: 'https://dl.ci.computer/file.dmg',
        updateAvailable: true,
        platform: 'macos' as const,
        manualDownload: false,
      };
      expect(isHubUpdateAvailable(true, desktopUpdate, '1.0.0', '1.0.0')).toBe(true);
      expect(isHubUpdateAvailable(true, null, '1.0.0', '1.2.0')).toBe(false);
    });
  });

  describe('manualUpdateFileName', () => {
    it.each([
      ['https://dl.ci.computer/v0.2.78/linux/deb/x64/Companion%20Hub_0.2.78_amd64.deb', 'Companion Hub_0.2.78_amd64.deb'],
      ['https://dl.ci.computer/v0.2.78/linux/rpm/arm/Companion%20Hub-0.2.78-1.aarch64.rpm', 'Companion Hub-0.2.78-1.aarch64.rpm'],
      ['https://dl.ci.computer/v0.2.78/linux/appimage/x64/Companion%20Hub_0.2.78_amd64.AppImage?x=1#top', 'Companion Hub_0.2.78_amd64.AppImage'],
      ['https://dl.ci.computer/v0.2.78/linux/deb/x64/companion-hub_0.2.78%2Bgit1_amd64.deb', 'companion-hub_0.2.78+git1_amd64.deb'],
    ])('reads %s as %s', (downloadUrl, fileName) => {
      expect(manualUpdateFileName(downloadUrl)).toBe(fileName);
    });

    it.each([
      ['a $', 'Companion%20Hub%24(id)_0.2.78_amd64.deb'],
      ['a backtick', 'Companion%60id%60.deb'],
      ['a double quote', 'Companion%22.deb'],
      ['a single quote', "Companion'.deb"],
      ['a backslash', 'Companion%5C.deb'],
      ['a !', 'Companion!.deb'],
      ['an encoded slash', '..%2F..%2Fevil.deb'],
      ['a non-ASCII letter', 'Compa%C3%B1ion.deb'],
      ['a broken escape', 'Companion%E0%A4%A.deb'],
      ['only dots', '..'],
      ['nothing', ''],
    ])('refuses a name with %s', (_case, segment) => {
      expect(manualUpdateFileName(`https://dl.ci.computer/v0.2.78/linux/deb/x64/${segment}`)).toBeNull();
    });
  });

  describe('requiresManualDesktopUpdate', () => {
    it('downloads an installer on every platform instead of replacing the running binary', () => {
      expect(requiresManualDesktopUpdate('linux')).toBe(true);
      expect(requiresManualDesktopUpdate('macos')).toBe(true);
      expect(requiresManualDesktopUpdate('windows')).toBe(true);
      expect(requiresManualDesktopUpdate(null)).toBe(true);
    });
  });

  it('opens a trusted installer URL instead of invoking the native updater', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });

    await expect(
      performUpdate({
        currentVersion: '0.2.23',
        latestVersion: '0.2.24',
        downloadUrl: 'https://dl.ci.computer/v0.2.24/macos/arm/Companion%20Hub_0.2.24_aarch64.dmg',
        updateAvailable: true,
        platform: 'macos',
        manualDownload: true,
      }),
    ).resolves.toEqual({
      ok: true,
      messageKey: 'SETTINGS_ACTIONS_DOWNLOAD_INSTALLER_OPENED',
      defaultMessage: 'Installer download opened in your browser.',
    });
    expect(mockOpenExternal).toHaveBeenCalledWith('https://dl.ci.computer/v0.2.24/macos/arm/Companion%20Hub_0.2.24_aarch64.dmg');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  describe('performStackUpdate', () => {
    it('uses host-started copy when the desktop listener accepts the update', async () => {
      mockSdkPerformUpdate.mockResolvedValue(sdkOk({ success: true, stack: 'skipped', host: 'started' }));

      await expect(performStackUpdate('1.1.0')).resolves.toEqual({
        ok: true,
        messageKey: 'SETTINGS_ACTIONS_UPDATE_HOST_STARTED',
        stack: 'skipped',
        host: 'started',
      });
    });

    it('uses stack-only copy when the desktop listener is unavailable', async () => {
      mockSdkPerformUpdate.mockResolvedValue(sdkOk({ success: true, stack: 'updating', host: 'unavailable' }));

      await expect(performStackUpdate('1.1.0')).resolves.toEqual({
        ok: true,
        messageKey: 'SETTINGS_ACTIONS_UPDATE_STACK_HOST_UNAVAILABLE',
        stack: 'updating',
        host: 'unavailable',
      });
    });
  });
});
