import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { AppUrn } from '@ci-hub/common/types';
import type { LoggerService } from '@/core/logger/logger.service';
import type { MarketplaceService } from '../marketplace.service';

import { ImageSizeService, parseDockerImageRef } from '../image-size.service';

describe('parseDockerImageRef', () => {
  it('parses Docker Hub library images', () => {
    expect(parseDockerImageRef('redis')).toEqual({
      registry: 'registry.hub.docker.com',
      repository: 'library/redis',
      tag: 'latest',
    });
  });

  it('parses Docker Hub org/repo with tag', () => {
    expect(parseDockerImageRef('org/app:1.2.3')).toEqual({
      registry: 'registry.hub.docker.com',
      repository: 'org/app',
      tag: '1.2.3',
    });
  });

  it('parses GHCR references', () => {
    expect(parseDockerImageRef('ghcr.io/companionintelligence/ci-openclaw:2026.6.1')).toEqual({
      registry: 'ghcr.io',
      repository: 'companionintelligence/ci-openclaw',
      tag: '2026.6.1',
    });
  });

  it('parses registry hosts with ports without treating the port colon as a tag delimiter', () => {
    expect(parseDockerImageRef('my.registry:5000/ns/repo:tag')).toEqual({
      registry: 'my.registry:5000',
      repository: 'ns/repo',
      tag: 'tag',
    });
  });

  it('defaults to latest when a port-qualified registry has no explicit tag', () => {
    expect(parseDockerImageRef('my.registry:5000/ns/repo')).toEqual({
      registry: 'my.registry:5000',
      repository: 'ns/repo',
      tag: 'latest',
    });
  });

  it('parses digest references for manifest lookup', () => {
    expect(parseDockerImageRef('ghcr.io/org/app@sha256:deadbeef')).toEqual({
      registry: 'ghcr.io',
      repository: 'org/app',
      tag: 'sha256:deadbeef',
    });
  });

  it('drops the tag from a tag-and-digest reference so the repository path stays valid', () => {
    expect(parseDockerImageRef('ghcr.io/companionintelligence/ci-openclaw:2026.10.2@sha256:e7d9de7f')).toEqual({
      registry: 'ghcr.io',
      repository: 'companionintelligence/ci-openclaw',
      tag: 'sha256:e7d9de7f',
    });
    expect(parseDockerImageRef('my.registry:5000/ns/repo:tag@sha256:abc')).toEqual({
      registry: 'my.registry:5000',
      repository: 'ns/repo',
      tag: 'sha256:abc',
    });
  });

  it('parses localhost registry references', () => {
    expect(parseDockerImageRef('localhost:5000/myimage:v1')).toEqual({
      registry: 'localhost:5000',
      repository: 'myimage',
      tag: 'v1',
    });
  });

  it('treats every Docker Hub host spelling as Docker Hub', () => {
    for (const host of ['docker.io', 'index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com']) {
      expect(parseDockerImageRef(`${host}/corentinth/it-tools:latest@sha256:8b81`)).toEqual({
        registry: 'registry.hub.docker.com',
        repository: 'corentinth/it-tools',
        tag: 'sha256:8b81',
      });
    }
  });

  it('adds library/ to a one-segment name on an explicit Docker Hub host', () => {
    expect(parseDockerImageRef('docker.io/nginx')).toEqual({
      registry: 'registry.hub.docker.com',
      repository: 'library/nginx',
      tag: 'latest',
    });
    expect(parseDockerImageRef('index.docker.io/redis:7.4')).toEqual({
      registry: 'registry.hub.docker.com',
      repository: 'library/redis',
      tag: '7.4',
    });
  });
});

const DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
const DOCKER_LIST = 'application/vnd.docker.distribution.manifest.list.v2+json';
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';

/** A manifest as a registry stores it: the media type it was pushed with, and its body. */
type StoredManifest = { mediaType: string; body: unknown };

/**
 * Answers like the real registries: a token for anyone, a manifest only when the
 * Accept header names the type it was pushed as (ghcr.io 404s otherwise), and the
 * Docker website, not a registry, at https://docker.io.
 */
