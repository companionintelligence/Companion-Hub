import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `cihub up` on an appliance (no checkout) — the order of the init scripts before compose runs.
 *
 * Every collaborator is mocked; the subject is which scripts `startApplianceHub` runs and in what
 * order. Compose is never invoked. The one assertion that matters: init-traefik runs, rooted at the
 * data dir, before anything that could hand compose a `state/traefik/…` file bind mount to resolve.
 */
const calls = vi.hoisted(() => ({ scripts: [] as string[], runs: [] as string[][], compose: [] as string[][], bestEffort: [] as string[][] }));
const ctxState = vi.hoisted(() => ({ envFile: '/data/companion-hub/.env.dev', image: undefined as string | undefined }));

vi.mock('../compose-up.js', () => ({
  isHostPortBindConflict: () => false,
  runDockerComposeUpOnce: vi.fn(async (args: string[]) => {
    calls.compose.push(args);
    return { status: 0, stdout: '', stderr: '' };
  }),
}));
vi.mock('../heal-hub-ports.js', () => ({
  healHubPortBindConflict: () => null,
  healHubPortsBeforeStartup: () => ({ assignments: {}, info: [] }),
}));
vi.mock('../init-docker-config.js', () => ({ initDockerConfig: vi.fn() }));
vi.mock('../init-gpu-runtime.js', () => ({ initGpuRuntime: vi.fn() }));
vi.mock('../init-host-probe.js', () => ({ initHostProbe: vi.fn() }));
vi.mock('../init-hub-data-dirs.js', () => ({ initHubDataDirs: vi.fn() }));
vi.mock('../init-traefik.js', () => ({ initTraefik: vi.fn() }));
vi.mock('../sync-postgres-password.js', () => ({ syncPostgresPasswordFromEnv: vi.fn() }));
vi.mock('../sync-rabbitmq-password.js', () => ({ syncRabbitmqPasswordFromEnv: vi.fn() }));
vi.mock('../lib/cli-repo-context.js', () => ({ isApplianceMode: () => true, requireRepoRoot: vi.fn() }));
vi.mock('../lib/cli-ui.js', () => ({ printMessageBox: vi.fn(), colorize: (s: string) => s, dim: (s: string) => s }));
vi.mock('../lib/cli-proc.js', () => ({
  ensureLocalDevPortsAvailable: vi.fn(),
  run: vi.fn((cmd: string, args: string[]) => {
    calls.runs.push([cmd, ...args]);
  }),
  runBestEffort: vi.fn((cmd: string, args: string[]) => {
    calls.bestEffort.push([cmd, ...args]);
    return true;
  }),
  runScript: vi.fn(async (label: string, fn: () => unknown) => {
    calls.scripts.push(label);
    return await fn();
  }),
}));
vi.mock('../lib/hub-context.js', () => ({
  buildComposeBaseArgs: (envFile: string, files: string[]) => ['compose', '--env-file', envFile, ...files.flatMap((f) => ['-f', f])],
  ensureApplianceInstall: vi.fn(async () => {}),
  envOverridesForContext: () => ({
    ENV_FILE: ctxState.envFile,
    ROOT_FOLDER_HOST: '/data/companion-hub',
    ...(ctxState.image ? { CI_HUB_IMAGE: ctxState.image } : {}),
  }),
  resolveHubContext: () => ({
    env: 'prod',
    appliance: true,
    envFile: ctxState.envFile,
    composeFiles: ['/data/companion-hub/docker-compose.prod.yml'],
    cwd: '/data/companion-hub',
    dataDir: '/data/companion-hub',
  }),
}));

const { startHub } = await import('../lib/cli-lifecycle');
const { initTraefik } = await import('../init-traefik.js');
const { runScript } = await import('../lib/cli-proc.js');

describe('cihub up on an appliance', () => {
  beforeEach(() => {
    calls.scripts.length = 0;
    calls.runs.length = 0;
    calls.compose.length = 0;
    calls.bestEffort.length = 0;
    ctxState.image = undefined;
    vi.mocked(initTraefik).mockClear();
    vi.mocked(runScript).mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it('runs init-traefik, rooted at the data dir, before compose is asked to mount anything', async () => {
    await startHub('detached', 'prod');

    expect(calls.scripts).toEqual([
      'scripts/init-hub-data-dirs.ts',
      'scripts/init-traefik.ts',
      'scripts/init-gpu-runtime.ts',
      'scripts/init-host-probe.ts',
      'scripts/sync-postgres-password.ts',
      'scripts/sync-rabbitmq-password.ts',
    ]);
    expect(initTraefik).toHaveBeenCalledTimes(1);

    // The env handed to init-traefik names the data dir as ROOT_FOLDER_HOST and runs it there —
    // that is what makes the files land under `<dataDir>/state/traefik`, where compose mounts from.
    const traefikCall = vi.mocked(runScript).mock.calls.find(([label]) => label === 'scripts/init-traefik.ts');
    expect(traefikCall?.[2]).toMatchObject({ ENV_FILE: ctxState.envFile, ROOT_FOLDER_HOST: '/data/companion-hub' });
    expect(traefikCall?.[3]).toBe('/data/companion-hub');

    // …and it happened before the first docker invocation of any kind.
    const firstDocker = calls.runs.findIndex(([cmd]) => cmd === 'docker');
    expect(firstDocker).toBeGreaterThanOrEqual(0);
    expect(calls.compose.length).toBe(1);
  });

  it('pulls a floating Hub image before compose, so `pull_policy: if_not_present` cannot keep a stale :latest', async () => {
    // A freshly reinstalled node ran a release image seven days old on 2026-09-18: the seeded
    // compose only pulls when the tag is absent locally, and it was not.
    ctxState.image = 'ghcr.io/companionintelligence/ci-hub:latest';
    await startHub('detached', 'prod');
    expect(calls.bestEffort).toEqual([
      ['docker', 'compose', '--env-file', ctxState.envFile, '-f', '/data/companion-hub/docker-compose.prod.yml', 'pull', 'ci-hub'],
    ]);
    // …and before compose up, which is the point.
    expect(calls.compose.length).toBe(1);
  });

  it('does not pull a digest-pinned image: a digest cannot move', async () => {
    ctxState.image = 'ghcr.io/companionintelligence/ci-hub@sha256:90f8eda420682b7c2879d50de1b8f589c963deb6b116f1d3536564f8b7bf8166';
    await startHub('detached', 'prod');
    expect(calls.bestEffort).toEqual([]);
  });
});
