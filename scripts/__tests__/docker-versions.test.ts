import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Docker version check `cihub up` runs before it starts a stack from docker-compose.prod.yml,
 * whose `gw_priority` needs Compose 2.33 (an older one refuses the file) and Engine 28 (an older
 * one ignores the setting). No real `docker` runs: the one test of the reader replaces `spawnSync`.
 */
const spawned = vi.hoisted(() => ({
  calls: [] as { args: string[]; env: NodeJS.ProcessEnv | undefined }[],
  replies: {} as Record<string, { status: number | null; stdout: string }>,
}));
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn((_cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    spawned.calls.push({ args, env: options.env });
    return { status: 1, stdout: '', stderr: '', ...spawned.replies[args.join(' ')] };
  }),
}));
const boxes = vi.hoisted(() => [] as { title: string; lines: string[]; tone: string }[]);
vi.mock('../lib/cli-ui.js', () => ({
  colorize: (text: string) => text,
  printMessageBox: (title: string, lines: string[], tone: string) => boxes.push({ title, lines, tone }),
}));

const { compareDockerVersions, dockerComposeTooOldLines, dockerEngineTooOldLines, parseDockerVersion, readDockerVersions, requireDockerForHubStack } =
  await import('../lib/docker-versions');

// The desktop app's messages for the same Docker, word for word (hub_manager/docker_versions.rs).
const COMPOSE_2_32_REFUSED = [
  'Companion Hub needs Docker Compose 2.33 or newer.',
  'This computer has Compose 2.32.4.',
  'Update Docker, then start the Hub again.',
];
const ENGINE_27_WARNING = [
  'Docker Engine 27.5.1 ignores the network priority the Hub relies on, so the Hub, Traefik, and the Tailscale helper may use the wrong network for internet and host traffic.',
  'Update Docker Engine to 28 or newer.',
];

describe('parseDockerVersion', () => {
  it.each([
    ['2.40.3-desktop.1', [2, 40, 3]],
    ['v2.33.0', [2, 33, 0]],
    ['5.1.4', [5, 1, 4]],
    ['28.5.1', [28, 5, 1]],
    ['29.6.0\n', [29, 6, 0]],
    ['2.32.4', [2, 32, 4]],
    ['27.5.1', [27, 5, 1]],
    ['28.2.2-0ubuntu1~24.04.1', [28, 2, 2]],
    ['20.10.24+dfsg1', [20, 10, 24]],
    ['Docker Compose version v2.24.6-desktop.1', [2, 24, 6]],
    ['28.0', [28, 0, 0]],
  ])('reads %j as %j', (raw, expected) => {
    expect(parseDockerVersion(raw)).toEqual(expected);
  });

  it.each(['', 'dev', '29', 'unknown', '99999999999999999999.1.0', null, undefined])('reads nothing from %j', (raw) => {
    expect(parseDockerVersion(raw)).toBeNull();
  });
});

describe('compareDockerVersions', () => {
  it('orders by number, not by text', () => {
    expect(compareDockerVersions([2, 40, 3], [2, 33, 0])).toBeGreaterThan(0);
    expect(compareDockerVersions([2, 9, 0], [2, 33, 0])).toBeLessThan(0);
    expect(compareDockerVersions([5, 1, 4], [2, 33, 0])).toBeGreaterThan(0);
    expect(compareDockerVersions([27, 5, 1], [28, 0, 0])).toBeLessThan(0);
    expect(compareDockerVersions([2, 33, 0], [2, 33, 0])).toBe(0);
  });
});

describe('dockerComposeTooOldLines', () => {
  it('refuses a Compose older than 2.33, whatever the engine, and names it', () => {
    for (const engine of ['29.6.0', '27.5.1', null]) {
      expect(dockerComposeTooOldLines({ compose: '2.32.4', engine })).toEqual(COMPOSE_2_32_REFUSED);
    }
    expect(dockerComposeTooOldLines({ compose: 'v2.32.4', engine: null })).toEqual(COMPOSE_2_32_REFUSED);
    expect(COMPOSE_2_32_REFUSED.join(' ')).toBe(
      'Companion Hub needs Docker Compose 2.33 or newer. This computer has Compose 2.32.4. Update Docker, then start the Hub again.',
    );
  });

  it.each(['2.33.0', '2.40.3-desktop.1', '5.1.4', 'dev', null])('lets Compose %j through', (compose) => {
    expect(dockerComposeTooOldLines({ compose, engine: '27.5.1' })).toBeNull();
  });
});