function fakeRegistries(manifests: Record<string, StoredManifest>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://auth.docker.io/token') || url.startsWith('https://ghcr.io/token')) {
      return Response.json({ token: 'anonymous-pull' });
    }
    if (url.startsWith('https://docker.io/')) {
      return new Response('<!DOCTYPE html><html><body>Docker Hub</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    const stored = manifests[url];
    const accept = new Headers(init?.headers).get('accept') ?? '';
    const accepted = accept.split(',').map((type) => type.trim());
    if (!stored || !accepted.includes(stored.mediaType)) {
      return Response.json({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, { status: 404 });
    }
    return Response.json(stored.body, { headers: { 'content-type': stored.mediaType } });
  });
}

function sizeServiceFor(image: string) {
  const marketplace = mock<MarketplaceService>();
  marketplace.getDockerComposeJson.mockResolvedValue({ content: { schemaVersion: 2, services: [{ name: 'main', image }] } } as never);
  return new ImageSizeService(mock<LoggerService>(), marketplace);
}

const singleManifest = (mediaType: string, layerSizes: number[]): StoredManifest => ({
  mediaType,
  body: { schemaVersion: 2, mediaType, config: { size: 1_000 }, layers: layerSizes.map((size) => ({ size })) },
});

describe('ImageSizeService.getAppImageSize', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sizes a Docker Hub image written as docker.io/<org>/<repo>', async () => {
    const hub = 'https://registry-1.docker.io/v2/corentinth/it-tools/manifests';
    vi.stubGlobal(
      'fetch',
      fakeRegistries({
        [`${hub}/sha256:8b81`]: {
          mediaType: DOCKER_LIST,
          body: { schemaVersion: 2, mediaType: DOCKER_LIST, manifests: [{ digest: 'sha256:amd', platform: { architecture: 'amd64', os: 'linux' } }] },
        },
        [`${hub}/sha256:amd`]: singleManifest(DOCKER_MANIFEST, [20_000_000, 9_000_000]),
      }),
    );

    const size = await sizeServiceFor('docker.io/corentinth/it-tools:latest@sha256:8b81').getAppImageSize('it-tools:ci-marketplace' as AppUrn);

    expect(size).toEqual({ totalBytes: 29_001_000, formatted: '28 MB' });
  });

  it('sizes an official Docker Hub image written as docker.io/<name>', async () => {
    vi.stubGlobal(
      'fetch',
      fakeRegistries({ 'https://registry-1.docker.io/v2/library/redis/manifests/7.4': singleManifest(DOCKER_MANIFEST, [40_000_000]) }),
    );

    const size = await sizeServiceFor('docker.io/redis:7.4').getAppImageSize('redis-app:ci-marketplace' as AppUrn);

    expect(size.totalBytes).toBe(40_001_000);
  });

  it('sizes a ghcr.io image published as an OCI index, down to its per-platform manifest', async () => {
    const ghcr = 'https://ghcr.io/v2/gchq/cyberchef/manifests';
    vi.stubGlobal(
      'fetch',
      fakeRegistries({
        [`${ghcr}/sha256:f04a`]: {
          mediaType: OCI_INDEX,
          body: {
            schemaVersion: 2,
            mediaType: OCI_INDEX,
            manifests: [
              { digest: 'sha256:amd', platform: { architecture: 'amd64', os: 'linux' } },
              { digest: 'sha256:arm', platform: { architecture: 'arm64', os: 'linux' } },
            ],
          },
        },
        [`${ghcr}/sha256:amd`]: singleManifest(OCI_MANIFEST, [30_000_000]),
        [`${ghcr}/sha256:arm`]: singleManifest(OCI_MANIFEST, [31_000_000]),
      }),
    );

    const size = await sizeServiceFor('ghcr.io/gchq/cyberchef:latest@sha256:f04a').getAppImageSize('cyberchef:ci-marketplace' as AppUrn);

    expect(size.totalBytes).toBe(31_001_000);
  });
});
