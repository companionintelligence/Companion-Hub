import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { fillHubContainerName } from '../traefik-hub-address';

// The shared test setup mocks `fs`; these tests are ABOUT the real file on disk.
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

const REPO_ROOT = path.join(__dirname, '../../../../../..');
const asset = readFileSync(path.join(REPO_ROOT, 'packages/backend/assets/traefik/dynamic/dynamic.yml'), 'utf-8');

type DynamicConfig = {
  http: {
    middlewares: Record<string, { forwardAuth?: { address: string } }>;
    services: Record<string, { loadBalancer: { servers: { url: string }[] } }>;
  };
};

const hubAddresses = (content: string) => {
  const { http } = parse(content) as DynamicConfig;
  return {
    forwardAuth: http.middlewares['ci-hub']?.forwardAuth?.address,
    startingPage: http.services['ci-hub-app-starting']?.loadBalancer.servers.map((server) => server.url),
  };
};

describe('fillHubContainerName', () => {
  it('leaves the shipped file exactly as it is on the default container name', () => {
    // The desktop app rewrites the file, and has Traefik recreated, whenever it differs from the asset.
    expect(fillHubContainerName(asset, 'ci-hub')).toBe(asset);
  });

  it('points every tagged address at a legacy container, and changes nothing else', () => {
    const filled = fillHubContainerName(asset, 'ci-os-hub');

    expect(hubAddresses(filled)).toEqual({
      forwardAuth: 'http://ci-os-hub:5002/api/auth/traefik',
      startingPage: ['http://ci-os-hub:5002'],
    });
    const assetLines = asset.split('\n');
    const changed = filled.split('\n').filter((line, i) => line !== assetLines[i]);
    expect(changed).toEqual([
      '        address: "http://ci-os-hub:5002/api/auth/traefik" # hub container',
      '          - url: "http://ci-os-hub:5002" # hub container',
    ]);
  });

  it('keeps the default rather than write a name that is not a container name', () => {
    expect(fillHubContainerName(asset, 'ci-hub" # broken')).toBe(asset);
    expect(fillHubContainerName(asset, '')).toBe(asset);
  });

  it('ships the default name and a tag on every line that dials the Hub', () => {
    expect(hubAddresses(asset)).toEqual({
      forwardAuth: 'http://ci-hub:5002/api/auth/traefik',
      startingPage: ['http://ci-hub:5002'],
    });
    // An address added without the tag would stay on `ci-hub` on a legacy install.
    for (const line of asset.split('\n').filter((l) => l.includes('://ci-hub:'))) {
      expect(line).toMatch(/# hub container$/);
    }
  });
});