describe('dockerEngineTooOldLines', () => {
  it('says what an engine older than 28 does to the routing', () => {
    expect(dockerEngineTooOldLines({ compose: '5.1.4', engine: '27.5.1' })).toEqual(ENGINE_27_WARNING);
    expect(ENGINE_27_WARNING.join(' ')).toBe(
      'Docker Engine 27.5.1 ignores the network priority the Hub relies on, so the Hub, Traefik, and the Tailscale helper may use the wrong network for internet and host traffic. Update Docker Engine to 28 or newer.',
    );
  });

  it.each(['28.0.0', '28.5.1', '29.6.0', 'dev', null])('says nothing about Engine %j', (engine) => {
    expect(dockerEngineTooOldLines({ compose: '5.1.4', engine })).toBeNull();
  });
});

describe('readDockerVersions', () => {
  beforeEach(() => {
    spawned.calls.length = 0;
    for (const key of Object.keys(spawned.replies)) delete spawned.replies[key];
  });

  it('asks the Docker the overrides point at, and keeps only what a successful call printed', () => {
    spawned.replies['compose version --short'] = { status: 0, stdout: '5.1.4\n' };
    spawned.replies['version --format {{.Server.Version}}'] = { status: 1, stdout: '' };

    expect(readDockerVersions({ DOCKER_HOST: 'unix:///pinned.sock' })).toEqual({ compose: '5.1.4', engine: null });
    expect(spawned.calls.map(({ args }) => args)).toEqual([
      ['compose', 'version', '--short'],
      ['version', '--format', '{{.Server.Version}}'],
    ]);
    expect(spawned.calls.every(({ env }) => env?.DOCKER_HOST === 'unix:///pinned.sock')).toBe(true);
  });
});

describe('requireDockerForHubStack', () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    boxes.length = 0;
    exit = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('process.exit');
    });
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['29.6.0', '27.5.1'])('stops when Compose is too old to read the stack file (Engine %s)', (engine) => {
    expect(() => requireDockerForHubStack({}, { compose: '2.32.4', engine })).toThrow('process.exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(boxes).toEqual([{ title: 'Docker update needed', lines: COMPOSE_2_32_REFUSED, tone: 'red' }]);
  });

  // Measured on Engine 27.5.1 (API 1.47) with Compose 5.1.4: `up` succeeds and the setting is
  // ignored, so every 0.2.77 Hub on Engine 27 runs. Refusing would stop it starting after an update.
  it('goes on when only the engine is too old, and says what is degraded', () => {
    requireDockerForHubStack({}, { compose: '5.1.4', engine: '27.5.1' });
    expect(exit).not.toHaveBeenCalled();
    expect(boxes).toEqual([{ title: 'Docker Engine update recommended', lines: ENGINE_27_WARNING, tone: 'yellow' }]);
    expect(log.mock.calls.flat()).toEqual(['→ Docker Compose 5.1.4, Docker Engine 27.5.1']);
  });

  it('goes on quietly when both are new enough', () => {
    requireDockerForHubStack({}, { compose: '5.1.4', engine: '29.6.0' });
    expect(exit).not.toHaveBeenCalled();
    expect(boxes).toEqual([]);
    expect(log.mock.calls.flat()).toEqual(['→ Docker Compose 5.1.4, Docker Engine 29.6.0']);
  });

  it('goes on, and says so, when a version cannot be read', () => {
    requireDockerForHubStack({}, { compose: '5.1.4', engine: null });
    expect(exit).not.toHaveBeenCalled();
    expect(boxes).toEqual([]);
    expect(log.mock.calls.flat()).toEqual([
      '→ Docker Compose 5.1.4, Docker Engine unknown',
      'Could not read the Docker Engine version; starting without checking it.',
    ]);
  });
});
