import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendHealthStatus, InferenceBackendType } from '@ci-hub/common/types';
import { INFERENCE_BACKEND_TYPES } from '@ci-hub/common/types';
import { INFERENCE_SUPERVISION_DISABLED_ENV_VAR } from '@/common/helpers/inference-supervision';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { DockerReadFacade, SupervisionContainerInspection } from '@/modules/docker/docker-read.facade';
import type { HostTelemetryService } from '@/modules/system/host-telemetry.service';
import type { InferenceBackendRegistry } from '../backends/backend-registry';
import { BackendObserverService } from '../supervision/backend-observer.service';

const HEALTHY: BackendHealthStatus = { running: true, healthy: true, modelsLoaded: ['qwen36-27b'] };
const DEAD: BackendHealthStatus = { running: false, healthy: false, modelsLoaded: [], error: 'connect ECONNREFUSED' };

function containerFixture(overrides: Partial<SupervisionContainerInspection> & { name: string }): SupervisionContainerInspection {
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
    inHubComposeProject: true,
    ...overrides,
  };
}

interface Harness {
  service: BackendObserverService;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  telemetry: { recordEvent: ReturnType<typeof vi.fn> };
  dockerRead: {
    inspectSupervisionCandidates: ReturnType<typeof vi.fn>;
    tailContainerLogs: ReturnType<typeof vi.fn>;
    countContainerZombieProcesses: ReturnType<typeof vi.fn>;
  };
  healthChecks: Map<InferenceBackendType, ReturnType<typeof vi.fn>>;
}

function harness(
  options: {
    mode?: 'off' | 'observe';
    containers?: SupervisionContainerInspection[];
    baseUrls?: Partial<Record<InferenceBackendType, string>>;
    health?: Partial<Record<InferenceBackendType, BackendHealthStatus>>;
    logTail?: string;
    zombies?: number | null;
  } = {},
): Harness {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const telemetry = { recordEvent: vi.fn().mockResolvedValue(undefined) };
  const dockerRead = {
    inspectSupervisionCandidates: vi.fn().mockResolvedValue(options.containers ?? []),
    tailContainerLogs: vi.fn().mockResolvedValue(options.logTail ?? ''),
    countContainerZombieProcesses: vi.fn().mockResolvedValue(options.zombies ?? null),
  };
  const healthChecks = new Map<InferenceBackendType, ReturnType<typeof vi.fn>>();
  const backends = {
    get(type: InferenceBackendType) {
      let healthCheck = healthChecks.get(type);
      if (!healthCheck) {
        healthCheck = vi.fn().mockResolvedValue(options.health?.[type] ?? DEAD);
        healthChecks.set(type, healthCheck);
      }
      return {
        type,
        getBaseUrl: () => options.baseUrls?.[type] ?? `http://localhost:1000${INFERENCE_BACKEND_TYPES.indexOf(type)}`,
        healthCheck,
      };
    },
  };
  const configuration = {
    getInferenceSupervisionMode: () => options.mode ?? 'off',
    getInferenceSupervisionPollSeconds: () => 30,
  };

  const service = new BackendObserverService(
    logger as unknown as LoggerService,
    configuration as unknown as ConfigurationService,
    backends as unknown as InferenceBackendRegistry,
    dockerRead as unknown as DockerReadFacade,
    telemetry as unknown as HostTelemetryService,
  );

  return { service, logger, telemetry, dockerRead, healthChecks };
}

