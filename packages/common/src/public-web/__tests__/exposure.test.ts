import { describe, expect, it } from 'vitest';
import { publishesHostPort, publishesPublicWebRoute, servedExposureMode, storedExposureForm, storedHostPortForm } from '../exposure.js';

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

describe('servedExposureMode', () => {
  it('is This Machine Only for a form that names no mode, whatever the row says', () => {
    // A custom app's form holds only its port.
    expect(servedExposureMode({ config: { port: 9898 }, exposureMode: 'local', exposedLocal: false })).toBe('local');
    // An install that sent no exposure settings: compose runs it local, so that is the mode it is in.
    expect(servedExposureMode({ config: { openPort: true }, exposureMode: 'cloudflare', exposedLocal: true })).toBe('local');
  });

  it('is the mode the form names', () => {
    expect(servedExposureMode({ config: { exposureMode: 'tailscale' }, exposureMode: 'local' })).toBe('tailscale');
    expect(servedExposureMode({ config: { exposureMode: 'cloudflare', exposedLocal: false } })).toBe('cloudflare');
  });

  it('is Public Web for a legacy form that carried only exposedLocal', () => {
    expect(servedExposureMode({ config: { exposedLocal: true }, exposureMode: 'local' })).toBe('cloudflare');
  });

  it('reads the row only when there is no form', () => {
    expect(servedExposureMode({ exposureMode: 'tailscale' })).toBe('tailscale');
    expect(servedExposureMode({ exposedLocal: true })).toBe('cloudflare');
    expect(servedExposureMode({})).toBe('local');
  });
});

describe('storedHostPortForm', () => {
  it('reads openPort and the exposure from the stored install form rather than the row columns', () => {
    const app = {
      config: { exposureMode: 'tailscale', exposedLocal: true, openPort: false },
      exposureMode: 'local',
      exposedLocal: false,
      openPort: true,
    };

    expect(storedHostPortForm(app)).toEqual({ exposureMode: 'tailscale', exposedLocal: true, openPort: false });
  });

  it('leaves openPort out when the form holds none, so the served default applies', () => {
    expect(storedHostPortForm({ config: { exposureMode: 'cloudflare' }, openPort: false })).toEqual({
      exposureMode: 'cloudflare',
      exposedLocal: false,
      openPort: undefined,
    });
  });

  // The row's exposed_local is true for any exposable app installed without exposure settings, so it cannot stand in.
  it('is undefined for a record that carries no form', () => {
    expect(storedHostPortForm({ exposureMode: 'tailscale', exposedLocal: true, openPort: false })).toBeUndefined();
    expect(storedHostPortForm({ config: null })).toBeUndefined();
  });
});

describe('publishesHostPort', () => {
  it('is true for a Private VPN form that asked to be exposed on the local network', () => {
    expect(publishesHostPort({ exposureMode: 'tailscale', exposedLocal: true, openPort: false })).toBe(true);
  });

  it('is false for a Private VPN or Public Web form with a closed port and no exposedLocal', () => {
    expect(publishesHostPort({ exposureMode: 'tailscale', openPort: false })).toBe(false);
    expect(publishesHostPort({ exposureMode: 'cloudflare', openPort: false })).toBe(false);
  });

  it('is true for This Machine Only and for a form with no openPort, as the queue serves it open', () => {
    expect(publishesHostPort({ exposureMode: 'local', openPort: false })).toBe(true);
    expect(publishesHostPort({ exposureMode: 'tailscale' })).toBe(true);
  });
});
