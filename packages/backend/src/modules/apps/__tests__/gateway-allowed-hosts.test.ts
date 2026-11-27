import { describe, expect, it } from 'vitest';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { buildOriginServerName } from '@ci-hub/common/types';
import { cloudflareOriginHostnameFor } from '../app-public-routing.helpers';
import { DOCKER_HOST_ALIAS, gatewayAllowedHosts, gatewayHostNameRefusal, TAILNET_HOST_SUFFIX } from '../gateway-allowed-hosts';

const MEMORY = createAppUrn('ci-memory', 'ci-marketplace');
const base = { portOnNetwork: false, privateVpn: false, appName: 'ci-memory', appStoreId: 'ci-marketplace' };

describe('gatewayAllowedHosts', () => {
  it('lists the tunnel Host, every tailnet name and the Docker host alias', () => {
    expect(gatewayAllowedHosts({ ...base, originHostname: 'CI-Memory-Hub-Kyle.ci.computer' })).toEqual([
      'ci-memory-hub-kyle.ci.computer',
      DOCKER_HOST_ALIAS,
      TAILNET_HOST_SUFFIX,
    ]);
  });

  it('adds the Private VPN router name on Private VPN', () => {
    expect(gatewayAllowedHosts({ ...base, privateVpn: true })).toEqual(['ci-memory.ci-marketplace', DOCKER_HOST_ALIAS, TAILNET_HOST_SUFFIX]);
  });

  it('still lists the names it knows on This machine only, where a browser here uses 127.0.0.1 or localhost', () => {
    expect(gatewayAllowedHosts(base)).toEqual([DOCKER_HOST_ALIAS, TAILNET_HOST_SUFFIX]);
  });

  // A browser elsewhere uses whatever name the LAN gives this computer: a router's or mDNS name.
  it('adds the LAN suffixes when the port is open on the network', () => {
    expect(gatewayAllowedHosts({ ...base, portOnNetwork: true, originHostname: 'ci-memory-hub-kyle.ci.computer' })).toEqual([
      'ci-memory-hub-kyle.ci.computer',
      DOCKER_HOST_ALIAS,
      TAILNET_HOST_SUFFIX,
      '.local',
      '.lan',
      '.home',
      '.home.arpa',
      '.internal',
    ]);
  });

  it("adds the operator's names in every mode, lower case and once each, and leaves out ones it can't take", () => {
    expect(
      gatewayAllowedHosts({
        ...base,
        operatorNames: ['Kyle-PC.fritz.box', '.fritz.box', 'kyle-pc.fritz.box', '.com', '.co.uk', 'http://x.example', 42, '.ts.net'],
      }),
    ).toEqual([DOCKER_HOST_ALIAS, TAILNET_HOST_SUFFIX, 'kyle-pc.fritz.box', '.fritz.box']);
    expect(gatewayAllowedHosts({ ...base, operatorNames: 'kyle-pc.fritz.box' })).toEqual([DOCKER_HOST_ALIAS, TAILNET_HOST_SUFFIX]);
  });
});

describe('gatewayHostNameRefusal', () => {
  it.each(['kyle-pc.fritz.box', 'memory.example.com', '.fritz.box', '.corp.example.com', '.lan', '.home.arpa', '.local', '.ts.net', 'kyle-pc'])(
    'takes %s',
    (name) => {
      expect(gatewayHostNameRefusal(name)).toBeNull();
    },
  );

  it.each(['http://memory.lan', 'memory.lan:8642', 'memory.lan/x', '-bad.lan', '.', '..lan', '', 'a b'])('refuses %j as no host name', (name) => {
    expect(gatewayHostNameRefusal(name)).toBe('invalid');
  });

  // Each covers names anyone can register.
  it.each(['.com', '.co.uk', '.github.io', '.corp', '.CO.UK'])('refuses %s as too wide', (name) => {
    expect(gatewayHostNameRefusal(name)).toBe('too-wide');
  });
});

describe('cloudflareOriginHostnameFor', () => {
  const org = { hubSubdomain: 'hub-kyle', slug: 'kyle' };

  it('is the name the tunnel router is written for, on Public web only', () => {
    const form = { exposureMode: 'cloudflare' as const, localSubdomain: 'memory' };
    expect(cloudflareOriginHostnameFor(form, MEMORY, org, 'ci.computer')).toBe(
      buildOriginServerName({ appSubdomain: 'memory', hubSubdomain: 'hub-kyle', orgSlug: 'kyle', localDomain: 'ci.computer' }),
    );
    expect(cloudflareOriginHostnameFor({ exposureMode: 'local' }, MEMORY, org, 'ci.computer')).toBeUndefined();
    expect(cloudflareOriginHostnameFor({ exposureMode: 'tailscale' }, MEMORY, org, 'ci.computer')).toBeUndefined();
  });

  it('falls back to <app>-<store> and to the bare subdomain on an unregistered Hub', () => {
    expect(cloudflareOriginHostnameFor({ exposedLocal: true }, MEMORY, null, 'ci.lan')).toBe('ci-memory-ci-marketplace.ci.lan');
  });
});
