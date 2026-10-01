import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

// The shared test setup mocks `fs`; these assertions are ABOUT the real files on disk.
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

const REPO_ROOT = path.join(__dirname, '../../../..');
const COMPOSE_COPIES = ['docker-compose.prod.yml', 'packages/desktop/src-tauri/resources/docker-compose.prod.yml'];

type ComposeNetwork = { name?: string; internal?: boolean; enable_ipv6?: boolean } | null;
type ServiceNetworks = string[] | Record<string, { gw_priority?: number } | null>;
type Compose = {
  services: Record<string, { networks?: ServiceNetworks }>;
  networks: Record<string, ComposeNetwork>;
};

/** The networks a service joins, by compose key, with the `gw_priority` it gives each (Docker's default is 0). */
function joinedNetworks(networks: ServiceNetworks | undefined): { key: string; gwPriority: number }[] {
  if (!networks) return [];
  if (Array.isArray(networks)) return networks.map((key) => ({ key, gwPriority: 0 }));
  return Object.entries(networks).map(([key, config]) => ({ key, gwPriority: config?.gw_priority ?? 0 }));
}

/**
 * The Docker network a service's own outbound connections leave through, picked the way Docker
 * picks a container's default gateway: never an `internal` network, which has no gateway, and
 * among the rest the highest `gw_priority`, then a dual-stack one, then the name that sorts first.
 */
function defaultRouteNetwork(compose: Compose, service: string): string | undefined {
  const candidates = joinedNetworks(compose.services[service].networks).flatMap(({ key, gwPriority }) => {
    const network = compose.networks[key];
    return network?.internal ? [] : [{ name: network?.name ?? key, gwPriority, dualStack: network?.enable_ipv6 === true }];
  });
  candidates.sort(
    (a, b) => b.gwPriority - a.gwPriority || Number(b.dualStack) - Number(a.dualStack) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return candidates[0]?.name;
}

/*
 * Traefik trusts the forwarded client address from two fixed addresses on the edge network, so the
 * network's shape is part of the security boundary, in every copy of the stack file.
 */
describe.each(COMPOSE_COPIES)('%s edge network', (relativePath) => {
  const compose = YAML.parse(readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8'));

  it('leaves Docker no address to hand out on it, so nothing can join at a hop address', () => {
    // Measured on Docker 29.8: with this range a container joining without a fixed address
    // (`network_mode: ci-hub_edge`) is refused, while the fixed members start.
    expect(compose.networks.ci_hub_edge.ipam.config).toEqual([
      { subnet: '${HUB_EDGE_SUBNET:-10.128.0.0/29}', ip_range: '${HUB_EDGE_IP_RANGE:-10.128.0.0/31}' },
    ]);
    expect(compose.services.traefik.networks.ci_hub_edge).toEqual({ ipv4_address: '${HUB_EDGE_TRAEFIK_IP:-10.128.0.2}' });
    expect(compose.services.cloudflared.networks).toEqual({ ci_hub_edge: { ipv4_address: '${HUB_EDGE_CLOUDFLARED_IP:-10.128.0.3}' } });
    expect(compose.services['hub-tailscale'].networks.ci_hub_edge).toEqual({ ipv4_address: '${HUB_EDGE_TAILSCALE_IP:-10.128.0.4}' });
  });

  it('keeps the Hub network as the gateway for Traefik and the sidecar, not the edge that sorts first', () => {
    // Otherwise their connections to the host leave from 10.128.0.0/29, which fleet ufw rules
    // (172.16.0.0/12 from Docker bridges) drop: a port-expose app's upstream hangs to a 504.
    expect(compose.services.traefik.networks.ci_hub_network).toEqual({ gw_priority: 1 });
    expect(compose.services['hub-tailscale'].networks.ci_hub_network).toEqual({ gw_priority: 1 });
  });

  it('keeps the Hub network as the gateway for the Hub itself, not ci-hub_internal that sorts first', () => {
    // 0.2.77 moved the Hub's default route to ci-hub_internal, a bridge numbered when it was
    // created. Where a VPN or an accepted Tailscale route also claims that range, the Hub could
    // no longer reach the Portal while everything else on the computer could (#1763).
    expect(compose.services['ci-hub'].networks.ci_hub_network).toEqual({
      gw_priority: 1,
      aliases: ['ci-os-hub', 'host.docker.internal'],
    });
    expect(compose.services['ci-hub'].networks).toHaveProperty('ci_hub_internal');
  });

  it('routes every service on the Hub network through it, whatever network it also joins', () => {
    // A network added later that sorts before `ci-hub_network` takes the default route of every
    // service that joins both, unless the Hub network outranks it: the edge did that to Traefik and
    // the sidecar, and ci-hub_internal did it to the Hub.
    const onHubNetwork = Object.keys(compose.services).filter((service) =>
      joinedNetworks(compose.services[service].networks).some(({ key }) => key === 'ci_hub_network'),
    );
    expect(onHubNetwork).toEqual(expect.arrayContaining(['ci-hub', 'traefik', 'hub-tailscale']));
    for (const service of onHubNetwork) {
      expect(defaultRouteNetwork(compose, service), service).toBe('ci-hub_network');
    }
  });

  it('tells the Hub every edge address it needs', () => {
    const environment = compose.services['ci-hub'].environment;
    expect(environment.HUB_EDGE_TRAEFIK_IP).toBe('${HUB_EDGE_TRAEFIK_IP:-10.128.0.2}');
    expect(environment.HUB_EDGE_CLOUDFLARED_IP).toBe('${HUB_EDGE_CLOUDFLARED_IP:-10.128.0.3}');
    expect(environment.HUB_EDGE_TAILSCALE_IP).toBe('${HUB_EDGE_TAILSCALE_IP:-10.128.0.4}');
  });
});

describe('defaultRouteNetwork', () => {
  const compose = (networks: ServiceNetworks, declared: Record<string, ComposeNetwork>): Compose => ({
    services: { app: { networks } },
    networks: declared,
  });

  it('breaks a tie by network name, the way Docker does', () => {
    expect(defaultRouteNetwork(compose(['b_key', 'a_key'], { a_key: { name: 'zz' }, b_key: { name: 'aa' } }), 'app')).toBe('aa');
    expect(defaultRouteNetwork(compose({ one: null, two: null }, { one: null, two: null }), 'app')).toBe('one');
  });

  it('lets gw_priority outrank the name, and never picks an internal network', () => {
    const declared = { first: { name: 'a' }, second: { name: 'b' } };
    expect(defaultRouteNetwork(compose({ first: null, second: { gw_priority: 1 } }, declared), 'app')).toBe('b');
    const firstInternal = { ...declared, first: { name: 'a', internal: true } };
    expect(defaultRouteNetwork(compose({ first: { gw_priority: 1 }, second: null }, firstInternal), 'app')).toBe('b');
    expect(defaultRouteNetwork(compose(['first'], firstInternal), 'app')).toBeUndefined();
  });

  it('prefers a dual-stack network at equal priority', () => {
    expect(
      defaultRouteNetwork(compose({ first: null, second: null }, { first: { name: 'a' }, second: { name: 'b', enable_ipv6: true } }), 'app'),
    ).toBe('b');
  });
});
