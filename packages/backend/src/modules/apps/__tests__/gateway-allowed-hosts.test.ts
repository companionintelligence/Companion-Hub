import { describe, expect, it } from 'vitest';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { buildOriginServerName } from '@ci-hub/common/types';
import { cloudflareOriginHostnameFor } from '../app-public-routing.helpers';
import { DOCKER_HOST_ALIAS, gatewayAllowedHosts, TAILNET_HOST_SUFFIX } from '../gateway-allowed-hosts';

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

  // A browser elsewhere uses whatever name the LAN gives this computer, which the Hub cannot list.
  it('is null when the port is open on the network, so the gateway answers every Host', () => {
    expect(gatewayAllowedHosts({ ...base, portOnNetwork: true, originHostname: 'ci-memory-hub-kyle.ci.computer' })).toBeNull();
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
