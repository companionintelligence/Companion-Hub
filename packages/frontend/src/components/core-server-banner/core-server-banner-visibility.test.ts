import { describe, expect, it } from 'vitest';
import {
  detectClientPlatform,
  isCompanionCoreDevice,
  isBelowCoreServerHardwareThresholds,
  shouldShowCoreServerBanner,
} from './core-server-banner-visibility';

describe('core-server-banner visibility', () => {
  describe('isCompanionCoreDevice', () => {
    it('detects FRANM-prefixed Companion Core serials', () => {
      expect(isCompanionCoreDevice('FRANM12345')).toBe(true);
      expect(isCompanionCoreDevice('franm-core-9')).toBe(true);
    });

    it('returns false for other device IDs', () => {
      expect(isCompanionCoreDevice('00000000-0000-0000-0000-000000000000')).toBe(false);
      expect(isCompanionCoreDevice(undefined)).toBe(false);
    });
  });

  describe('shouldShowCoreServerBanner', () => {
    const lowSpec = { memoryTotal: 4, diskSize: 500, cpuCores: 8 };

    it('never shows on Linux', () => {
      expect(
        shouldShowCoreServerBanner({
          clientPlatform: 'linux',
          deviceId: 'random-id',
          system: lowSpec,
        }),
      ).toBe(false);
    });

    it('never shows on Companion Core devices', () => {
      expect(
        shouldShowCoreServerBanner({
          clientPlatform: 'windows',
          deviceId: 'FRANM99999',
          system: lowSpec,
        }),
      ).toBe(false);
    });

    it('shows on Windows when hardware is below thresholds', () => {
      expect(
        shouldShowCoreServerBanner({
          clientPlatform: 'windows',
          deviceId: 'laptop-serial',
          system: lowSpec,
        }),
      ).toBe(true);
    });

    it('shows on macOS when hardware is below thresholds', () => {
      expect(
        shouldShowCoreServerBanner({
          clientPlatform: 'macos',
          deviceId: 'mac-serial',
          system: { memoryTotal: 16, diskSize: 500, cpuCores: 2 },
        }),
      ).toBe(true);
    });

    it('hides on macOS/Windows when specs are adequate', () => {
      const adequate = { memoryTotal: 16, diskSize: 500, cpuCores: 8 };
      expect(
        shouldShowCoreServerBanner({
          clientPlatform: 'macos',
          deviceId: 'mac-serial',
          system: adequate,
        }),
      ).toBe(false);
    });

    it('waits for system metrics before showing', () => {
      expect(
        shouldShowCoreServerBanner({
          clientPlatform: 'windows',
          deviceId: 'laptop-serial',
          system: undefined,
        }),
      ).toBe(false);
    });
  });

  describe('isBelowCoreServerHardwareThresholds', () => {
    it('flags low RAM, disk, or CPU independently', () => {
      expect(isBelowCoreServerHardwareThresholds({ memoryTotal: 4, diskSize: 500, cpuCores: 8 })).toBe(true);
      expect(isBelowCoreServerHardwareThresholds({ memoryTotal: 16, diskSize: 50, cpuCores: 8 })).toBe(true);
      expect(isBelowCoreServerHardwareThresholds({ memoryTotal: 16, diskSize: 500, cpuCores: 2 })).toBe(true);
      expect(isBelowCoreServerHardwareThresholds({ memoryTotal: 16, diskSize: 500, cpuCores: 8 })).toBe(false);
    });
  });

  describe('detectClientPlatform', () => {
    it('classifies user agent strings', () => {
      const original = navigator.userAgent;
      const originalPlatform = navigator.platform;

      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Windows NT 10.0)' });
      Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
      expect(detectClientPlatform()).toBe('windows');

      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' });
      Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
      expect(detectClientPlatform()).toBe('macos');

      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (X11; Linux x86_64)' });
      Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
      expect(detectClientPlatform()).toBe('linux');

      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: original });
      Object.defineProperty(navigator, 'platform', { configurable: true, value: originalPlatform });
    });
  });
});
