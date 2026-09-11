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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, runBestEffort } from '../lib/cli-proc';
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
