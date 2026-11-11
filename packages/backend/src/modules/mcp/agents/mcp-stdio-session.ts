import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** Spec-required initialize params for upstream MCP stdio servers. */
const INITIALIZE_PARAMS = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'ci-hub-mcp-bridge', version: '1.0.0' },
} as const;

/**
 * How long a host_docker server gets to answer `initialize`. Its `docker run` pulls the image first
 * when the Hub doesn't have it yet and the pull happens inside this wait: GitHub MCP's first start
 * took 13.7 s and 16.6 s on a laptop, against the 15 s a request otherwise allows. A container_exec
 * server runs in a container that is already up, so it keeps the caller's budget.
 */
export const HOST_DOCKER_START_TIMEOUT_MS = 120_000;

export type StdioSpawnSpec = {
  launch: 'container_exec' | 'host_docker';
  command: string[];
  container?: string;
  env?: Record<string, string>;
};

export type McpStdioSessionOptions = {
  /** Overrides {@link HOST_DOCKER_START_TIMEOUT_MS} (tests use a short one). */
  hostDockerStartTimeoutMs?: number;
};

export class StdioSilentExitError extends Error {
  constructor(label: string, code: number | null) {
    super(`MCP stdio server for ${label} exited (code ${code}) without emitting any response`);
    this.name = 'StdioSilentExitError';
  }
}

/**
 * The server answered with a JSON-RPC error (a tool that failed, bad arguments). The process is
 * healthy and the session stays usable, unlike a timeout or an exit.
 */
export class McpServerError extends Error {
  constructor(
    label: string,
    message: string,
    readonly code?: number,
  ) {
    super(`MCP error from ${label}: ${message}`);
    this.name = 'McpServerError';
  }
}

/**
 * End stdin before the signal. `docker run` forwards SIGTERM to the container and keeps waiting. A
 * server running as PID 1 with no SIGTERM handler (a Node or Python image) ignores it. End of input
 * reaches it through `docker run -i` and stops it.
 */
const stopProcess = (proc: ChildProcessWithoutNullStreams): void => {
  proc.stdin.end();
  proc.kill();
};

/**
 * Long-lived stdio MCP session — one server process, many JSON-RPC requests.
 * Replaces per-call `docker exec` for container_exec listings and supports
 * host_docker (`docker run …`) commands that cannot run inside exec.
 */
export class McpStdioSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextRequestId = 2;
  private ready: Promise<void> | null = null;
  private sawAnyResponse = false;
  private closed = false;
  private started = false;

  constructor(
    private readonly label: string,
    private readonly spec: StdioSpawnSpec,
    private readonly onStderr?: (chunk: string) => void,
    private readonly options: McpStdioSessionOptions = {},
  ) {}

  async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    await this.ensureReady(timeoutMs);
    const id = this.nextRequestId++;
    return this.exchange({ jsonrpc: '2.0', id, method, params }, id, timeoutMs);
  }

  close(): void {
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(new Error(`MCP stdio session for ${this.label} closed`));
    }
    this.pending.clear();
    if (this.proc) {
      stopProcess(this.proc);
    }
    this.proc = null;
    this.ready = null;
  }

  /**
   * A session no request has started yet counts as alive. Otherwise a second caller would close it
   * before its first request runs. That request would then start a process nobody holds.
   */
  get alive(): boolean {
    return !this.closed && (this.proc !== null || !this.started);
  }

  private async ensureReady(timeoutMs: number): Promise<void> {
    if (this.ready && this.alive) {
      return this.ready;
    }
    this.close();
    this.closed = false;
    this.started = true;
    this.ready = this.bootstrap(this.startTimeout(timeoutMs));
    return this.ready;
  }

  private startTimeout(timeoutMs: number): number {
    if (this.spec.launch !== 'host_docker') {
      return timeoutMs;
    }
    return Math.max(timeoutMs, this.options.hostDockerStartTimeoutMs ?? HOST_DOCKER_START_TIMEOUT_MS);
  }

  private async bootstrap(timeoutMs: number): Promise<void> {
    const proc = this.spawnProcess();
    this.proc = proc;
    this.buffer = '';
    this.sawAnyResponse = false;
    this.wireProcess(proc);
    try {
      await this.exchange({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS }, 1, timeoutMs);
    } catch (error) {
      // A server that missed `initialize` used to stay running with `ready` rejected, so every later
      // request replayed the same failure at once until the Hub restarted. Stop it, so the next
      // request starts a fresh process.
      if (this.proc === proc) {
        this.proc = null;
        this.ready = null;
      }
      stopProcess(proc);
      throw error;
    }
    this.writeLine({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  private spawnProcess(): ChildProcessWithoutNullStreams {
    const { launch, command, container, env } = this.spec;
    if (launch === 'host_docker') {
      if (command.length === 0) {
        throw new Error(`No MCP command configured for ${this.label}`);
      }
      const [bin, ...args] = command;
      if (!bin) {
        throw new Error(`No MCP command configured for ${this.label}`);
      }
      return spawn(bin, args, {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    if (!container) {
      throw new Error(`No MCP container configured for ${this.label}`);
    }
    if (command.length === 0) {
      throw new Error(`No MCP command configured for ${this.label}`);
    }
    return spawn('docker', ['exec', '-i', container, ...command], { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  private wireProcess(proc: ChildProcessWithoutNullStreams): void {
    // A killed process reports its exit after the next one may already be running. Its handlers
    // must not touch the session then, or they reject the new process's requests and drop its handle.
    const isCurrent = () => this.proc === proc;

    proc.stdin.on('error', () => {
      // A write to a server that stopped reading fails with EPIPE. Unheard, that error would take the
      // Hub down. The `close` handler below reports the server's exit to the waiting requests.
    });

    proc.stdout.on('data', (data: Buffer) => {
      if (!isCurrent()) return;
      this.buffer += data.toString();
      this.drainBuffer();
    });

    proc.stderr.on('data', (data: Buffer) => {
      this.onStderr?.(data.toString());
    });

    proc.on('close', (code) => {
      if (!isCurrent()) return;
      this.drainBuffer();
      if (!this.closed) {
        this.rejectAllPending(
          this.sawAnyResponse ? new Error(`MCP stdio server for ${this.label} exited (code ${code})`) : new StdioSilentExitError(this.label, code),
        );
      }
      this.proc = null;
      this.ready = null;
    });

    proc.on('error', (err) => {
      if (!isCurrent()) return;
      this.rejectAllPending(err);
      this.proc = null;
      this.ready = null;
    });
  }

  private async exchange(payload: Record<string, unknown>, id: number, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP stdio timeout for ${this.label} (${String(payload.method)})`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.writeLine(payload);
    });
  }

  private writeLine(payload: Record<string, unknown>): void {
    if (!this.proc?.stdin.writable) {
      throw new Error(`MCP stdio session for ${this.label} is not writable`);
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private drainBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { message?: string; code?: number } };
        this.sawAnyResponse = true;
        if (typeof parsed.id !== 'number' || !this.pending.has(parsed.id)) continue;
        const waiter = this.pending.get(parsed.id);
        if (!waiter) continue;
        this.pending.delete(parsed.id);
        if (parsed.error) {
          waiter.reject(new McpServerError(this.label, parsed.error.message ?? 'unknown', parsed.error.code));
        } else {
          waiter.resolve(parsed.result);
        }
      } catch {
        // partial or non-JSON line
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }
}
