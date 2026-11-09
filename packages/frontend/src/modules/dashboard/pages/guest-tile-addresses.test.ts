import type { GuestAppsDto } from '@/api-client';
import { describe, expect, it } from 'vitest';
import { guestTileAddresses } from './guest-tile-addresses';

type Tile = GuestAppsDto['installed'][number];

const tile = (app: Partial<Tile['app']> = {}, info: Partial<Tile['info']> = {}) =>
  ({
    app: { port: 18850, exposed: false, domain: null, exposedLocal: true, openPort: false, publicUrl: 'https://app-dev-org.example.com', ...app },
    info: { port: 3000, dynamic_config: true, url_suffix: '', ...info },
  }) as unknown as Tile;

const offered = (data: Tile, viewerHostname: string, sslPort = 443) =>
  guestTileAddresses({ data, sslPort, publicDomain: 'example.com', viewerHostname }).map(({ url }) => url);

describe('guestTileAddresses', () => {
  it('offers a guest on the LAN the public address and the port on the host they came in on', () => {
    expect(offered(tile(), '192.168.1.20')).toEqual(['https://app-dev-org.example.com', 'http://192.168.1.20:18850']);
  });

  it('offers a tailnet name the same way', () => {
    expect(offered(tile(), 'hub.tailnet.example')).toEqual(['https://app-dev-org.example.com', 'http://hub.tailnet.example:18850']);
  });

  it('never offers a guest on another machine 127.0.0.1', () => {
    expect(offered(tile({ publicUrl: undefined }), '192.168.1.20')).toEqual(['http://192.168.1.20:18850']);
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
    expect(offered(tile({}, { url_suffix: '/ui', https: true }), '192.168.1.20')).toEqual([
      'https://app-dev-org.example.com/ui',
      'https://192.168.1.20:18850/ui',
    ]);
  });

  it('keeps the entry of an app with its own exposed domain, on the Hub HTTPS port', () => {
    expect(offered(tile({ publicUrl: undefined, exposed: true, domain: 'own.example.org' }), 'hub-dev-org.example.com', 8443)).toEqual([
      'https://own.example.org:8443',
    ]);
  });

  it('offers no port for an app that does not publish one', () => {
    expect(offered(tile({ exposedLocal: false, openPort: false, publicUrl: undefined }), '192.168.1.20')).toEqual([]);
  });
});