describe('BackendObserverService — cost on a Hub that never opted in', () => {
  beforeEach(() => {
    delete process.env[INFERENCE_SUPERVISION_DISABLED_ENV_VAR];
    vi.useRealTimers();
  });

  it('arms no timer and issues no probe at boot when the mode is off', () => {
    // The whole default-off argument in one assertion. A peerless single-node Hub must pay nothing:
    // no Docker call, no health check, no timer to fire later.
    vi.useFakeTimers();
    const { service, dockerRead, healthChecks } = harness({ mode: 'off' });

    service.onModuleInit();

    expect(vi.getTimerCount()).toBe(0);
    expect(dockerRead.inspectSupervisionCandidates).not.toHaveBeenCalled();
    expect([...healthChecks.values()].some((check) => check.mock.calls.length > 0)).toBe(false);

    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('arms a timer only once the operator opts in', () => {
    vi.useFakeTimers();
    const { service } = harness({ mode: 'observe' });

    service.onModuleInit();
    expect(vi.getTimerCount()).toBe(1);

    service.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('lets the environment kill switch win over the persisted opt-in', () => {
    vi.useFakeTimers();
    process.env[INFERENCE_SUPERVISION_DISABLED_ENV_VAR] = 'true';
    const { service } = harness({ mode: 'observe' });

    service.onModuleInit();

    expect(vi.getTimerCount()).toBe(0);
    expect(service.getReport()).toMatchObject({ mode: 'off', disabledBy: 'env' });
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('never throws out of onModuleInit, however broken the configuration is', () => {
    const { service, logger } = harness({ mode: 'observe' });
    // A configuration service that throws is an appliance-level failure mode: taking boot down to
    // report on inference health would be a worse outage than anything this service can detect.
    Reflect.set(service, 'configuration', {
      getInferenceSupervisionMode: () => {
        throw new Error('settings.json is unreadable');
      },
      getInferenceSupervisionPollSeconds: () => {
        throw new Error('settings.json is unreadable');
      },
    });

    expect(() => service.onModuleInit()).not.toThrow();
    expect(logger.error).not.toHaveBeenCalled();
    expect(service.getReport().mode).toBe('off');
  });

  it('serves a report with no observations behind it while off', () => {
    const { service } = harness({ mode: 'off' });
    const report = service.getReport();

    expect(report.observeOnly).toBe(true);
    expect(report.lastSweepAt).toBeNull();
    expect(report.backends).toHaveLength(INFERENCE_BACKEND_TYPES.length);
    expect(report.backends.every((entry) => entry.health === 'unknown')).toBe(true);
    expect(report.restartLoops).toEqual([]);
  });
});

describe('BackendObserverService — the external crash-loop alarm', () => {
  beforeEach(() => {
    delete process.env[INFERENCE_SUPERVISION_DISABLED_ENV_VAR];
  });

  it('sweeps the whole ci-hub compose project, not just the inference backends', async () => {
    const { service, dockerRead } = harness({ mode: 'observe' });

    await service.sweepOnce();

    expect(dockerRead.inspectSupervisionCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        composeProject: 'ci-hub',
        containerNames: expect.arrayContaining(['ci-hub-ollama', 'ci-hub-vllm', 'ci-hub-lemonade']),
      }),
    );
  });

  it('honours CI_HUB_COMPOSE_PROJECT_NAME, so the sweep does not silently match nothing', async () => {
    // The rest of the repo reads this override (docker.service.ts:452, :1375,
    // system-update.service.ts:166). Hard-coding 'ci-hub' here would make the label filter match
    // ZERO containers on a Hub that sets it — and a filter that matches nothing looks exactly like
    // a healthy stack, so the alarm's headline capability would vanish with no error.
    const previous = process.env.CI_HUB_COMPOSE_PROJECT_NAME;
    process.env.CI_HUB_COMPOSE_PROJECT_NAME = 'ci-hub-staging';
    try {
      const { service, dockerRead } = harness({ mode: 'observe' });

      await service.sweepOnce();

      expect(dockerRead.inspectSupervisionCandidates).toHaveBeenCalledWith(expect.objectContaining({ composeProject: 'ci-hub-staging' }));
    } finally {
      if (previous === undefined) delete process.env.CI_HUB_COMPOSE_PROJECT_NAME;
      else process.env.CI_HUB_COMPOSE_PROJECT_NAME = previous;
    }
  });

  it('tells someone about a Hub stack service dockerd is looping', async () => {
    // The real incident's silhouette: `hub-tailscale` at RestartCount=11463, respawning every ~60 s
    // through an entire measurement window, with nobody aware. It is not an inference backend, so
    // an inference-only scope structurally cannot see it.
    const { service, telemetry, logger } = harness({
      mode: 'observe',
      containers: [containerFixture({ name: 'hub-tailscale', image: 'tailscale/tailscale:stable', restartCount: 11463, state: 'restarting' })],
    });

    await service.sweepOnce();

    expect(telemetry.recordEvent).toHaveBeenCalledWith(
      'error',
      'inference-observer',
      expect.stringContaining('hub-tailscale'),
      expect.objectContaining({ restartCount: 11463, kind: 'absolute' }),
    );
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('11463'));
    expect(service.getReport().restartLoops[0]).toMatchObject({ containerName: 'hub-tailscale', kind: 'absolute' });
  });

  it('still logs the alarm when the telemetry provider is absent', async () => {
    // HostTelemetryService is injected `@Optional()` across a forwardRef chain. A missing provider
    // must not swallow the one thing this layer exists for.
    const { service, logger } = harness({
      mode: 'observe',
      containers: [containerFixture({ name: 'hub-tailscale', restartCount: 900 })],
    });
    Reflect.set(service, 'telemetry', undefined);

    await service.sweepOnce();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('hub-tailscale'));
  });

  it('says nothing about a quiet compose project', async () => {
    const { service, telemetry } = harness({
      mode: 'observe',
      containers: [containerFixture({ name: 'ci-hub-db', restartCount: 1 }), containerFixture({ name: 'traefik', restartCount: 0 })],
    });

    await service.sweepOnce();

    expect(telemetry.recordEvent).not.toHaveBeenCalled();
    expect(service.getReport().restartLoops).toEqual([]);
  });

  it('degrades to an empty sweep when Docker is unavailable', async () => {
    const { service, logger } = harness({ mode: 'observe' });
    Reflect.get(service, 'dockerRead');
    const dockerRead = Reflect.get(service, 'dockerRead') as { inspectSupervisionCandidates: ReturnType<typeof vi.fn> };
    dockerRead.inspectSupervisionCandidates.mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock'));

    await expect(service.sweepOnce()).resolves.toBeUndefined();
    expect(service.getReport().dockerError).toContain('docker.sock');
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('BackendObserverService — per-backend observation', () => {
  it('classifies the four engines and explains every one it cannot supervise', async () => {
    const { service } = harness({
      mode: 'observe',
      baseUrls: {
        ollama: 'http://localhost:11434',
        vllm: 'http://beta-max.tailnet.ts.net:8000',
        lemonade: 'http://ci-hub-lemonade:13305',
        omlx: 'http://host.docker.internal:8000',
      },
      health: { ollama: HEALTHY, omlx: HEALTHY },
      containers: [containerFixture({ name: 'ci-hub-lemonade', ports: [{ hostPort: null, containerPort: 13305 }] })],
    });

    await service.sweepOnce();
    const byBackend = new Map(service.getReport().backends.map((entry) => [entry.backend, entry]));

    expect(byBackend.get('ollama')?.target.kind).toBe('host-process');
    expect(byBackend.get('vllm')?.target.kind).toBe('remote');
    expect(byBackend.get('lemonade')?.target.kind).toBe('container');
    expect(byBackend.get('omlx')?.target.kind).toBe('host-process');

    for (const entry of byBackend.values()) {
      expect(entry.target.reason.length).toBeGreaterThan(0);
    }
  });

  it('records health and the run of consecutive unhealthy observations', async () => {
    const { service } = harness({ mode: 'observe', health: { ollama: HEALTHY } });

    await service.sweepOnce();
    await service.sweepOnce();

    const report = service.getReport();
    const ollama = report.backends.find((entry) => entry.backend === 'ollama');
    const vllm = report.backends.find((entry) => entry.backend === 'vllm');
    expect(ollama).toMatchObject({ health: 'healthy', consecutiveUnhealthy: 0 });
    expect(vllm).toMatchObject({ health: 'unreachable', consecutiveUnhealthy: 2 });
    expect(report.lastSweepAt).not.toBeNull();
  });

  it('spends no evidence-gathering calls on a healthy backend', async () => {
    const { service, dockerRead } = harness({
      mode: 'observe',
      baseUrls: { lemonade: 'http://ci-hub-lemonade:13305' },
      health: Object.fromEntries(INFERENCE_BACKEND_TYPES.map((type) => [type, HEALTHY])) as Record<InferenceBackendType, BackendHealthStatus>,
      containers: [containerFixture({ name: 'ci-hub-lemonade', ports: [{ hostPort: null, containerPort: 13305 }], restartCount: 0 })],
    });

    await service.sweepOnce();

    expect(dockerRead.tailContainerLogs).not.toHaveBeenCalled();
    expect(dockerRead.countContainerZombieProcesses).not.toHaveBeenCalled();
  });
});

describe('BackendObserverService — the no-restart guarantee', () => {
  const supervisionDir = path.join(__dirname, '..', 'supervision');

  it('has no reference to any container-mutating call anywhere in the layer', async () => {
    // `fs` is mocked module-wide by src/tests/vite.setup.ts (memfs), so reading the real sources
    // has to go through importActual.
    const { readdirSync, readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    // A structural assertion, not a behavioural one, because the property being protected is the
    // absence of a code path. The Hub restarting an inference backend is a defect regardless of how
    // carefully it is written: the ~97,000-restart incident is what an automatic restarter looks
    // like when its budget can reset itself, and on the fleet the Lucebox container is owned by the
    // desktop app, which starts again anything the Hub stops.
    const forbidden = [
      'DockerService',
      'restartContainer',
      'ensureContainerRunning',
      'composeUpService',
      'docker start',
      'docker stop',
      'docker restart',
      '--restart=no',
      'setContainerRestartPolicy',
    ];

    const offenders: string[] = [];
    for (const file of readdirSync(supervisionDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(path.join(supervisionDir, file), 'utf8');
      // Strip block and line comments: the files explain at length why they do not restart
      // anything, and those sentences must not trip the check.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const needle of forbidden) {
        if (code.includes(needle)) offenders.push(`${file}: ${needle}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('exposes no method that could act on a backend', () => {
    const { service } = harness({ mode: 'observe' });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service));

    expect(methods.filter((name) => /restart|stop|start|kill|remove|recreate/i.test(name))).toEqual([]);
  });

  it('stops only its own timer on shutdown', async () => {
    // `onModuleDestroy` must never stop an engine: an inference engine's lifetime is not the Hub's,
    // and evicting a multi-gigabyte model from VRAM on every Hub upgrade would cost 60-120 s of
    // cold reload and cut off every other client on the box.
    vi.useFakeTimers();
    const { service, dockerRead } = harness({ mode: 'observe' });

    service.onModuleInit();
    service.onModuleDestroy();

    expect(vi.getTimerCount()).toBe(0);
    expect(dockerRead.inspectSupervisionCandidates).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
