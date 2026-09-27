import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

// The shared test setup mocks `fs`; these assertions are ABOUT the real files on disk.
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

const REPO_ROOT = path.join(__dirname, '../../../..');
const COMPOSE_COPIES = ['docker-compose.prod.yml', 'packages/desktop/src-tauri/resources/docker-compose.prod.yml'];

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

  it('tells the Hub every edge address it needs', () => {
    const environment = compose.services['ci-hub'].environment;
    expect(environment.HUB_EDGE_TRAEFIK_IP).toBe('${HUB_EDGE_TRAEFIK_IP:-10.128.0.2}');
    expect(environment.HUB_EDGE_CLOUDFLARED_IP).toBe('${HUB_EDGE_CLOUDFLARED_IP:-10.128.0.3}');
    expect(environment.HUB_EDGE_TAILSCALE_IP).toBe('${HUB_EDGE_TAILSCALE_IP:-10.128.0.4}');
  });
});
