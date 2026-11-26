import { describe, expect, it } from 'vitest';
import { getEffectiveExposureMode, publishesHostPort } from '../app-exposure.helpers';

describe('app-exposure.helpers', () => {
  describe('getEffectiveExposureMode', () => {
    it('defaults to local when exposureMode is omitted and exposedLocal is false', () => {
      expect(getEffectiveExposureMode({})).toBe('local');
    });

    it('defaults to cloudflare when exposedLocal is true and exposureMode is omitted', () => {
      expect(getEffectiveExposureMode({ exposedLocal: true })).toBe('cloudflare');
    });
  });

  describe('publishesHostPort', () => {
    it('returns true for local exposure even when openPort is false', () => {
      expect(publishesHostPort({ exposureMode: 'local', openPort: false })).toBe(true);
    });

    it('returns true for cloudflare exposedLocal even when openPort is false', () => {
      expect(publishesHostPort({ exposureMode: 'cloudflare', exposedLocal: true, openPort: false })).toBe(true);
    });

    it('returns false for cloudflare without exposedLocal and openPort false', () => {
      expect(publishesHostPort({ exposureMode: 'cloudflare', exposedLocal: false, openPort: false })).toBe(false);
    });

    // The queue defaults a missing `openPort` to open, so compose publishes the port for such a form.
    it('returns true for a form with no openPort, whatever its exposure mode', () => {
      expect(publishesHostPort({ exposureMode: 'cloudflare', exposedLocal: false })).toBe(true);
      expect(publishesHostPort({ exposureMode: 'tailscale' })).toBe(true);
    });

    it('returns true when openPort is true regardless of exposure mode', () => {
      expect(publishesHostPort({ exposureMode: 'tailscale', exposedLocal: false, openPort: true })).toBe(true);
    });
  });
});
