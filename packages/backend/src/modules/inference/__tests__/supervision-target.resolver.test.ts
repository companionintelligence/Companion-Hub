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
      backend: 'lucebox',
      baseUrl: 'http://host.docker.internal:8000',
      containers: [container({ name: 'ci-hub-inference-lucebox', ports: [{ hostPort: 8000, containerPort: 8080 }] })],
      reachable: true,
    });

    expect(target).toMatchObject({ kind: 'container', ref: 'ci-hub-inference-lucebox' });
  });

  it('downgrades a name match with the wrong port to host-process, never to container', () => {
    // The desktop publishes Lucebox on a DYNAMIC host port (`available_host_port(LUCEBOX_PORT)`),
    // so the container named `ci-hub-inference-lucebox` routinely has nothing to do with whatever
    // answers SPECULATIVE_INFERENCE_URL. Reporting on a stranger is the failure to avoid.
    const target = resolveSupervisionTarget({
      backend: 'lucebox',
      baseUrl: 'http://host.docker.internal:8000',
      containers: [container({ name: 'ci-hub-inference-lucebox', ports: [{ hostPort: 8113, containerPort: 8080 }] })],
      reachable: true,
    });

    expect(target.kind).toBe('host-process');
    expect(target.reason).toContain('does not publish port 8000');
  });

  it('breaks the two-name Lucebox tie on the port, not on list order', () => {
    const target = resolveSupervisionTarget({
      backend: 'lucebox',
      baseUrl: 'http://host.docker.internal:8000',
      containers: [
        container({ name: 'ci-hub-lucebox', ports: [{ hostPort: 9999, containerPort: 8080 }] }),
        container({ name: 'ci-hub-inference-lucebox', ports: [{ hostPort: 8000, containerPort: 8080 }] }),
      ],
      reachable: true,
    });

    expect(target.ref).toBe('ci-hub-inference-lucebox');
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

  it('calls mtplx and dspark host processes, because neither has any Docker path at all', () => {
    // Both `getDockerImage()` and `getComposeConfig()` throw unconditionally in those backends.
    // They run as launchd LaunchAgents, which is already a correct supervisor for them.
    expect(SUPERVISION_CONTAINER_CANDIDATES.mtplx).toEqual([]);
    expect(SUPERVISION_CONTAINER_CANDIDATES.dspark).toEqual([]);

    for (const backend of ['mtplx', 'dspark'] as const) {
      const target = resolveSupervisionTarget({
        backend,
        baseUrl: 'http://host.docker.internal:8080',
        containers: [],
        reachable: true,
      });
      expect(target.kind).toBe('host-process');
      expect(target.reason).toContain('no Docker deployment path');
    }
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
