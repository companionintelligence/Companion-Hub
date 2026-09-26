import { describe, expect, it } from 'vitest';
import { publishesPublicWebRoute, storedExposureForm } from '../exposure.js';

describe('publishesPublicWebRoute', () => {
  it('is true for the cloudflare mode and for the legacy exposedLocal flag without a mode', () => {
    expect(publishesPublicWebRoute({ exposureMode: 'cloudflare' })).toBe(true);
    expect(publishesPublicWebRoute({ exposedLocal: true })).toBe(true);
  });

  it('is false when another mode is set, whatever exposedLocal says', () => {
    // Compose routes neither of these on the tunnel, so publishing them would end at Traefik's 404.
    expect(publishesPublicWebRoute({ exposureMode: 'local', exposedLocal: true })).toBe(false);
    expect(publishesPublicWebRoute({ exposureMode: 'tailscale', exposedLocal: true })).toBe(false);
    expect(publishesPublicWebRoute({})).toBe(false);
  });
});

describe('storedExposureForm', () => {
  it('reads the stored install form rather than the row columns', () => {
    // An install that sent no exposure settings: the row says exposed_local, the form says local.
    const noExposureInstall = { config: { openPort: true }, exposureMode: 'local', exposedLocal: true };

    expect(storedExposureForm(noExposureInstall)).toEqual({ exposureMode: undefined, exposedLocal: false });
    expect(publishesPublicWebRoute(storedExposureForm(noExposureInstall))).toBe(false);
  });

  it('keeps a legacy form that carried only exposedLocal public', () => {
    const legacyInstall = { config: { exposedLocal: true }, exposureMode: 'local', exposedLocal: true };

    expect(publishesPublicWebRoute(storedExposureForm(legacyInstall))).toBe(true);
  });

  it('ignores values that are not an exposure mode', () => {
    expect(storedExposureForm({ config: { exposureMode: 'internet', exposedLocal: 'yes' } })).toEqual({
      exposureMode: undefined,
      exposedLocal: false,
    });
  });

  it('falls back to the row columns only when there is no form', () => {
    expect(storedExposureForm({ exposureMode: 'cloudflare', exposedLocal: false })).toEqual({ exposureMode: 'cloudflare', exposedLocal: false });
    expect(storedExposureForm({ config: null, exposureMode: 'tailscale' })).toEqual({ exposureMode: 'tailscale', exposedLocal: false });
  });
});
