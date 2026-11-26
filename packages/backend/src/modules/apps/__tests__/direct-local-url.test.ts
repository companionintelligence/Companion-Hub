import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppsService } from '../apps.service';

/**
 * `localUrl` is offered to the user as a route to CLICK ("Open on local
 * network"), so a false positive here reproduces the exact bug CI-Engineering#75
 * exists to remove: a button that leads nowhere.
 *
 * These pin the rule: another computer reaches the app on its port only where compose
 * publishes that port on every interface, which it does only when the operator opened
 * it on the network ("Open this app's port on your network", `portOnNetwork`). Any
 * other port is on 127.0.0.1, where the LAN address refuses the connection.
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
/** A This machine only app whose port the operator opened on the network. */
const ON_NETWORK = { ...APP, config: { exposureMode: 'local', openPort: true, portOnNetwork: true } };

beforeEach(() => vi.clearAllMocks());

describe('resolveDirectLocalUrl', () => {
  it('builds the LAN address for an app whose port the operator opened on the network', () => {
    const service = makeService();

    expect(service.resolveDirectLocalUrl(ON_NETWORK, INFO)).toBe('http://192.168.1.9:8080');
  });

  it('builds it for a Public web app with the port opened on the network: the host port is bound regardless of the tunnel', () => {
    const service = makeService();
    const config = { exposureMode: 'cloudflare', exposedLocal: true, portOnNetwork: true };

    // This is the case the whole feature turns on: the tunnel is down but the
    // app is still answering on the LAN.
    expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'cloudflare', exposedLocal: true, config }, INFO)).toBe('http://192.168.1.9:8080');
  });

  it('appends the manifest url_suffix', () => {
    const service = makeService();

    expect(service.resolveDirectLocalUrl(ON_NETWORK, { ...INFO, url_suffix: '/web' })).toBe('http://192.168.1.9:8080/web');
  });

  it('uses https for apps that declare an HTTPS local endpoint', () => {
    const service = makeService();

    expect(service.resolveDirectLocalUrl(ON_NETWORK, { ...INFO, https: true })).toBe('https://192.168.1.9:8080');
  });

  it('returns nothing without an allocated port', () => {
    const service = makeService();

    expect(service.resolveDirectLocalUrl({ ...ON_NETWORK, port: null }, INFO)).toBeUndefined();
  });

  // Compose publishes a host port on 127.0.0.1 unless the operator opened it on the network, so the LAN
  // address refuses the connection there, from the Hub's own computer too.
  describe('a port the operator did not open on the network', () => {
    it('offers nothing for This machine only with the switch off or never set', () => {
      const service = makeService();

      for (const config of [
        { exposureMode: 'local', openPort: true },
        { exposureMode: 'local', openPort: true, portOnNetwork: false },
      ]) {
        expect(service.resolveDirectLocalUrl({ ...APP, openPort: true, config }, INFO)).toBeUndefined();
      }
    });

    it('offers nothing for a Public web app that kept its host port, while the tunnel is down too', () => {
      const service = makeService();
      const config = { exposureMode: 'cloudflare', exposedLocal: true, openPort: false };

      expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'cloudflare', exposedLocal: true, config }, INFO)).toBeUndefined();
    });
  });

  // A Private VPN app's port is on 127.0.0.1 at most: Tailscale Serve holds it at the tailnet address.
  describe('tailscale installs offer no LAN address', () => {
    it('offers nothing when openPort was not requested', () => {
      const service = makeService();

      expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'tailscale', exposedLocal: true }, INFO)).toBeUndefined();
    });

    it('offers nothing when the row says openPort either', () => {
      const service = makeService();

      expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'tailscale', openPort: true }, INFO)).toBeUndefined();
    });
  });

  // #2377: an app with a stored install form gets the link exactly when compose binds the host port on the network.
  describe('apps with a stored install form', () => {
    // Compose binds a Private VPN form's port on 127.0.0.1 only, even opened on the network: Tailscale Serve holds it.
    it('offers nothing for a Private VPN form, with exposedLocal, an open port or the port opened on the network', () => {
      const service = makeService();

      for (const config of [
        { exposureMode: 'tailscale', exposedLocal: true, openPort: false },
        { exposureMode: 'tailscale', openPort: true },
        { exposureMode: 'tailscale', openPort: true, portOnNetwork: true },
      ]) {
        expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'tailscale', openPort: true, config }, INFO)).toBeUndefined();
      }
    });

    it('offers nothing for a Private VPN form with a closed port, even where the row says exposedLocal', () => {
      const service = makeService();
      const config = { exposureMode: 'tailscale', openPort: false };

      expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'tailscale', exposedLocal: true, config }, INFO)).toBeUndefined();
    });

    it('offers nothing for a Public Web form with a closed port and no exposedLocal, even opened on the network', () => {
      const service = makeService();
      const config = { exposureMode: 'cloudflare', openPort: false, portOnNetwork: true };

      expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'cloudflare', config }, INFO)).toBeUndefined();
    });
  });

  // Compose generates them from an empty form, which publishes the port on 127.0.0.1 at most.
  it('offers nothing for a record with no stored form, whatever its row says', () => {
    const service = makeService();

    expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: null }, { ...INFO, dynamic_config: false })).toBeUndefined();
    expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: null, openPort: true }, INFO)).toBeUndefined();
    expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'cloudflare', exposedLocal: true }, INFO)).toBeUndefined();
  });

  it('offers nothing when the internal IP is listen-all, unset, or loopback', () => {
    // Any address that resolveBrowserHost maps to loopback yields no LAN URL: as a
    // route to CLICK, http://127.0.0.1 points a non-loopback browser at its own
    // machine — the same dead button buildHubLocalOrigin refuses to produce. This
    // now also covers a genuine INTERNAL_IP of 127.0.0.1 / ::1, which the previous
    // explicit-string guard let through.
    expect(makeService('0.0.0.0').resolveDirectLocalUrl(ON_NETWORK, INFO)).toBeUndefined();
    expect(makeService('::').resolveDirectLocalUrl(ON_NETWORK, INFO)).toBeUndefined();
    expect(makeService('').resolveDirectLocalUrl(ON_NETWORK, INFO)).toBeUndefined();
    expect(makeService('127.0.0.1').resolveDirectLocalUrl(ON_NETWORK, INFO)).toBeUndefined();
    expect(makeService('::1').resolveDirectLocalUrl(ON_NETWORK, INFO)).toBeUndefined();
  });
});

describe('apps whose host port stays on loopback', () => {
  it('offers no LAN address for an MCP client, whose port is not published there', () => {
    const service = makeService();

    expect(service.resolveDirectLocalUrl(ON_NETWORK, { ...INFO, exposable: true, hub_integration: { mcp_client: true } })).toBeUndefined();
  });

  it('offers none for an app that asks for edge auth, in either mode that binds a host port', () => {
    const service = makeService();
    const info = { ...INFO, exposable: true, hub_integration: { edge_auth: { default: true } } };
    const publicWeb = { exposureMode: 'cloudflare', exposedLocal: true, portOnNetwork: true };

    expect(service.resolveDirectLocalUrl(ON_NETWORK, info)).toBeUndefined();
    expect(service.resolveDirectLocalUrl({ ...APP, exposureMode: 'cloudflare', exposedLocal: true, config: publicWeb }, info)).toBeUndefined();
  });
});
