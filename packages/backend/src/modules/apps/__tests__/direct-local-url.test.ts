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

  it('uses https for apps that declare an HTTPS local endpoint', () => {
    const service = makeService();

    expect(service.resolveDirectLocalUrl(APP, { ...INFO, https: true })).toBe('https://192.168.1.9:8080');
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

  // #2377: an app with a stored install form gets the link exactly when compose binds the host port.
  describe('apps with a stored install form', () => {
    it('offers the LAN address for a Private VPN form exposed on the local network, whatever the row says', () => {
      const service = makeService();
      const config = { exposureMode: 'tailscale', exposedLocal: true, openPort: false };

      expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'tailscale', config }, INFO)).toBe('http://192.168.1.9:8080');
    });

    it('offers nothing for a Private VPN form with a closed port, even where the row says exposedLocal', () => {
      const service = makeService();
      const config = { exposureMode: 'tailscale', openPort: false };

      expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'tailscale', exposedLocal: true, config }, INFO)).toBeUndefined();
    });

    it('offers nothing for a Public Web form with a closed port and no exposedLocal', () => {
      const service = makeService();
      const config = { exposureMode: 'cloudflare', openPort: false };

      expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'cloudflare', config }, INFO)).toBeUndefined();
    });

    it('offers the LAN address for a Public Web form that kept exposedLocal', () => {
      const service = makeService();
      const config = { exposureMode: 'cloudflare', exposedLocal: true, openPort: false };

      expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'cloudflare', config }, INFO)).toBe('http://192.168.1.9:8080');
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

describe('apps whose host port stays on loopback', () => {
  it('offers no LAN address for an MCP client, whose port is not published there', () => {
    const service = makeService();

    expect(service.resolveDirectLocalUrl(APP, { ...INFO, exposable: true, hub_integration: { mcp_client: true } })).toBeUndefined();
  });

  it('offers none for an app that asks for edge auth, in either mode that binds a host port', () => {
    const service = makeService();
    const info = { ...INFO, exposable: true, hub_integration: { edge_auth: { default: true } } };

    expect(service.resolveDirectLocalUrl(APP, info)).toBeUndefined();
    expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'cloudflare', exposedLocal: true }, info)).toBeUndefined();
  });
});
