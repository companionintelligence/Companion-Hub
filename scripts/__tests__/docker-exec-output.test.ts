import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dockerCpArchive } from './docker-cp-archive';

const spawnSync = vi.fn();
vi.mock('node:child_process', () => ({ spawnSync: (...args: unknown[]) => spawnSync(...args) }));

const { containerReader, describeDockerEndpoint, readContainerOutput } = await import('../lib/docker-exec-output');

const dockerCalls = (): string[][] => spawnSync.mock.calls.map(([, args]) => args as string[]);
/** The folder the copy route used, read back from the detached `sh -c` that started the command. */
const copyDir = (): string => dockerCalls().find((args) => args[1] === '-d' && args[3] === 'sh')?.[7] ?? '';

/**
 * A Docker engine reached the way the desktop app reaches the one it runs in WSL2: `docker exec`
 * exits 0 and prints nothing whatever the command did. Detached execs start, and `docker cp` works.
 * `copies` is what each successive `docker cp` finds in the folder; the last one repeats.
 */
function engineThatLosesExecOutput(...copies: Record<string, string>[]) {
  let copy = 0;
  spawnSync.mockImplementation((_command: string, args: string[]) => {
    if (args[0] === 'cp') {
      const files = copies[Math.min(copy, copies.length - 1)] ?? {};
      copy += 1;
      return { status: 0, stdout: dockerCpArchive(String(args[1]).split('/').pop() ?? '', files), stderr: Buffer.alloc(0) };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
}

beforeEach(() => {
  spawnSync.mockReset();
});

describe('readContainerOutput', () => {
  it('returns what docker exec printed, and copies nothing when it printed', () => {
    spawnSync.mockReturnValue({ status: 0, stdout: 't\n', stderr: '' });

    expect(readContainerOutput('ci-hub-db', ['psql', '-At', '-c', 'SELECT true'])).toEqual({ status: 0, stdout: 't', stderr: '' });
    expect(dockerCalls()).toEqual([['exec', 'ci-hub-db', 'psql', '-At', '-c', 'SELECT true']]);
  });

  it('runs the command again detached and copies its output out when docker exec exits 0 with nothing', () => {
    engineThatLosesExecOutput({ out: '[{"id":1}]\n', err: '', status: '0\n' });

    expect(readContainerOutput('ci-hub-db', ['psql', '-At', '-c', 'SELECT 1'])).toEqual({ status: 0, stdout: '[{"id":1}]', stderr: '' });

    const dir = copyDir();
    expect(dir).toMatch(/^\/tmp\/cihub-exec-[0-9a-f]{16}$/);
    expect(dockerCalls().slice(1)).toEqual([
      ['exec', '-d', 'ci-hub-db', 'sh', '-c', expect.stringContaining('"$@" >"$d/out" 2>"$d/err"'), 'sh', dir, 'psql', '-At', '-c', 'SELECT 1'],
      ['cp', `ci-hub-db:${dir}`, '-'],
      ['exec', '-d', 'ci-hub-db', 'rm', '-rf', dir],
    ]);
  });

  it('waits for the exit status, which the command writes last, before taking its output', () => {
    // The first copy catches the command half way: no status yet, and only part of its output.
    engineThatLosesExecOutput({ out: '[{"id":1},' }, { out: '[{"id":1},{"id":2}]\n', err: '', status: '0\n' });

    expect(readContainerOutput('ci-hub-db', ['psql', '-At', '-c', 'SELECT 1']).stdout).toBe('[{"id":1},{"id":2}]');
    expect(dockerCalls().filter((args) => args[0] === 'cp')).toHaveLength(2);
  });

  it("returns the command's own exit status and error text from the copied files", () => {
    engineThatLosesExecOutput({ out: '', err: 'ERROR:  relation "api_key" does not exist\n', status: '1\n' });

    expect(readContainerOutput('ci-hub-db', ['psql', '-At', '-c', 'SELECT * FROM api_key'])).toEqual({
      status: 1,
      stdout: '',
      stderr: 'ERROR:  relation "api_key" does not exist',
    });
  });

  it('marks the result lost when no exit status comes back in time, and still removes the folder', () => {
    engineThatLosesExecOutput({});

    const result = readContainerOutput('ci-hub-db', ['psql', '-At', '-c', 'SELECT 1'], { timeoutMs: 1 });

    expect(result).toEqual({ status: null, stdout: '', stderr: '', lost: true });
    expect(dockerCalls().at(-1)).toEqual(['exec', '-d', 'ci-hub-db', 'rm', '-rf', copyDir()]);
  });

  it('gives each docker cp only the time left before the deadline, so a slow engine cannot double the wait', () => {
    engineThatLosesExecOutput({});
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 12_000;
      return now;
    });
    try {
      readContainerOutput('ci-hub-db', ['psql', '-At', '-c', 'SELECT 1'], { timeoutMs: 30_000 });
    } finally {
      clock.mockRestore();
    }

    const copyTimeouts = (spawnSync.mock.calls as unknown[][])
      .filter(([, args]) => (args as string[])[0] === 'cp')
      .map(([, , options]) => (options as { timeout: number }).timeout);
    expect(copyTimeouts.length).toBeGreaterThan(0);
    for (const timeout of copyTimeouts) expect(timeout).toBeLessThanOrEqual(18_000);
  });

  it('returns what docker said when the detached command could not start, without waiting for it', () => {
    spawnSync.mockImplementation((_command: string, args: string[]) =>
      args[1] === '-d'
        ? { status: 1, stdout: '', stderr: 'Error response from daemon: container ci-hub-db is not running\n' }
        : { status: 0, stdout: '', stderr: '' },
    );

    expect(readContainerOutput('ci-hub-db', ['psql', '-At', '-c', 'SELECT 1'])).toEqual({
      status: 1,
      stdout: '',
      stderr: 'Error response from daemon: container ci-hub-db is not running',
    });
    expect(dockerCalls().some((args) => args[0] === 'cp')).toBe(false);
  });
});

/**
 * The copy route hands the command to `sh -c` inside the container as positional arguments. Run here
 * by a real shell, the script the reader sends must pass each argument through whole (a key name with a
 * space, SQL with quotes) without expanding any of it, and must write the exit status only after the
 * output is complete.
 */
const sh = ['/bin/sh', '/usr/bin/sh'].find((candidate) => existsSync(candidate));
describe.skipIf(!sh)('the copy-route script, run by a real shell', () => {
  it('passes every argument through unchanged, and writes the exit status after the output', async () => {
    const { spawnSync: runForReal } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    engineThatLosesExecOutput({});
    readContainerOutput('ci-hub-db', ['true'], { timeoutMs: 1 });
    const script = String(dockerCalls().find((args) => args[1] === '-d' && args[3] === 'sh')?.[5]);

    const root = mkdtempSync(join(tmpdir(), 'cihub-copy-route-'));
    try {
      const dir = join(root, 'cihub-exec-test');
      const args = ['a b', "it's", '"quoted"', '$(touch pwned)', '`touch pwned`', '; touch pwned', '$HOME', '*'];
      const command = ['sh', '-c', 'printf "%s|" "$@"; echo oops >&2; exit 3', 'sh', ...args];
      const started = runForReal(sh as string, ['-c', script, 'sh', dir, ...command], { cwd: root, encoding: 'utf-8' });

      expect(started.status).toBe(0);
      expect(readFileSync(join(dir, 'out'), 'utf-8')).toBe(`${args.join('|')}|`);
      expect(readFileSync(join(dir, 'err'), 'utf-8')).toBe('oops\n');
      expect(readFileSync(join(dir, 'status'), 'utf-8')).toBe('3\n');
      expect(existsSync(join(dir, 'status.tmp'))).toBe(false);
      expect(existsSync(join(root, 'pwned'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('containerReader', () => {
  it('sends every later command straight to the copy route once output went missing', () => {
    engineThatLosesExecOutput({ out: '7\n', err: '', status: '0\n' });
    const read = containerReader('ci-hub-db');
    read(['psql', '-At', '-c', 'SELECT true']);
    spawnSync.mockClear();

    expect(read(['psql', '-At', '-c', 'INSERT INTO api_key DEFAULT VALUES RETURNING id'], { repeatable: false }).stdout).toBe('7');
    // One run of the INSERT, detached: a plain exec first would have inserted the row and lost its
    // id, and running it again to read the id would insert a second row.
    expect(dockerCalls().filter((args) => args.includes('INSERT INTO api_key DEFAULT VALUES RETURNING id'))).toHaveLength(1);
    expect(dockerCalls()[0]?.slice(0, 2)).toEqual(['exec', '-d']);
  });

  // Killing the docker CLI does not stop psql in the container, so a timed-out INSERT can still commit.
  it('marks a command lost when docker exec times out, instead of reporting that it failed', () => {
    spawnSync.mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    });

    const result = containerReader('ci-hub-db')(['psql', '-At', '-c', 'INSERT INTO api_key DEFAULT VALUES RETURNING id'], { repeatable: false });

    expect(result).toMatchObject({ status: null, lost: true });
    expect(dockerCalls()).toHaveLength(1);
  });

  it('does not run a command twice to read its output when it must run only once', () => {
    engineThatLosesExecOutput({ out: '7\n', err: '', status: '0\n' });

    const result = containerReader('ci-hub-db')(['psql', '-At', '-c', 'INSERT INTO api_key DEFAULT VALUES RETURNING id'], { repeatable: false });

    expect(result).toEqual({ status: 0, stdout: '', stderr: '', lost: true });
    expect(dockerCalls()).toHaveLength(1);
  });
});

describe('describeDockerEndpoint', () => {
  const ENV_KEYS = ['DOCKER_HOST', 'DOCKER_CONTEXT'] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('names the context and the address it points at', () => {
    process.env.DOCKER_CONTEXT = 'wsl-engine';
    spawnSync.mockReturnValue({ status: 0, stdout: 'tcp://127.0.0.1:2375\n', stderr: '' });

    expect(describeDockerEndpoint()).toBe('Docker context wsl-engine (tcp://127.0.0.1:2375)');
    expect(dockerCalls()).toEqual([['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', 'wsl-engine']]);
  });

  it('names DOCKER_HOST when it is set, since the docker CLI then ignores the context', () => {
    process.env.DOCKER_HOST = 'tcp://127.0.0.1:2375';
    process.env.DOCKER_CONTEXT = 'desktop-linux';

    expect(describeDockerEndpoint()).toBe('DOCKER_HOST=tcp://127.0.0.1:2375');
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
