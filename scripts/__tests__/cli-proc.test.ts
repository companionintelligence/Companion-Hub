/**
 * `run()` / `runBestEffort()` — what the operator is told when the process never started.
 *
 * `cihub pool update` runs `docker pull` with the Hub data dir as cwd. On an appliance whose data
 * dir is missing, or mistyped via `CI_HUB_DATA_DIR`, that spawn fails — and both Node
 * (`spawnSync docker ENOENT`) and Bun (`ENOENT ... posix_spawn 'docker'`) phrase the failure as
 * a missing EXECUTABLE. The operator was told docker is not installed and went looking in the
 * wrong place (commit e6db313fc hit exactly this in the binary smoke test and fixed only the test).
 *
 * The spawns here are real, not mocked, because the claim under test is about the runtime: a
 * missing cwd surfaces as `result.error`, indistinguishable by `code`/`syscall`/`path` from a
 * missing binary. Nothing runs either way — `sh` is never reached, and the fake binary does not
 * exist — so the suite touches nothing outside its own temp directory.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { procListeningPids, run, runBestEffort } from '../lib/cli-proc';
import { stripAnsi } from '../lib/cli-ui';

/** Exists for the whole suite; the missing dir is a never-created child of it. */
let existingDir = '';
let missingDir = '';
const NO_SUCH_BINARY = 'cihub-test-no-such-binary-4f1c';

let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

