import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServerError, McpStdioSession, type McpStdioSessionOptions } from '../mcp-stdio-session';
import { type FakeStdioServer, makeFakeStdioServer, waitForExit } from './fake-stdio-mcp-server';

describe('McpStdioSession', () => {
  let server: FakeStdioServer;
  let session: McpStdioSession | undefined;

  beforeEach(() => {
    server = makeFakeStdioServer();
  });

  afterEach(() => {
    session?.close();
    session = undefined;
    server.cleanup();
  });

  const open = (options: McpStdioSessionOptions = {}) => {
    session = new McpStdioSession('fake-mcp:store', { launch: 'host_docker', command: server.command }, undefined, options);
    return session;
  };

  it('starts a fresh process after a start that timed out, instead of replaying the timeout', async () => {
    server.setDelay(3000);
    const s = open({ hostDockerStartTimeoutMs: 300 });

    await expect(s.request('tools/list', {}, 300)).rejects.toThrow(/timeout.*initialize/);
    const [first] = await server.waitForPids(1);
    expect(await waitForExit(first as number)).toBe(true);

    server.setDelay(0);
    await expect(s.request('tools/list', {}, 5000)).resolves.toMatchObject({ tools: [{ name: 'echo_token' }, { name: 'fail' }] });
    expect(server.pids()).toHaveLength(2);
  });

  it('gives a host_docker server the longer start budget, since its image pull happens inside it', async () => {
    server.setDelay(600);
    const s = open({ hostDockerStartTimeoutMs: 10_000 });

    await expect(s.request('tools/list', {}, 100)).resolves.toMatchObject({ tools: [{ name: 'echo_token' }, { name: 'fail' }] });
  });

  it('works again right after close(), even though the old process exits after the new one starts', async () => {
    const s = open();
    await s.request('tools/list', {}, 5000);

    s.close();

    await expect(s.request('tools/list', {}, 5000)).resolves.toMatchObject({ tools: [{ name: 'echo_token' }, { name: 'fail' }] });
    expect(server.pids()).toHaveLength(2);
  });

  it('keeps the process when the server answers with a JSON-RPC error', async () => {
    const s = open();

    const error = await s.request('tools/call', { name: 'fail', arguments: {} }, 5000).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpServerError);
    expect((error as McpServerError).message).toBe('MCP error from fake-mcp:store: failed on purpose');
    expect((error as McpServerError).code).toBe(-32603);
    expect(s.alive).toBe(true);
    await s.request('tools/list', {}, 5000);
    expect(server.pids()).toHaveLength(1);
  });
});
