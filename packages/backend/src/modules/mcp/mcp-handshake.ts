import { spawn } from 'node:child_process';

/** Minimal stdio MCP handshake (initialize → notifications/initialized → tools/list). */
export type McpHandshakeResult = {
  ok: boolean;
  tools: string[];
  reason: string;
  stderr: string;
};

const INITIALIZE_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'ci-hub-mcp-probe', version: '1.0.0' },
} as const;

/**
 * Drive MCP stdio handshake over docker exec — extracted from scripts/qa-mcp.ts for reuse.
 * Used by QA tooling and runtime probes that target a specific container + command.
 */
export function runStdioMcpHandshake(dockerArgs: string[], env: Record<string, string> = {}, timeoutMs = 90_000): Promise<McpHandshakeResult> {
  return new Promise((resolve) => {
    const proc = spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let buf = '';
    let stderr = '';
    let done = false;
    let sawInit = false;
    let liveTools: string[] = [];

    const finish = (result: Omit<McpHandshakeResult, 'stderr'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve({ ...result, stderr: stderr.slice(-800) });
    };

    const send = (payload: Record<string, unknown>) => {
      try {
        proc.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch {
        /* pipe closed */
      }
    };

    const timer = setTimeout(
      () => finish({ ok: false, tools: [], reason: sawInit ? 'no tools/list before deadline' : 'no initialize response before deadline' }),
      timeoutMs,
    );

    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) {
            return finish({ ok: false, tools: [], reason: `initialize error: ${JSON.stringify(msg.error).slice(0, 160)}` });
          }
          sawInit = true;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) {
            return finish({ ok: false, tools: [], reason: `tools/list error: ${JSON.stringify(msg.error).slice(0, 160)}` });
          }
          const result = (msg.result ?? {}) as { tools?: Array<{ name?: string }> };
          liveTools = (result.tools ?? []).map((t) => t.name ?? '').filter(Boolean);
          return finish({ ok: true, tools: liveTools, reason: 'handshake complete' });
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => finish({ ok: false, tools: [], reason: `docker spawn failed: ${err.message}` }));
    proc.on('exit', (code) => {
      if (!sawInit && !done) {
        setTimeout(() => finish({ ok: false, tools: [], reason: `container exited (code ${code}) before initialize` }), 300);
      }
    });

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS });
  });
}
