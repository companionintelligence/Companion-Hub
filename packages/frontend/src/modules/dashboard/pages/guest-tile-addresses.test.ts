import type { GuestAppsDto } from '@/api-client';
import { describe, expect, it } from 'vitest';
import { guestTileAddresses } from './guest-tile-addresses';

type Tile = GuestAppsDto['installed'][number];

const tile = (app: Partial<Tile['app']> = {}, info: Partial<Tile['info']> = {}) =>
  ({
    app: { port: 18850, exposed: false, domain: null, exposedLocal: true, openPort: false, publicUrl: 'https://app-dev-org.example.com', ...app },
    info: { port: 3000, dynamic_config: true, url_suffix: '', ...info },
  }) as unknown as Tile;

/** An app whose port the operator opened on the network ("Open this app's port on your network"). */
const open = (app: Partial<Tile['app']> = {}, info: Partial<Tile['info']> = {}) => tile({ hostPortOnNetwork: true, ...app }, info);

const offered = (data: Tile, viewerHostname: string, sslPort = 443) =>
  guestTileAddresses({ data, sslPort, publicDomain: 'example.com', viewerHostname }).map(({ url }) => url);

describe('guestTileAddresses', () => {
  it('offers a guest on the LAN the public address and the port on the host they came in on', () => {
    expect(offered(open(), '192.168.1.20')).toEqual(['https://app-dev-org.example.com', 'http://192.168.1.20:18850']);
  });

  it('offers a tailnet name the same way', () => {
    expect(offered(open(), 'hub.tailnet.example')).toEqual(['https://app-dev-org.example.com', 'http://hub.tailnet.example:18850']);
  });

  it('never offers a guest on another machine 127.0.0.1', () => {
    expect(offered(open({ publicUrl: undefined }), '192.168.1.20')).toEqual(['http://192.168.1.20:18850']);
  });

  // The Hub publishes a host port on 127.0.0.1 unless the operator opened it on the network, so from another
  // computer `<host>:<port>` doesn't answer. A guest on the Hub's computer still gets 127.0.0.1.
  it('offers no port on the LAN or a tailnet name for an app whose port answers on 127.0.0.1 only', () => {
    for (const data of [tile(), tile({ hostPortOnNetwork: false })]) {
      expect(offered(data, '192.168.1.20')).toEqual(['https://app-dev-org.example.com']);
      expect(offered(data, 'hub.tailnet-abc.ts.net')).toEqual(['https://app-dev-org.example.com']);
      expect(offered(data, 'localhost')).toEqual(['https://app-dev-org.example.com', 'http://127.0.0.1:18850']);
    }
  });

  it('has nothing to offer another computer for a This machine only app with its port on 127.0.0.1', () => {
    const data = tile({ exposureMode: 'local', openPort: true, publicUrl: undefined });

    expect(offered(data, '192.168.1.20')).toEqual([]);
    expect(offered(data, 'localhost')).toEqual(['http://127.0.0.1:18850']);
  });

  it('keeps 127.0.0.1 for a browser on the Hub itself', () => {
    expect(offered(tile(), 'localhost')).toEqual(['https://app-dev-org.example.com', 'http://127.0.0.1:18850']);
    expect(offered(tile(), '127.0.0.1')).toEqual(['https://app-dev-org.example.com', 'http://127.0.0.1:18850']);
  });

  it('offers only the public address on the public hostname, where the tunnel carries 443 alone', () => {
    expect(offered(tile(), 'hub-dev-org.example.com')).toEqual(['https://app-dev-org.example.com']);
  });

  it('has nothing to offer from the public hostname for an app with no public address', () => {
    expect(offered(tile({ publicUrl: undefined }), 'hub-dev-org.example.com')).toEqual([]);
  });

  it('does not offer the LAN address of an app whose port stays on loopback, and still offers it on the Hub', () => {
    const data = tile({}, { hub_integration: { mcp_client: true } } as Partial<Tile['info']>);

    expect(offered(data, '192.168.1.20')).toEqual(['https://app-dev-org.example.com']);
    expect(offered(data, 'localhost')).toEqual(['https://app-dev-org.example.com', 'http://127.0.0.1:18850']);
  });

  it('appends the url suffix and the https scheme a manifest asks for', () => {
    expect(offered(open({}, { url_suffix: '/ui', https: true }), '192.168.1.20')).toEqual([
      'https://app-dev-org.example.com/ui',
      'https://192.168.1.20:18850/ui',
    ]);
  });

  it('keeps the entry of an app with its own exposed domain, on the Hub HTTPS port', () => {
    expect(offered(tile({ publicUrl: undefined, exposed: true, domain: 'own.example.org' }), 'hub-dev-org.example.com', 8443)).toEqual([
      'https://own.example.org:8443',
    ]);
  });

  it('offers no port on a Private VPN app that kept its host port closed, even where the row says otherwise', () => {
    const data = tile({ exposureMode: 'tailscale', exposedLocal: true, openPort: false, publicUrl: undefined });

    expect(offered(data, '192.168.1.20')).toEqual([]);
    expect(offered(data, 'localhost')).toEqual([]);
  });

  // A Private VPN app's port is published on 127.0.0.1 at most: Tailscale Serve holds it at the tailnet address.
  it('offers the port of a Private VPN app that asked for one on the Hub only, never on the LAN', () => {
    const data = tile({ exposureMode: 'tailscale', openPort: true, publicUrl: undefined });

    expect(offered(data, '192.168.1.20')).toEqual([]);
    expect(offered(data, 'localhost')).toEqual(['http://127.0.0.1:18850']);
  });

  it('links a Private VPN app over HTTPS on the tailnet name, with the host port open or closed', () => {
    const closed = tile({ exposureMode: 'tailscale', openPort: false, publicUrl: undefined });
    const open = tile({ exposureMode: 'tailscale', openPort: true, publicUrl: undefined });

    expect(offered(closed, 'Hub.tailnet-abc.ts.net')).toEqual(['https://hub.tailnet-abc.ts.net:18850']);
    expect(offered(open, 'hub.tailnet-abc.ts.net')).toEqual(['https://hub.tailnet-abc.ts.net:18850']);
  });

  // With Tailscale Services the app answers on 443 of its own name, and its port on the Hub's name is taken down.
  it("links a Private VPN app on its own Tailscale Service at that address, on the viewer's tailnet", () => {
    const data = tile({ exposureMode: 'tailscale', openPort: true, publicUrl: undefined, tailscaleServiceLabel: 'kuma' });

    expect(offered(data, 'Hub.tailnet-abc.ts.net')).toEqual(['https://kuma.tailnet-abc.ts.net/']);
    expect(offered(tile({ ...data.app, tailscaleServiceLabel: 'kuma' }, { url_suffix: '/dashboard' }), 'hub.tailnet-abc.ts.net')).toEqual([
      'https://kuma.tailnet-abc.ts.net/dashboard',
    ]);
    expect(guestTileAddresses({ data, sslPort: 443, publicDomain: 'example.com', viewerHostname: 'hub.tailnet-abc.ts.net' })[0]?.label).toBe(
      'kuma.tailnet-abc.ts.net',
    );
  });

  it('keeps the per-port address for a Private VPN app with no Service, and offers no Service off the tailnet', () => {
    const service = tile({ exposureMode: 'tailscale', openPort: true, publicUrl: undefined, tailscaleServiceLabel: 'kuma' });

    expect(offered(tile({ ...service.app, tailscaleServiceLabel: undefined }), 'hub.tailnet-abc.ts.net')).toEqual([
      'https://hub.tailnet-abc.ts.net:18850',
    ]);
    expect(offered(service, '192.168.1.20')).toEqual([]);
    expect(offered(service, 'localhost')).toEqual(['http://127.0.0.1:18850']);
  });

  it('keeps plain http for a port Tailscale Serve does not hold, on the tailnet name too', () => {
    expect(offered(open({ exposureMode: 'cloudflare' }), 'hub.tailnet-abc.ts.net')).toEqual([
      'https://app-dev-org.example.com',
      'http://hub.tailnet-abc.ts.net:18850',
    ]);
  });

  it('offers nothing for an app with no interface to open', () => {
    expect(offered(tile({}, { no_gui: true }), '192.168.1.20')).toEqual([]);
  });

  it('offers no port link for a port of 0', () => {
    expect(offered(open({ port: 0, publicUrl: undefined }, { port: undefined }), '192.168.1.20')).toEqual([]);
  });

  it('offers no port for an app that does not publish one', () => {
    expect(offered(tile({ exposedLocal: false, openPort: false, publicUrl: undefined }), '192.168.1.20')).toEqual([]);
    expect(offered(tile({ exposedLocal: false, openPort: false, publicUrl: undefined }), 'localhost')).toEqual([]);
  });
});
