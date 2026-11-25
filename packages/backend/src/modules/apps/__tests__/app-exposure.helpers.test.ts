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
    it('returns true for a form with no openPort outside Private VPN', () => {
      expect(publishesHostPort({ exposureMode: 'cloudflare', exposedLocal: false })).toBe(true);
      expect(publishesHostPort({})).toBe(true);
    });

    it('returns true when openPort is true outside Private VPN', () => {
      expect(publishesHostPort({ exposureMode: 'cloudflare', exposedLocal: false, openPort: true })).toBe(true);
    });

    // Tailscale Serve listens on the same port, so a host publish would answer the Hub's own computer in its place.
    it('returns false for Private VPN with an open port, a missing one or exposedLocal', () => {
      expect(publishesHostPort({ exposureMode: 'tailscale', exposedLocal: false, openPort: true })).toBe(false);
      expect(publishesHostPort({ exposureMode: 'tailscale' })).toBe(false);
      expect(publishesHostPort({ exposureMode: 'tailscale', exposedLocal: true, openPort: false })).toBe(false);
    });
  });
});
