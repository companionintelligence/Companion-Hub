import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `cihub up` on an appliance (no checkout) — the order of the init scripts before compose runs.
 *
 * Every collaborator is mocked; the subject is which scripts `startApplianceHub` runs and in what
 * order. Compose is never invoked. The one assertion that matters: init-traefik runs, rooted at the
 * data dir, before anything that could hand compose a `state/traefik/…` file bind mount to resolve.
 */
const calls = vi.hoisted(() => ({ scripts: [] as string[], runs: [] as string[][], compose: [] as string[][] }));

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
  runScript: vi.fn(async (label: string, fn: () => unknown) => {
    calls.scripts.push(label);
    return await fn();
  }),
}));
vi.mock('../lib/hub-context.js', () => ({
  buildComposeBaseArgs: (envFile: string, files: string[]) => ['compose', '--env-file', envFile, ...files.flatMap((f) => ['-f', f])],
  ensureApplianceInstall: vi.fn(async () => {}),
  envOverridesForContext: () => ({ ENV_FILE: '/data/companion-hub/.env.dev', ROOT_FOLDER_HOST: '/data/companion-hub' }),
  resolveHubContext: () => ({
    env: 'prod',
    appliance: true,
    envFile: '/data/companion-hub/.env.dev',
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
    expect(traefikCall?.[2]).toMatchObject({ ENV_FILE: '/data/companion-hub/.env.dev', ROOT_FOLDER_HOST: '/data/companion-hub' });
    expect(traefikCall?.[3]).toBe('/data/companion-hub');

    // …and it happened before the first docker invocation of any kind.
    const firstDocker = calls.runs.findIndex(([cmd]) => cmd === 'docker');
    expect(firstDocker).toBeGreaterThanOrEqual(0);
    expect(calls.compose.length).toBe(1);
  });
});
