import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `cihub up` in a checkout: which stacks are held to the Docker versions docker-compose.prod.yml
 * needs (Compose 2.33, Engine 28, for `gw_priority`).
 *
 * Every collaborator is mocked, and the first set-up script stops the run, so nothing past the
 * check executes. The check itself is covered in docker-versions.test.ts.
 */
vi.mock('../compose-up.js', () => ({ isHostPortBindConflict: () => false, runDockerComposeUpOnce: vi.fn() }));
vi.mock('../heal-hub-ports.js', () => ({ healHubPortBindConflict: () => null, healHubPortsBeforeStartup: () => ({ assignments: {}, info: [] }) }));
vi.mock('../init-docker-config.js', () => ({ initDockerConfig: vi.fn() }));
vi.mock('../init-gpu-runtime.js', () => ({ initGpuRuntime: vi.fn() }));
vi.mock('../init-host-probe.js', () => ({ initHostProbe: vi.fn() }));
vi.mock('../init-hub-data-dirs.js', () => ({ initHubDataDirs: vi.fn() }));
vi.mock('../init-traefik.js', () => ({ initTraefik: vi.fn() }));
vi.mock('../sync-postgres-password.js', () => ({ syncPostgresPasswordFromEnv: vi.fn() }));
vi.mock('../sync-rabbitmq-password.js', () => ({ syncRabbitmqPasswordFromEnv: vi.fn() }));
vi.mock('../lib/cli-repo-context.js', () => ({ isApplianceMode: () => false, requireRepoRoot: vi.fn() }));
vi.mock('../lib/docker-versions.js', () => ({ requireDockerForHubStack: vi.fn() }));
vi.mock('../lib/cli-ui.js', () => ({ printMessageBox: vi.fn(), colorize: (s: string) => s, dim: (s: string) => s }));
vi.mock('../lib/cli-proc.js', () => ({
  ensureLocalDevPortsAvailable: vi.fn(),
  run: vi.fn(),
  runBestEffort: vi.fn(() => true),
  runScript: vi.fn(async () => {
    throw new Error('first set-up script');
  }),
}));
vi.mock('../lib/hub-context.js', () => ({
  buildComposeBaseArgs: vi.fn(() => []),
  ensureApplianceInstall: vi.fn(),
  envOverridesForContext: vi.fn(() => ({})),
  resolveHubContext: vi.fn(),
}));

const { startHub } = await import('../lib/cli-lifecycle');
const { runScript } = await import('../lib/cli-proc.js');
const { requireDockerForHubStack } = await import('../lib/docker-versions.js');

describe('cihub up in a checkout', () => {
  afterEach(() => vi.clearAllMocks());

  it.each(['dev', 'staging', 'prod'] as const)('checks the Docker versions before a %s stack is set up', async (env) => {
    await expect(startHub('detached', env)).rejects.toThrow('first set-up script');

    expect(requireDockerForHubStack).toHaveBeenCalledTimes(1);
    const [checkedAt = Number.POSITIVE_INFINITY] = vi.mocked(requireDockerForHubStack).mock.invocationCallOrder;
    const [firstScriptAt = 0] = vi.mocked(runScript).mock.invocationCallOrder;
    expect(checkedAt).toBeLessThan(firstScriptAt);
  });

  it('does not hold source dev to them: it starts only Postgres and RabbitMQ, from docker-compose.local.yml', async () => {
    await expect(startHub('local-dev', 'local')).rejects.toThrow('first set-up script');

    expect(requireDockerForHubStack).not.toHaveBeenCalled();
  });
});
