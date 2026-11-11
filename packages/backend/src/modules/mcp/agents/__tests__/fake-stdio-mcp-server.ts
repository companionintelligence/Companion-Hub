import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

// The test setup swaps node:fs for memfs, but the child process writes to the real disk.
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

/**
 * A stand-in stdio MCP server, run as a real child process with `node -e`. It records its pid,
 * waits as long as the delay file says before reading stdin (a `docker run` still pulling its
 * image), answers initialize and tools/list, echoes FAKE_TOKEN from its environment for any tool
 * call, and answers the `fail` tool with a JSON-RPC error.
 */
const SCRIPT = String.raw`
const fs = require('fs');
const readline = require('readline');
const [pidFile, delayFile] = process.argv.slice(1);
fs.appendFileSync(pidFile, process.pid + '\n');
const delay = fs.existsSync(delayFile) ? Number(fs.readFileSync(delayFile, 'utf8')) || 0 : 0;
setTimeout(() => {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id === undefined) return;
    const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...o }) + '\n');
    if (m.method === 'initialize') return send({ result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake', version: '0' } } });
    if (m.method === 'tools/list') return send({ result: { tools: [
      { name: 'echo_token', description: 'Returns FAKE_TOKEN', inputSchema: { type: 'object' } },
      { name: 'fail', description: 'Always fails', inputSchema: { type: 'object' } },
    ] } });
    if (m.method === 'tools/call' && m.params.name === 'fail') return send({ error: { code: -32603, message: 'failed on purpose' } });
    if (m.method === 'tools/call') return send({ result: { content: [{ type: 'text', text: process.env.FAKE_TOKEN || '' }] } });
    send({ error: { code: -32601, message: 'unknown method' } });
  });
  rl.on('close', () => process.exit(0));
}, delay);
`;

export type FakeStdioServer = {
  /** Spawn command, as an MCP config's `command` array. */
  command: string[];
  /** Pids of every process started so far, in order. */
  pids: () => number[];
  /** Resolves once at least `count` processes have started. */
  waitForPids: (count: number, timeoutMs?: number) => Promise<number[]>;
  /** How long processes started from now on wait before reading stdin. */
  setDelay: (ms: number) => void;
  cleanup: () => void;
};

export function makeFakeStdioServer(): FakeStdioServer {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-stdio-mcp-'));
  const pidFile = path.join(dir, 'pids');
  const delayFile = path.join(dir, 'delay');
  const pids = () =>
    existsSync(pidFile)
      ? readFileSync(pidFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => Number(line))
      : [];

  return {
    command: [process.execPath, '-e', SCRIPT, pidFile, delayFile],
    pids,
    waitForPids: async (count, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (pids().length < count) {
        if (Date.now() > deadline) throw new Error(`expected ${count} fake server process(es), saw ${pids().length}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return pids();
    },
    setDelay: (ms) => writeFileSync(delayFile, String(ms)),
    cleanup: () => {
      for (const pid of pids()) {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** True once `pid` is gone, false if it is still running after `timeoutMs`. */
export async function waitForExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
