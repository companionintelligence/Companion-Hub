import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => childProcess);

const { appendToRollingBuffer, isHostPortBindConflict, runDockerComposeUpOnce } = await import('../compose-up');

/**
 * A stand-in for the `docker` child process, so the streaming behaviour can be driven step by step.
 * `emitStdout`/`emitStderr` push a chunk the way a real pipe would; `close` ends the run. Nothing
 * here runs Docker — the subject is how the CLI relays the child's output, not what Docker prints.
 */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = vi.fn();
  return {
    child,
    emitStdout: (text: string) => child.stdout.emit('data', Buffer.from(text)),
    emitStderr: (text: string) => child.stderr.emit('data', Buffer.from(text)),
    close: (code: number) => child.emit('close', code),
    fail: () => child.emit('error', new Error('spawn failed')),
  };
}

describe('compose-up helpers', () => {
  it('detects docker port bind conflicts in rolling buffer output', () => {
    const output = 'Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:80';
    expect(isHostPortBindConflict(output)).toBe(true);
  });

  it('keeps only the trailing portion of compose output', () => {
    const buffer = appendToRollingBuffer('abc', 'def');
    expect(buffer).toBe('abcdef');
    const large = 'x'.repeat(9000);
    const trimmed = appendToRollingBuffer(large, 'tail');
    expect(trimmed.length).toBeLessThanOrEqual(8192 + 4);
    expect(trimmed.endsWith('tail')).toBe(true);
  });
});

describe('runDockerComposeUpOnce', () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    childProcess.spawn.mockReset();
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const written = (spy: ReturnType<typeof vi.spyOn>) => (spy.mock.calls as unknown[][]).map((call) => String(call[0])).join('');

  /**
   * The regression this file exists for. A detached `up` used to be spawned with no `stdio`, which
   * Node defaults to 'pipe', so nothing reached the terminal until the build finished — and detached
   * is what every appliance install runs. Asserting mid-run rather than after resolution is the
   * point: a version that buffered everything and flushed at the end would still pass an
   * end-of-run assertion while showing the user nothing for minutes.
   */
  it('echoes child output as it arrives, before the run finishes', async () => {
    const { child, emitStdout, emitStderr, close } = fakeChild();
    childProcess.spawn.mockReturnValue(child);

    const pending = runDockerComposeUpOnce(['compose', 'up', '-d'], { envOverrides: {} });
    emitStdout('pulling ci-hub...\n');
    emitStderr(' => resolving image\n');

    expect(written(stdoutWrite)).toContain('pulling ci-hub...');
    expect(written(stderrWrite)).toContain('=> resolving image');

    close(0);
    await pending;
  });

  it('pipes stdout and stderr rather than inheriting them, and inherits stdin', async () => {
    const { child, close } = fakeChild();
    childProcess.spawn.mockReturnValue(child);

    const pending = runDockerComposeUpOnce(['compose', 'up'], { envOverrides: {} });
    close(0);
    await pending;

    // 'pipe' on stdout/stderr is what makes the echo above possible; 'inherit' on stdin is what
    // lets Ctrl+C and any docker prompt still reach the child.
    expect(childProcess.spawn).toHaveBeenCalledWith('docker', ['compose', 'up'], expect.objectContaining({ stdio: ['inherit', 'pipe', 'pipe'] }));
  });

  it('returns the captured output so the caller can match retry heuristics against it', async () => {
    const { child, emitStderr, close } = fakeChild();
    childProcess.spawn.mockReturnValue(child);

    const pending = runDockerComposeUpOnce(['compose', 'up', '-d'], { envOverrides: {} });
    emitStderr('Error response from daemon: ports are not available\n');
    close(1);
    const result = await pending;

    expect(result.status).toBe(1);
    // cli-lifecycle concatenates stdout and stderr before testing it, and the port self-heal and
    // apk-mirror retry both depend on the text surviving the stream relay.
    expect(isHostPortBindConflict(`${result.stdout}\n${result.stderr}`)).toBe(true);
  });

  it('keeps only the tail of a very long run, bounded by the rolling buffer', async () => {
    const { child, emitStdout, close } = fakeChild();
    childProcess.spawn.mockReturnValue(child);

    const pending = runDockerComposeUpOnce(['compose', 'up', '-d'], { envOverrides: {} });
    emitStdout('n'.repeat(20000));
    emitStdout('\nports are not available\n');
    close(1);
    const result = await pending;

    expect(result.stdout.length).toBeLessThanOrEqual(8192);
    // The failure reason is at the end of a compose run, which is the half the buffer keeps.
    expect(isHostPortBindConflict(result.stdout)).toBe(true);
  });

  it('passes env overrides and cwd through to the child', async () => {
    const { child, close } = fakeChild();
    childProcess.spawn.mockReturnValue(child);

    const pending = runDockerComposeUpOnce(['compose', 'up'], { envOverrides: { DOCKER_BUILD_NETWORK: 'host' }, cwd: '/data' });
    close(0);
    await pending;

    const options = childProcess.spawn.mock.calls[0]?.[2] as { env: Record<string, string>; cwd?: string };
    expect(options.env.DOCKER_BUILD_NETWORK).toBe('host');
    expect(options.cwd).toBe('/data');
  });

  it('resolves with a failure status when the child cannot be spawned', async () => {
    const { child, fail } = fakeChild();
    childProcess.spawn.mockReturnValue(child);

    const pending = runDockerComposeUpOnce(['compose', 'up'], { envOverrides: {} });
    fail();
    const result = await pending;

    // Resolving rather than rejecting is deliberate: the caller drives a retry loop off `status`.
    expect(result.status).toBe(1);
  });

  it('forwards an interrupt to the child and detaches its listeners afterwards', async () => {
    const { child, close } = fakeChild();
    childProcess.spawn.mockReturnValue(child);
    const before = process.listenerCount('SIGINT');

    const pending = runDockerComposeUpOnce(['compose', 'up'], { envOverrides: {} });
    // Node hands the signal name to process signal listeners, so the fake emit must too — without
    // the second argument the handler would receive undefined and forward that to child.kill().
    process.emit('SIGINT', 'SIGINT');
    expect(child.kill).toHaveBeenCalledWith('SIGINT');

    close(0);
    await pending;

    // A leak here would accumulate one handler per attempt across the retry loop, and eventually
    // trip Node's MaxListenersExceededWarning on a stack that retries three times.
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
