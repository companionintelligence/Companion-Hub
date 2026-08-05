import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** Spec-required initialize params for upstream MCP stdio servers. */
const INITIALIZE_PARAMS = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'ci-hub-mcp-bridge', version: '1.0.0' },
} as const;

export type StdioSpawnSpec = {
  launch: 'container_exec' | 'host_docker';
  command: string[];
  container?: string;
  env?: Record<string, string>;
};

export class StdioSilentExitError extends Error {
  constructor(label: string, code: number | null) {
    super(`MCP stdio server for ${label} exited (code ${code}) without emitting any response`);
    this.name = 'StdioSilentExitError';
  }
}

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

  constructor(
    private readonly label: string,
    private readonly spec: StdioSpawnSpec,
    private readonly onStderr?: (chunk: string) => void,
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
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }

  get alive(): boolean {
    return this.proc !== null && !this.closed;
  }

  private async ensureReady(timeoutMs: number): Promise<void> {
    if (this.ready && this.alive) {
      return this.ready;
    }
    this.close();
    this.closed = false;
    this.ready = this.bootstrap(timeoutMs);
    return this.ready;
  }

  private async bootstrap(timeoutMs: number): Promise<void> {
    this.proc = this.spawnProcess();
    this.wireProcess(this.proc);
    await this.exchange({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS }, 1, timeoutMs);
    this.writeLine({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  private spawnProcess(): ChildProcessWithoutNullStreams {
    const { launch, command, container, env } = this.spec;
    if (launch === 'host_docker') {
      if (command.length === 0) {
        throw new Error(`No MCP command configured for ${this.label}`);
      }
      return spawn(command[0]!, command.slice(1), {
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
    proc.stdout.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.drainBuffer();
    });

    proc.stderr.on('data', (data: Buffer) => {
      this.onStderr?.(data.toString());
    });

    proc.on('close', (code) => {
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
        const parsed = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { message?: string } };
        this.sawAnyResponse = true;
        if (typeof parsed.id !== 'number' || !this.pending.has(parsed.id)) continue;
        const waiter = this.pending.get(parsed.id)!;
        this.pending.delete(parsed.id);
        if (parsed.error) {
          waiter.reject(new Error(`MCP error from ${this.label}: ${parsed.error.message ?? 'unknown'}`));
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
