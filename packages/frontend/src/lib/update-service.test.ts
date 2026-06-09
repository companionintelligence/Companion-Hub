import { describe, it, expect } from 'vitest';
import { isHubUpdateAvailable, isStackUpdateAvailable, isTrustedDownloadUrl } from '@/lib/update-service';

describe('update-service', () => {
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
      };
      expect(isHubUpdateAvailable(true, desktopUpdate, '1.0.0', '1.0.0')).toBe(true);
      expect(isHubUpdateAvailable(true, null, '1.0.0', '1.2.0')).toBe(false);
    });
  });
});
