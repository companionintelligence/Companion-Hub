import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkForUpdates,
  getInstalledDesktopVersion,
  isHubUpdateAvailable,
  isStackUpdateAvailable,
  isTrustedDownloadUrl,
  performUpdate,
  platformManifestKey,
  requiresManualDesktopUpdate,
} from '@/lib/update-service';

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

describe('update-service', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

    await expect(checkForUpdates('0.2.24')).resolves.toEqual({
      currentVersion: '0.2.24',
      latestVersion: '0.2.24',
      downloadUrl: '',
      updateAvailable: false,
      platform: 'linux',
      manualDownload: true,
    });
    expect(mockInvoke).toHaveBeenCalledWith('check_desktop_update_command');
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

  describe('platformManifestKey', () => {
    it('maps all release-matrix platform/arch pairs', () => {
      expect(platformManifestKey('macos', 'aarch64')).toBe('darwin-aarch64');
      expect(platformManifestKey('macos', 'x86_64')).toBe('darwin-x86_64');
      expect(platformManifestKey('windows', 'aarch64')).toBe('windows-aarch64');
      expect(platformManifestKey('windows', 'x86_64')).toBe('windows-x86_64');
      expect(platformManifestKey('linux', 'aarch64')).toBe('linux-aarch64');
      expect(platformManifestKey('linux', 'x86_64')).toBe('linux-x86_64');
    });

    it('returns null for unknown platforms', () => {
      expect(platformManifestKey('freebsd', 'x86_64')).toBeNull();
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

  describe('requiresManualDesktopUpdate', () => {
    it('requires manual installer downloads on linux only', () => {
      expect(requiresManualDesktopUpdate('linux')).toBe(true);
      expect(requiresManualDesktopUpdate('macos')).toBe(false);
      expect(requiresManualDesktopUpdate('windows')).toBe(false);
      expect(requiresManualDesktopUpdate(null)).toBe(false);
    });
  });
});
