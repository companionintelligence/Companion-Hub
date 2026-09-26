import { describe, expect, it } from 'vitest';
import { resolveSupervisionTarget, SUPERVISION_CONTAINER_CANDIDATES } from '../supervision/supervision-target.resolver';
import type { SupervisionContainerState } from '../supervision/supervision.types';

function container(overrides: Partial<SupervisionContainerState> & { name: string }): SupervisionContainerState {
  return {
    id: `id-${overrides.name}`,
    image: 'example/image:latest',
    state: 'running',
    status: 'running',
    running: true,
    restartCount: 0,
    restartPolicy: 'unless-stopped',
    exitCode: null,
    oomKilled: false,
    startedAt: null,
    finishedAt: null,
    healthStatus: null,
    ports: [],
    labels: {},
    inHubComposeProject: false,
    ...overrides,
  };
}

describe('resolveSupervisionTarget', () => {
  it('never classifies another machine as a local container, even when the name matches', () => {
    // `preferredVllmUrl` legitimately points across a tailnet. Without this gate the Hub would
    // report on a local `ci-hub-vllm` left over from an experiment because a Mac elsewhere is down.
    const target = resolveSupervisionTarget({
      backend: 'vllm',
      baseUrl: 'http://beta-max.tailnet.ts.net:8000',
      containers: [container({ name: 'ci-hub-vllm', ports: [{ hostPort: 8000, containerPort: 8000 }] })],
      reachable: true,
    });

    expect(target.kind).toBe('remote');
    expect(target.ref).toBe('beta-max.tailnet.ts.net:8000');
  });

  it('matches a container only when its published port is the one the health check probes', () => {
    const target = resolveSupervisionTarget({
      backend: 'ollama',
      baseUrl: 'http://host.docker.internal:11434',
      containers: [container({ name: 'ci-hub-ollama', ports: [{ hostPort: 11434, containerPort: 11434 }] })],
      reachable: true,
    });

    expect(target).toMatchObject({ kind: 'container', ref: 'ci-hub-ollama' });
  });

  it('downgrades a name match with the wrong port to host-process, never to container', () => {
    const target = resolveSupervisionTarget({
      backend: 'ollama',
      baseUrl: 'http://host.docker.internal:11434',
      containers: [container({ name: 'ci-hub-ollama', ports: [{ hostPort: 8113, containerPort: 11434 }] })],
      reachable: true,
    });

    expect(target.kind).toBe('host-process');
    expect(target.reason).toContain('does not publish port 11434');
  });

  it('matches the container port when the URL addresses the container by name on a Docker network', () => {
    const target = resolveSupervisionTarget({
      backend: 'vllm',
      baseUrl: 'http://ci-hub-vllm:8000',
      containers: [container({ name: 'ci-hub-vllm', ports: [{ hostPort: null, containerPort: 8000 }] })],
      reachable: true,
    });

    expect(target).toMatchObject({ kind: 'container', ref: 'ci-hub-vllm' });
  });

  it('calls oMLX a host process, because it has no Docker path', () => {
    expect(SUPERVISION_CONTAINER_CANDIDATES.omlx).toEqual([]);

    const target = resolveSupervisionTarget({
      backend: 'omlx',
      baseUrl: 'http://host.docker.internal:8000',
      containers: [],
      reachable: true,
    });
    expect(target.kind).toBe('host-process');
    expect(target.reason).toContain('no Docker deployment path');
  });

  it('calls a reachable loopback engine with no container a host process', () => {
    const target = resolveSupervisionTarget({
      backend: 'ollama',
      baseUrl: 'http://localhost:11434',
      containers: [],
      reachable: true,
    });

    expect(target.kind).toBe('host-process');
    expect(target.reason).toContain('cannot see its restarts');
  });

  it('calls an unreachable loopback engine with no container absent', () => {
    const target = resolveSupervisionTarget({
      backend: 'ollama',
      baseUrl: 'http://localhost:11434',
      containers: [],
      reachable: false,
    });

    expect(target).toMatchObject({ kind: 'absent', ref: null });
  });

  it('treats a Docker bridge literal as local', () => {
    const target = resolveSupervisionTarget({
      backend: 'ollama',
      baseUrl: 'http://172.17.0.1:11434',
      containers: [container({ name: 'ci-hub-ollama', ports: [{ hostPort: 11434, containerPort: 11434 }] })],
      reachable: true,
    });

    expect(target).toMatchObject({ kind: 'container', ref: 'ci-hub-ollama' });
  });

  it('degrades to absent rather than throwing on a base URL that is not a URL', () => {
    const target = resolveSupervisionTarget({ backend: 'ollama', baseUrl: '', containers: [], reachable: false });
    expect(target.kind).toBe('absent');
  });

  it('always explains itself, including for a container it will still never act on', () => {
    const target = resolveSupervisionTarget({
      backend: 'ollama',
      baseUrl: 'http://localhost:11434',
      containers: [container({ name: 'ci-hub-ollama', ports: [{ hostPort: 11434, containerPort: 11434 }] })],
      reachable: true,
    });

    expect(target.kind).toBe('container');
    expect(target.reason).toContain('never starts, stops or restarts it');
  });
});
