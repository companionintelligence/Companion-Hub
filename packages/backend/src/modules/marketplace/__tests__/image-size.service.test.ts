import { describe, expect, it } from 'vitest';

import { parseDockerImageRef } from '../image-size.service';

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
});
