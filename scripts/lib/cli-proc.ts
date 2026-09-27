import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { BASE_COMMAND } from './cli-types.js';
import { colorize, printMessageBox } from './cli-ui.js';

const LOCAL_DEV_BACKEND_PORT = '5004';
const LOCAL_DEV_FRONTEND_PORT = '5005';

/**
 * Why spawnSync could not START `cmd`. A missing `cwd` is reported as `spawnSync docker ENOENT`
 * by Node and `ENOENT: no such file or directory, posix_spawn 'docker'` by Bun (which compiles the
 * shipped `cihub` binary) — both name the executable, not the directory, and `code`/`syscall`/
 * `path` are identical to a genuinely missing binary. So an appliance whose Hub data dir is gone,
 * or mistyped via `CI_HUB_DATA_DIR`, was told docker is not installed. Check the directory
 * ourselves; the error object cannot tell the two apart.
 */
function spawnFailureMessage(cmd: string, cwd: string, error: Error): string {
  if (!existsSync(cwd)) return `Failed to run ${cmd}: working directory does not exist: ${cwd}`;
  return `Failed to run ${cmd}: ${String(error)}`;
}

export function run(cmd: string, args: string[], extraEnv: Record<string, string | undefined> = {}, cwd: string = process.cwd()) {
  console.log(colorize(`\u2192 ${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`, 'dim'));
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    cwd,
  });
  if (result.error) {
    console.error(colorize(spawnFailureMessage(cmd, cwd, result.error), 'red'));
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** Best-effort variant of {@link run}: streams output but never aborts the CLI on failure. */
export function runBestEffort(cmd: string, args: string[], extraEnv: Record<string, string | undefined> = {}, cwd: string = process.cwd()): boolean {
  console.log(colorize(`\u2192 ${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`, 'dim'));
  const result = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...extraEnv }, cwd });
  // Nothing was streamed when the process never started, so without this line the operator sees
  // the `→ docker ...` echo and then silence.
  if (result.error) console.error(colorize(spawnFailureMessage(cmd, cwd, result.error), 'yellow'));
  return result.status === 0;
}

export async function runScript<T>(
  label: string,
  fn: () => T | Promise<T>,
  extraEnv: Record<string, string | undefined> = {},
  cwd?: string,
): Promise<T> {
  console.log(colorize(`\u2192 ${label}`, 'dim'));
  const previousValues = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(extraEnv)) {
    previousValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const previousCwd = cwd ? process.cwd() : undefined;
  if (cwd) process.chdir(cwd);

  try {
    return await fn();
  } catch (error) {
    console.error(colorize(`Failed to run ${label}: ${String(error)}`, 'red'));
    process.exit(1);
  } finally {
    if (cwd && previousCwd) process.chdir(previousCwd);
    for (const [key, value] of previousValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export function runCapture(cmd: string, args: string[], extraEnv: Record<string, string | undefined> = {}): { stdout: string; ok: boolean } {
  const result = spawnSync(cmd, args, { encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, ...extraEnv } });
  return { stdout: (result.stdout || '').trim(), ok: result.status === 0 };
}

export function commandExists(cmd: string): boolean {
  return runCapture(process.platform === 'win32' ? 'where' : 'which', [cmd]).ok;
}

function listeningPidsForPort(port: number): number[] {
  if (process.platform === 'win32' || !commandExists('lsof')) return [];
  const { stdout, ok } = runCapture('lsof', ['-t', '-n', `-iTCP:${port}`, '-sTCP:LISTEN']);
  if (!ok || !stdout) return [];
  return stdout
    .split('\n')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function commandLineForPid(pid: number): string {
  if (process.platform === 'win32') return '';
  const { stdout, ok } = runCapture('ps', ['-p', String(pid), '-o', 'command=']);
  return ok ? stdout.trim() : '';
}

function sleepMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Intentional short synchronous wait for local-dev port cleanup.
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Best effort: if the process already exited we do not need to fail startup.
  }
}

export function ensureLocalDevPortsAvailable(): void {
  const frontendPort = Number.parseInt(LOCAL_DEV_FRONTEND_PORT, 10);
  const backendPort = Number.parseInt(LOCAL_DEV_BACKEND_PORT, 10);
  const frontendPids = listeningPidsForPort(frontendPort);
  const backendPids = listeningPidsForPort(backendPort);
  const repoRoot = process.cwd();

  const staleFrontend = frontendPids.filter((pid) => {
    const command = commandLineForPid(pid);
    return command.includes(repoRoot) && command.includes('@react-router/dev/bin.js dev');
  });
  const staleBackend = backendPids.filter((pid) => {
    const command = commandLineForPid(pid);
    return (
      command.includes(repoRoot) &&
      (command.includes('nest start --watch --preserveWatchOutput') ||
        command.includes('/packages/backend/') ||
        command.includes('packages/backend/dist/src/main.js'))
    );
  });

  for (const pid of [...staleFrontend, ...staleBackend]) {
    killPid(pid);
  }

  if (staleFrontend.length > 0 || staleBackend.length > 0) {
    sleepMs(1500);
  }

  const remainingFrontend = listeningPidsForPort(frontendPort).filter((pid) => !staleFrontend.includes(pid));
  if (remainingFrontend.length > 0) {
    printMessageBox(
      'Local development port conflict',
      [`Port ${LOCAL_DEV_FRONTEND_PORT} is already in use by another process. Stop it before running ${BASE_COMMAND} up local.`],
      'red',
    );
    process.exit(2);
  }

  const remainingBackend = listeningPidsForPort(backendPort).filter((pid) => !staleBackend.includes(pid));
  if (remainingBackend.length > 0) {
    printMessageBox(
      'Local development port conflict',
      [`Port ${LOCAL_DEV_BACKEND_PORT} is already in use by another process. Stop it before running ${BASE_COMMAND} up local.`],
      'red',
    );
    process.exit(2);
  }
}