const errorText = () => (errorSpy.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');

beforeAll(() => {
  existingDir = mkdtempSync(join(tmpdir(), 'cihub-proc-'));
  missingDir = join(existingDir, 'companion-hub-that-was-never-created');
});

afterAll(() => {
  if (existingDir) rmSync(existingDir, { recursive: true, force: true });
});

beforeEach(() => {
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('run', () => {
  it('names the missing working directory instead of blaming the executable', () => {
    expect(() => run('sh', ['-c', 'exit 0'], {}, missingDir)).toThrow('exit');
    expect(errorText()).toContain(`Failed to run sh: working directory does not exist: ${missingDir}`);
    // The runtime's own wording is what sent the operator after a docker install that was fine.
    expect(errorText()).not.toMatch(/posix_spawn|spawnSync sh ENOENT/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('still reports a genuinely missing binary as such when the directory is fine', () => {
    expect(() => run(NO_SUCH_BINARY, [], {}, existingDir)).toThrow('exit');
    expect(errorText()).toContain(`Failed to run ${NO_SUCH_BINARY}:`);
    expect(errorText()).not.toContain('working directory does not exist');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('runBestEffort', () => {
  it('says why nothing ran, and carries on', () => {
    // Before this, a spawn that never started streamed nothing: the `→ sh ...` echo, then silence.
    expect(runBestEffort('sh', ['-c', 'exit 0'], {}, missingDir)).toBe(false);
    expect(errorText()).toContain(`Failed to run sh: working directory does not exist: ${missingDir}`);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('reports a missing binary without claiming the directory is gone', () => {
    expect(runBestEffort(NO_SUCH_BINARY, [], {}, existingDir)).toBe(false);
    expect(errorText()).toContain(`Failed to run ${NO_SUCH_BINARY}:`);
    expect(errorText()).not.toContain('working directory does not exist');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

/** `/proc/net/tcp`: 0.0.0.0:5005 listening, a connection to it from local port 5005, and 127.0.0.1:5004 listening. */
const PROC_NET_TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 00000000:138D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41275 1 0000000000000000 100 0 0 10 0',
  '   1: 0100007F:138D 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 41276 1 0000000000000000 20 4 30 10 -1',
  '   2: 0100007F:138C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41277 1 0000000000000000 100 0 0 10 0',
].join('\n');

/** `/proc/net/tcp6`: [::]:5006 listening. */
const PROC_NET_TCP6 = [
  '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 00000000000000000000000000000000:138E 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52000 1 0000000000000000 100 0 0 10 0',
].join('\n');

/** BusyBox's `lsof` ignores its flags, lists every open file, and exits 0. */
const BUSYBOX_LSOF = '1\t/bin/busybox\t0\t/dev/null\n1\t/bin/busybox\t1\t/dev/null\n7\t/usr/local/bin/node\t0\t/dev/null\n';

/**
 * A fake `/proc`: the TCP tables, and for each PID the targets of its `fd/` links. `null` is a
 * process whose `fd/` cannot be listed: it exited, or belongs to another user.
 */
function fakeProc(processes: Record<string, string[] | null>): string {
  const root = mkdtempSync(join(tmpdir(), 'cihub-proc-root-'));
  mkdirSync(join(root, 'net'));
  writeFileSync(join(root, 'net', 'tcp'), PROC_NET_TCP);
  writeFileSync(join(root, 'net', 'tcp6'), PROC_NET_TCP6);
  // The kernel's own entries that are not processes.
  symlinkSync('202', join(root, 'self'));
  writeFileSync(join(root, 'uptime'), '1.00 2.00\n');
  for (const [pid, links] of Object.entries(processes)) {
    mkdirSync(join(root, pid));
    if (links === null) continue;
    mkdirSync(join(root, pid, 'fd'));
    for (const [fd, target] of links.entries()) symlinkSync(target, join(root, pid, 'fd', String(fd)));
  }
  return root;
}

describe('procListeningPids', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('finds the process holding the listening socket, not a client connected to the port', () => {
    root = fakeProc({
      101: ['/dev/null', 'pipe:[9001]', 'socket:[41276]'],
      202: ['/dev/null', 'anon_inode:[eventpoll]', 'socket:[41275]'],
      303: ['socket:[41277]'],
    });
    expect(procListeningPids(5005, root)).toEqual([202]);
    expect(procListeningPids(5004, root)).toEqual([303]);
  });

  it('finds a listener in the IPv6 table', () => {
    root = fakeProc({ 404: ['socket:[52000]'] });
    expect(procListeningPids(5006, root)).toEqual([404]);
  });

  it('finds every process sharing a listening socket', () => {
    root = fakeProc({ 202: ['socket:[41275]'], 203: ['/dev/null', 'socket:[41275]'] });
    expect(procListeningPids(5005, root)).toEqual([202, 203]);
  });

  it('finds nothing on a port no socket listens on', () => {
    root = fakeProc({ 101: ['socket:[41276]'], 202: ['socket:[41275]'] });
    expect(procListeningPids(5007, root)).toEqual([]);
  });

  it('skips a process whose open files it cannot read', () => {
    root = fakeProc({ 202: null, 303: ['socket:[41277]'] });
    expect(procListeningPids(5005, root)).toEqual([]);
    expect(procListeningPids(5004, root)).toEqual([303]);
  });

  // Root reads any directory, so only a normal user sees the kernel refuse another user's fd/.
  it.skipIf(process.getuid?.() === 0)("skips another user's process, whose fd/ is not readable", () => {
    root = fakeProc({ 202: ['socket:[41275]'], 303: ['socket:[41277]'] });
    chmodSync(join(root, '202', 'fd'), 0o000);
    try {
      expect(procListeningPids(5005, root)).toEqual([]);
      expect(procListeningPids(5004, root)).toEqual([303]);
    } finally {
      chmodSync(join(root, '202', 'fd'), 0o755);
    }
  });
});

describe('listeningPidsForPort', () => {
  let root = '';
  const spawned: string[] = [];
  const original = process.platform;

  /** BusyBox's `lsof` on PATH, as on Alpine. */
  async function importOn(platform: NodeJS.Platform) {
    spawned.length = 0;
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      spawnSync: vi.fn((command: string, args: readonly string[] = []) => {
        spawned.push(command);
        if (command === 'which') return { status: 0, stdout: `/usr/bin/${args[0]}\n`, stderr: '' };
        if (command === 'lsof') return { status: 0, stdout: platform === 'darwin' ? '4242\n' : BUSYBOX_LSOF, stderr: '' };
        return { status: 1, stdout: '', stderr: '' };
      }),
    }));
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    return import('../lib/cli-proc');
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: original });
    vi.doUnmock('node:child_process');
    vi.resetModules();
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  // Regression (CI-Hub#1726): on Alpine, `cihub up local` stopped at "Port 5005 is already in use by
  // another process" with nothing listening, because BusyBox's lsof listed every open file.
  it('asks the kernel on Linux, and never runs lsof', async () => {
    root = fakeProc({ 1: ['/dev/null'], 7: ['/dev/null', 'socket:[41275]'] });
    const { listeningPidsForPort } = await importOn('linux');

    expect(listeningPidsForPort(5005, root)).toEqual([7]);
    expect(listeningPidsForPort(5007, root)).toEqual([]);
    expect(spawned).not.toContain('lsof');
  });

  it('keeps lsof on macOS', async () => {
    const { listeningPidsForPort } = await importOn('darwin');

    expect(listeningPidsForPort(5005)).toEqual([4242]);
    expect(spawned).toContain('lsof');
  });
});
