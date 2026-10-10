/**
 * Reading what a command printed inside a container, on an engine that loses `docker exec` output.
 *
 * `docker exec` sends the command's output back over a connection that the docker CLI half-closes as
 * soon as it has no input left to send, which with no stdin attached is straight away. The Docker
 * engine the desktop app runs in WSL2 listens on `tcp://127.0.0.1:2375` inside WSL (context
 * `wsl-engine`), and Windows reaches it through WSL's localhost forwarding. Through that path the
 * stream ends at the half-close: nothing the command prints comes back, and the CLI asks for the exit
 * status before the command has finished, so it exits 0 whatever the command does.
 *
 * `docker cp` returns a file in an ordinary HTTP response, which arrives whole. So when a command that
 * always prints something comes back empty, it runs again detached (`docker exec -d`, no stream at
 * all), writing its output and then its exit status to files in the container, and the files are
 * copied out once the status is there.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { currentDockerContextName } from './docker-engine.js';

export interface ContainerOutput {
  /** The command's exit status, or null when docker could not run it or no status came back. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** True when the command's result could not be read back, so `status` says nothing about it. */
  lost?: boolean;
}

export interface ContainerReadOptions {
  /** How long to wait for the command; 30 s when unset. */
  timeoutMs?: number;
  /**
   * False for a command that must run only once, such as an INSERT. When its output does not come
   * back, it is not run again to read it, and the result is marked lost.
   */
  repeatable?: boolean;
}

export type ContainerReader = (command: string[], options?: ContainerReadOptions) => ContainerOutput;

const DEFAULT_TIMEOUT_MS = 30_000;
/** Pause between looks for the exit status of a command run through the copy route. */
const POLL_INTERVAL_MS = 150;
/** Copied output larger than this is a fault on its own; every caller reads a few lines of text. */
const COPY_MAX_BYTES = 32 * 1024 * 1024;
/**
 * Runs the command with its output, then its exit status, in files under `$1`. The status goes in
 * through a rename, so the folder holds all of the output whenever it holds `status`.
 */
const COPY_ROUTE_SCRIPT = 'd=$1; shift; mkdir -p "$d" || exit; "$@" >"$d/out" 2>"$d/err"; echo $? >"$d/status.tmp" && mv "$d/status.tmp" "$d/status"';

/**
 * Runs commands in `container` that always print something when they succeed, and returns what they
 * printed. An exit status of 0 with nothing printed therefore means the output was lost, and from then
 * on this reader runs every command through the copy route, so a command that must run only once is
 * never repeated to read its output.
 */
export function containerReader(container: string): ContainerReader {
  let copyOut = false;
  return (command, options = {}) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!copyOut) {
      const direct = execDirect(container, command, timeoutMs);
      if (direct.status !== 0 || direct.stdout !== '') return direct;
      copyOut = true;
      if (options.repeatable === false) return { ...direct, lost: true };
    }
    return execThroughCopy(container, command, timeoutMs);
  };
}

/** {@link containerReader} for one command. */
export function readContainerOutput(container: string, command: string[], options?: ContainerReadOptions): ContainerOutput {
  return containerReader(container)(command, options);
}

/**
 * Which Docker engine the docker CLI is talking to, for a message about output that never arrived:
 * `DOCKER_HOST=<url>` when that is set, since the CLI then ignores contexts, otherwise the context
 * and the address it points at.
 */
export function describeDockerEndpoint(): string {
  const host = process.env.DOCKER_HOST?.trim();
  if (host) return `DOCKER_HOST=${host}`;
  const context = process.env.DOCKER_CONTEXT?.trim() || currentDockerContextName() || 'default';
  const inspected = spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', context], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 10_000,
  });
  const endpoint = inspected.status === 0 ? (inspected.stdout ?? '').trim() : '';
  return endpoint ? `Docker context ${context} (${endpoint})` : `Docker context ${context}`;
}

function execDirect(container: string, command: string[], timeoutMs: number): ContainerOutput {
  const result = spawnSync('docker', ['exec', container, ...command], { encoding: 'utf-8', stdio: 'pipe', timeout: timeoutMs });
  return {
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    // result.error covers docker itself being absent, where there is no stderr to read.
    stderr: (result.stderr ?? '').trim() || (result.error ? String(result.error) : ''),
  };
}

/**
 * Starts `command` detached with its output sent to a new folder under /tmp in the container, copies
 * the folder out with `docker cp` once the exit status is in it, and removes it.
 */
function execThroughCopy(container: string, command: string[], timeoutMs: number): ContainerOutput {
  const dir = `/tmp/cihub-exec-${randomBytes(8).toString('hex')}`;
  const started = spawnSync('docker', ['exec', '-d', container, 'sh', '-c', COPY_ROUTE_SCRIPT, 'sh', dir, ...command], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: timeoutMs,
  });
  // Nothing ran, and docker said why: a stopped container, or no docker at all.
  if (started.status !== 0) {
    return { status: started.status, stdout: '', stderr: (started.stderr ?? '').trim() || (started.error ? String(started.error) : '') };
  }

  const deadline = Date.now() + timeoutMs;
  let files: Map<string, string> | undefined;
  for (;;) {
    const copy = spawnSync('docker', ['cp', `${container}:${dir}`, '-'], { stdio: 'pipe', timeout: timeoutMs, maxBuffer: COPY_MAX_BYTES });
    const copied = copy.status === 0 && Buffer.isBuffer(copy.stdout) ? filesInTar(copy.stdout) : undefined;
    if (copied?.has('status')) {
      files = copied;
      break;
    }
    if (Date.now() >= deadline) break;
    sleepMs(POLL_INTERVAL_MS);
  }
  spawnSync('docker', ['exec', '-d', container, 'rm', '-rf', dir], { stdio: 'ignore', timeout: 10_000 });

  if (!files) return { status: null, stdout: '', stderr: '', lost: true };
  const status = Number.parseInt(files.get('status') ?? '', 10);
  return { status: Number.isNaN(status) ? null : status, stdout: (files.get('out') ?? '').trim(), stderr: (files.get('err') ?? '').trim() };
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A NUL-terminated tar header field as text. */
function headerField(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf-8');
}

/**
 * The regular files in a tar archive, by base name. `docker cp <container>:<dir> -` sends a ustar
 * archive: a header block per entry, then its data padded to 512 bytes, ended by zero blocks.
 */
function filesInTar(archive: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    const name = headerField(header.subarray(0, 100));
    if (!name) break;
    const size = Number.parseInt(headerField(header.subarray(124, 136)).trim(), 8) || 0;
    const type = header[156];
    // '0' and NUL mark a regular file; folders, links and extended headers are skipped.
    if (type === 0x30 || type === 0) {
      files.set(name.split('/').filter(Boolean).pop() ?? name, archive.subarray(offset + 512, offset + 512 + size).toString('utf-8'));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
