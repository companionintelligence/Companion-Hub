import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Docker version check `cihub up` runs before it starts a stack from docker-compose.prod.yml,
 * whose `gw_priority` needs Compose 2.33 and Engine 28. No real `docker` runs: the one test of the
 * reader replaces `spawnSync`.
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
const boxes = vi.hoisted(() => [] as { title: string; lines: string[] }[]);
vi.mock('../lib/cli-ui.js', () => ({
  colorize: (text: string) => text,
  printMessageBox: (title: string, lines: string[]) => boxes.push({ title, lines }),
}));

const { compareDockerVersions, dockerTooOldLines, parseDockerVersion, readDockerVersions, requireDockerForHubStack } = await import(
  '../lib/docker-versions'
);

// The desktop app's message for the same Docker, word for word (hub_manager/docker_versions.rs).
const TOO_OLD = [
  'Companion Hub needs Docker Compose 2.33 or newer and Docker Engine 28 or newer.',
  'This computer has Compose 2.32.4 and Engine 27.5.1.',
  'Update Docker, then start the Hub again.',
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

describe('dockerTooOldLines', () => {
  const foundLine = (compose: string | null, engine: string | null) => dockerTooOldLines({ compose, engine })?.[1];

  it('names both versions when either is too old', () => {
    expect(dockerTooOldLines({ compose: '2.32.4', engine: '27.5.1' })).toEqual(TOO_OLD);
    expect(TOO_OLD.join(' ')).toBe(
      'Companion Hub needs Docker Compose 2.33 or newer and Docker Engine 28 or newer. This computer has Compose 2.32.4 and Engine 27.5.1. Update Docker, then start the Hub again.',
    );
    // Compose alone: it refuses the file before the engine is ever asked.
    expect(foundLine('v2.32.4', '29.6.0')).toBe('This computer has Compose 2.32.4 and Engine 29.6.0.');
    // The engine alone: a new Compose cannot give it `gw_priority`.
    expect(foundLine('2.40.3-desktop.1', '27.5.1')).toBe('This computer has Compose 2.40.3-desktop.1 and Engine 27.5.1.');
  });

  it.each([
    ['2.33.0', '28.0.0'],
    ['2.40.3-desktop.1', '28.5.1'],
    ['5.1.4', '29.6.0'],
  ])('says nothing for Compose %s and Engine %s', (compose, engine) => {
    expect(dockerTooOldLines({ compose, engine })).toBeNull();
  });

  it('does not refuse on a version it could not read, and names only what it found', () => {
    expect(dockerTooOldLines({ compose: null, engine: null })).toBeNull();
    expect(dockerTooOldLines({ compose: 'dev', engine: '29.6.0' })).toBeNull();
    expect(dockerTooOldLines({ compose: '5.1.4', engine: null })).toBeNull();
    expect(foundLine(null, '27.5.1')).toBe('This computer has Engine 27.5.1.');
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

  it('stops with the message when Docker is too old', () => {
    expect(() => requireDockerForHubStack({}, { compose: '2.32.4', engine: '27.5.1' })).toThrow('process.exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(boxes).toEqual([{ title: 'Docker update needed', lines: TOO_OLD }]);
  });

  it('goes on when both are new enough', () => {
    requireDockerForHubStack({}, { compose: '5.1.4', engine: '29.6.0' });
    expect(exit).not.toHaveBeenCalled();
    expect(boxes).toEqual([]);
    expect(log.mock.calls.flat()).toEqual(['→ Docker Compose 5.1.4, Docker Engine 29.6.0']);
  });

  it('goes on, and says so, when a version cannot be read', () => {
    requireDockerForHubStack({}, { compose: '5.1.4', engine: null });
    expect(exit).not.toHaveBeenCalled();
    expect(log.mock.calls.flat()).toEqual([
      '→ Docker Compose 5.1.4, Docker Engine unknown',
      'Could not read the Docker Engine version; starting without checking it.',
    ]);
  });
});
