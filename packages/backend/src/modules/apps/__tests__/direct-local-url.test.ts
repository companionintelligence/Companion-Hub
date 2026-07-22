import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppsService } from '../apps.service';

/**
 * `localUrl` is offered to the user as a route to CLICK ("Open on local
 * network"), so a false positive here reproduces the exact bug CI-Engineering#75
 * exists to remove: a button that leads nowhere.
 *
 * These pin the stricter rule — matching the frontend's `hasDirectLocalAccess`,
 * not the looser test the primary-route probe uses — for the two install shapes
 * that do NOT necessarily publish a host port.
 */
function makeService(internalIp = '192.168.1.9') {
  const configurationService = { getConfig: vi.fn().mockReturnValue({ userSettings: { internalIp } }) };

  // Only resolveDirectLocalUrl is under test; it touches nothing else on the
  // service, so the remaining collaborators stay unset.
  const service = Object.create(AppsService.prototype) as AppsService;
  Object.assign(service, { configurationService });

  return service as AppsService & { resolveDirectLocalUrl: (app: unknown, info: unknown) => string | undefined };
}

const APP = { port: 8080, exposureMode: 'local', exposedLocal: false, openPort: false };
const INFO = { url_suffix: '', dynamic_config: true };

beforeEach(() => vi.clearAllMocks());

describe('resolveDirectLocalUrl', () => {
  it('builds the LAN address for a locally-exposed app', () => {
    const service = makeService();

    expect(service.resolveDirectLocalUrl(APP, INFO)).toBe('http://192.168.1.9:8080');
  });

  it('builds it for a cloudflare-exposed app — the host port is bound regardless of the tunnel', () => {
    const service = makeService();

    // This is the case the whole feature turns on: the tunnel is down but the
    // app is still answering on the LAN.
    expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'cloudflare', exposedLocal: true }, INFO)).toBe('http://192.168.1.9:8080');
  });

  it('appends the manifest url_suffix', () => {
    const service = makeService();

    expect(service.resolveDirectLocalUrl(APP, { ...INFO, url_suffix: '/web' })).toBe('http://192.168.1.9:8080/web');
  });

  it('returns nothing without an allocated port', () => {
    const service = makeService();

    expect(service.resolveDirectLocalUrl({ ...APP, port: null }, INFO)).toBeUndefined();
  });

  describe('tailscale installs may not publish a host port', () => {
    it('offers nothing when openPort was not requested', () => {
      const service = makeService();

      expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'tailscale', exposedLocal: true }, INFO)).toBeUndefined();
    });

    it('offers the LAN address once openPort is set', () => {
      const service = makeService();

      expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'tailscale', openPort: true }, INFO)).toBe('http://192.168.1.9:8080');
    });
  });

  describe('pre-exposureMode installs', () => {
    it('offers nothing for a dynamic-config app with no published port', () => {
      const service = makeService();

      // A dynamic config binds no fixed host port, so there is no LAN address.
      expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: null }, { ...INFO, dynamic_config: true })).toBeUndefined();
    });

    it('offers the LAN address for a static-config app', () => {
      const service = makeService();

      expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: null }, { ...INFO, dynamic_config: false })).toBe('http://192.168.1.9:8080');
    });

    it('offers it for a dynamic-config app that explicitly opened a port', () => {
      const service = makeService();

      expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: null, openPort: true }, { ...INFO, dynamic_config: true })).toBe(
        'http://192.168.1.9:8080',
      );
    });
  });

  it('offers nothing when the internal IP is listen-all, unset, or loopback', () => {
    // Any address that resolveBrowserHost maps to loopback yields no LAN URL: as a
    // route to CLICK, http://127.0.0.1 points a non-loopback browser at its own
    // machine — the same dead button buildHubLocalOrigin refuses to produce. This
    // now also covers a genuine INTERNAL_IP of 127.0.0.1 / ::1, which the previous
    // explicit-string guard let through.
    expect(makeService('0.0.0.0').resolveDirectLocalUrl(APP, INFO)).toBeUndefined();
    expect(makeService('::').resolveDirectLocalUrl(APP, INFO)).toBeUndefined();
    expect(makeService('').resolveDirectLocalUrl(APP, INFO)).toBeUndefined();
    expect(makeService('127.0.0.1').resolveDirectLocalUrl(APP, INFO)).toBeUndefined();
    expect(makeService('::1').resolveDirectLocalUrl(APP, INFO)).toBeUndefined();
  });
});
