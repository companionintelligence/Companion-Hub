import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { fillEdgeHopAddresses, resolveEdgeHopAddress, resolveEdgeHops } from '../edge-hops';

// The shared test setup mocks `fs`; the contract tests below are ABOUT the real files on disk.
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

const REPO_ROOT = path.join(__dirname, '../../../../../..');
const TRAEFIK_ASSET = path.join(REPO_ROOT, 'packages/backend/assets/traefik/traefik.yml');
const COMPOSE_COPIES = ['docker-compose.prod.yml', 'packages/desktop/src-tauri/resources/docker-compose.prod.yml'];

type TraefikStatic = { entryPoints: Record<string, { forwardedHeaders?: { trustedIPs?: unknown[] } }> };

function trustedIps(content: string): Record<string, unknown[] | undefined> {
  const config = parse(content) as TraefikStatic;
  return Object.fromEntries(Object.entries(config.entryPoints).map(([name, entry]) => [name, entry.forwardedHeaders?.trustedIPs]));
}

describe('resolveEdgeHops', () => {
  it('uses the compose defaults when unset or blank', () => {
    expect(resolveEdgeHops({})).toEqual([
      { name: 'cloudflared', address: '10.128.0.3' },
      { name: 'hub-tailscale', address: '10.128.0.4' },
    ]);
    expect(resolveEdgeHops({ HUB_EDGE_CLOUDFLARED_IP: ' ', HUB_EDGE_TAILSCALE_IP: '' })).toEqual(resolveEdgeHops({}));
  });

  it('honours operator IPv4 addresses', () => {
    expect(resolveEdgeHops({ HUB_EDGE_CLOUDFLARED_IP: '10.200.0.3', HUB_EDGE_TAILSCALE_IP: '10.200.0.4' })).toEqual([
      { name: 'cloudflared', address: '10.200.0.3' },
      { name: 'hub-tailscale', address: '10.200.0.4' },
    ]);
  });

  it('refuses anything that is not exactly an IPv4 address rather than writing it into a trusted list', () => {
    for (const bad of ['10.128.0.0/29', '0.0.0.0/0', '10.128.0.3; insecure: true', 'cloudflared', '10.128.0.300', 'fd00::3']) {
      expect(resolveEdgeHopAddress(bad, '10.128.0.3')).toBe('10.128.0.3');
    }
  });
});

describe('fillEdgeHopAddresses', () => {
  const asset = readFileSync(TRAEFIK_ASSET, 'utf8');

  it('leaves the shipped asset untouched on the defaults, so a verbatim seed is already right', () => {
    expect(fillEdgeHopAddresses(asset, resolveEdgeHops({}))).toBe(asset);
  });

  it('rewrites every tagged entry on both entry points for an override, and nothing else', () => {
    const filled = fillEdgeHopAddresses(asset, resolveEdgeHops({ HUB_EDGE_CLOUDFLARED_IP: '10.200.0.4', HUB_EDGE_TAILSCALE_IP: '10.200.0.3' }));

    // Swapped on purpose: a sequential find-and-replace of the old values would collapse them.
    expect(trustedIps(filled)).toEqual({ web: ['10.200.0.4/32', '10.200.0.3/32'], websecure: ['10.200.0.4/32', '10.200.0.3/32'] });
    expect(filled.split('\n').filter((line, index) => line !== asset.split('\n')[index])).toHaveLength(4);
  });
});

describe('the shipped edge trust (contract)', () => {
  it('traefik.yml trusts exactly the two edge hops on both entry points, never a subnet or placeholder', () => {
    const asset = readFileSync(TRAEFIK_ASSET, 'utf8');

    expect(asset).not.toMatch(/\{\{EDGE/);
    // Traefik's static config must parse as a list of addresses as seeded, before the Hub runs.
    expect(trustedIps(asset)).toEqual({ web: ['10.128.0.3/32', '10.128.0.4/32'], websecure: ['10.128.0.3/32', '10.128.0.4/32'] });
  });

  it.each(COMPOSE_COPIES)('%s pins cloudflared and the sidecar to the addresses traefik.yml trusts', (relativePath) => {
    const compose = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
    const defaults = resolveEdgeHops({});

    for (const [variable, hop] of [
      ['HUB_EDGE_CLOUDFLARED_IP', defaults[0]],
      ['HUB_EDGE_TAILSCALE_IP', defaults[1]],
    ] as const) {
      // The container's own address and the value handed to the Hub share one variable and default.
      const uses = [...compose.matchAll(new RegExp(`\\$\\{${variable}:-([^}]+)\\}`, 'g'))].map((match) => match[1]);
      expect(uses.length, `${variable} in ${relativePath}`).toBeGreaterThanOrEqual(2);
      expect(new Set(uses)).toEqual(new Set([hop?.address]));
    }
  });
});
