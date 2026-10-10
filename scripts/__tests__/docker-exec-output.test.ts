import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.fn();
vi.mock('node:child_process', () => ({ spawnSync: (...args: unknown[]) => spawnSync(...args) }));

const { containerReader, describeDockerEndpoint, readContainerOutput } = await import('../lib/docker-exec-output');

/** A tar archive shaped like the one `docker cp <container>:<dir> -` streams: the folder, then its files. */
function tarOf(dir: string, files: Record<string, string>): Buffer {
  const header = (name: string, size: number, type: string) => {
    const block = Buffer.alloc(512);
    block.write(name, 0, 'utf-8');
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    block.write(type, 156, 'ascii');
    block.write('ustar\0', 257, 'ascii');
    return block;
  };
  const blocks = [header(`${dir}/`, 0, '5')];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, 'utf-8');
    blocks.push(header(`${dir}/${name}`, body.length, '0'), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

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
      return { status: 0, stdout: tarOf(String(args[1]).split('/').pop() ?? '', files), stderr: Buffer.alloc(0) };
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
