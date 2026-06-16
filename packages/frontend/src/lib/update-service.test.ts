import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getInstalledDesktopVersion,
  isHubUpdateAvailable,
  isStackUpdateAvailable,
  isTrustedDownloadUrl,
  platformManifestKey,
  requiresManualDesktopUpdate,
} from '@/lib/update-service';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe('update-service', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

  it('accepts dl.ci.computer HTTPS URLs', () => {
    expect(isTrustedDownloadUrl('https://dl.ci.computer/v0.2.18/macos/arm/Companion%20Hub_0.2.18_aarch64.dmg')).toBe(true);
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
