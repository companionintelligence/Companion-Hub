import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServerFactory } from '../mcp-server.factory';
import { McpService } from '../mcp.service';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { LoggerService } from '@/core/logger/logger.service';

// BUG-MCP-1 acceptance test: drive the factory's SDK server with a REAL MCP SDK client over the
// in-memory transport (not raw fetch). This proves the Hub speaks the protocol end-to-end —
// initialize handshake, tools/list, tools/call — the exact path a standard client uses.

/** Build a factory-backed server and connect a real MCP client to it in-process. */
async function connectClient(registry: McpToolRegistry): Promise<Client> {
  const service = new McpService(registry, mock<LoggerService>());
  const factory = new McpServerFactory(registry, service, mock<LoggerService>());
  const server = factory.create();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'ci-hub-test-client', version: '1.0.0' });
  await client.connect(clientTransport); // performs the initialize handshake
  return client;
}

describe('McpServerFactory (real MCP client over in-memory transport)', () => {
  let registry: McpToolRegistry;

  beforeEach(() => {
    registry = new McpToolRegistry();
    delete process.env.MCP_ALLOW_DESTRUCTIVE;
  });

  it('completes the initialize handshake and reports server info', async () => {
    const client = await connectClient(registry);
    expect(client.getServerVersion()?.name).toBe('ci-hub');
  });

  it('lists registered tools', async () => {
    registry.register({
      name: 'hub_demo',
      description: 'demo',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ ok: true }),
    });
    const client = await connectClient(registry);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('hub_demo');
  });

  it('calls a tool and returns its result as JSON text content', async () => {
    registry.register({ name: 'hub_echo', description: '', inputSchema: { type: 'object' }, handler: async (p) => ({ echoed: p.value }) });
    const client = await connectClient(registry);
    const res = await client.callTool({ name: 'hub_echo', arguments: { value: 42 } });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual({ echoed: 42 });
  });

  it('returns a JSON-RPC -32602 error for an unknown tool', async () => {
    const client = await connectClient(registry);
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toMatchObject({ code: -32602 });
  });

  // Regression: a void-returning handler must still produce a schema-valid result. Before the fix,
  // formatToolSuccess(undefined) yielded {text: undefined}, which the SDK's CallToolResultSchema
  // rejected — turning a successful delete/update into a JSON-RPC error the agent might retry.
  it('returns a valid (non-error) result for a tool that resolves to undefined', async () => {
    registry.register({ name: 'hub_void', description: '', inputSchema: { type: 'object' }, handler: async () => undefined });
    const client = await connectClient(registry);
    const res = await client.callTool({ name: 'hub_void', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0].text).toBe('null');
  });

  it('blocks a destructive tool by default and returns an isError result (ISSUE-MCP-2)', async () => {
    registry.register({
      name: 'hub_wipe',
      destructive: true,
      description: '',
      inputSchema: { type: 'object' },
      handler: async () => ({ done: true }),
    });
    const client = await connectClient(registry);
    const res = await client.callTool({ name: 'hub_wipe', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/destructive/i);
  });

  it('allows a destructive tool when MCP_ALLOW_DESTRUCTIVE=true', async () => {
    registry.register({
      name: 'hub_wipe2',
      destructive: true,
      description: '',
      inputSchema: { type: 'object' },
      handler: async () => ({ done: true }),
    });
    process.env.MCP_ALLOW_DESTRUCTIVE = 'true';
    const client = await connectClient(registry);
    const res = await client.callTool({ name: 'hub_wipe2', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse((res.content as Array<{ text: string }>)[0].text)).toEqual({ done: true });
  });
});
