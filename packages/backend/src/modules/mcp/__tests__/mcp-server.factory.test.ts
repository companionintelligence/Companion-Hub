import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServerFactory } from '../mcp-server.factory';
import { McpService } from '../mcp.service';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { mcpCallContext } from '../mcp-call-context';
import type { ApiKeyCapability } from '@/modules/api-keys/api-key.capabilities';
import { LoggerService } from '@/core/logger/logger.service';

// BUG-MCP-1 acceptance test: drive the factory's SDK server with a REAL MCP SDK client over the
// in-memory transport (not raw fetch). This proves the Hub speaks the protocol end-to-end —
// initialize handshake, tools/list, tools/call — the exact path a standard client uses.
//
// It also proves the capability gate survives the SDK. Between the controller and a tool handler sits
// the SDK's transport and dispatcher, with no seam to pass a request through, so the calling key
// travels in async storage; a test that called the registry directly would prove nothing about
// whether it actually arrives.

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

/** Make a client request as a key with the given capability — what McpController does around
 *  transport.handleRequest for every authenticated MCP request. */
function asKey<T>(capability: ApiKeyCapability, fn: () => Promise<T>): Promise<T> {
  return mcpCallContext.run({ id: 1, name: 'test-key', capability, ownerAppUrn: null, createdByUserId: null }, fn);
}

const readTool = (name: string, result: unknown = { ok: true }) => ({
  name,
  access: 'read' as const,
  description: '',
  inputSchema: { type: 'object' },
  handler: async () => result,
});

const writeTool = (name: string, result: unknown = { changed: true }) => ({
  ...readTool(name, result),
  access: 'write' as const,
});

const textOf = (res: { content: unknown }) => (res.content as Array<{ text: string }>)[0].text;

describe('McpServerFactory (real MCP client over in-memory transport)', () => {
  let registry: McpToolRegistry;

  beforeEach(() => {
    registry = new McpToolRegistry();
  });

  it('completes the initialize handshake and reports server info', async () => {
    const client = await connectClient(registry);
    expect(client.getServerVersion()?.name).toBe('ci-hub');
  });

  it('lists registered tools', async () => {
    registry.register(readTool('hub_demo'));
    const client = await connectClient(registry);
    const { tools } = await asKey('write', () => client.listTools());
    expect(tools.map((tool) => tool.name)).toContain('hub_demo');
  });

  it('calls a tool and returns its result as JSON text content', async () => {
    registry.register({ ...readTool('hub_echo'), handler: async (p) => ({ echoed: p.value }) });
    const client = await connectClient(registry);
    const res = await asKey('read', () => client.callTool({ name: 'hub_echo', arguments: { value: 42 } }));
    expect(JSON.parse(textOf(res))).toEqual({ echoed: 42 });
  });

  it('returns a JSON-RPC -32602 error for an unknown tool', async () => {
    const client = await connectClient(registry);
    await expect(asKey('full', () => client.callTool({ name: 'nope', arguments: {} }))).rejects.toMatchObject({ code: -32602 });
  });

  // Regression: a void-returning handler must still produce a schema-valid result. Before the fix,
  // formatToolSuccess(undefined) yielded {text: undefined}, which the SDK's CallToolResultSchema
  // rejected — turning a successful delete/update into a JSON-RPC error the agent might retry.
  it('returns a valid (non-error) result for a tool that resolves to undefined', async () => {
    registry.register({ ...readTool('hub_void'), handler: async () => undefined });
    const client = await connectClient(registry);
    const res = await asKey('read', () => client.callTool({ name: 'hub_void', arguments: {} }));
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe('null');
  });

  it('advertises MCP annotations so a client can warn before it calls', async () => {
    registry.register(readTool('hub_look'));
    registry.register({ ...writeTool('hub_wipe'), destructive: true });
    const client = await connectClient(registry);

    const { tools } = await asKey('full', () => client.listTools());
    expect(tools.find((tool) => tool.name === 'hub_look')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find((tool) => tool.name === 'hub_wipe')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  describe('per-key capability, carried through the SDK', () => {
    beforeEach(() => {
      registry.register(readTool('hub_look'));
      registry.register(writeTool('hub_restart'));
      registry.register({ ...writeTool('hub_wipe', { done: true }), destructive: true });
    });

    it('shows a read-only key only the tools it can run', async () => {
      const client = await connectClient(registry);
      const { tools } = await asKey('read', () => client.listTools());
      expect(tools.map((tool) => tool.name)).toEqual(['hub_look']);
    });

    it('shows a write key everything except destructive tools', async () => {
      const client = await connectClient(registry);
      const { tools } = await asKey('write', () => client.listTools());
      expect(tools.map((tool) => tool.name)).toEqual(['hub_look', 'hub_restart']);
    });

    it('refuses a mutating tool to a read-only key as an isError result, not a crashed session', async () => {
      const client = await connectClient(registry);
      const res = await asKey('read', () => client.callTool({ name: 'hub_restart', arguments: {} }));
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/read-only/i);
    });

    it('blocks a destructive tool for a write key and allows it for a full key (ISSUE-MCP-2, per key)', async () => {
      const client = await connectClient(registry);

      const blocked = await asKey('write', () => client.callTool({ name: 'hub_wipe', arguments: {} }));
      expect(blocked.isError).toBe(true);
      expect(textOf(blocked)).toMatch(/destructive/i);

      const allowed = await asKey('full', () => client.callTool({ name: 'hub_wipe', arguments: {} }));
      expect(allowed.isError).toBeFalsy();
      expect(JSON.parse(textOf(allowed))).toEqual({ done: true });
    });

    it('one session serves both keys at their own level, since capability is read per request', async () => {
      // The same connected server answers both calls. Binding capability at initialize instead would
      // let a session outlive the authority that opened it — a key demoted mid-session would keep
      // writing until the session closed.
      const client = await connectClient(registry);

      expect((await asKey('full', () => client.callTool({ name: 'hub_wipe', arguments: {} }))).isError).toBeFalsy();
      expect((await asKey('read', () => client.callTool({ name: 'hub_wipe', arguments: {} }))).isError).toBe(true);
    });

    it('falls back to read-only when there is no caller context at all', async () => {
      // Should be unreachable — the guard runs on every route — so the honest reading of "we do not
      // know who is calling" is the least authority, not the most.
      const client = await connectClient(registry);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['hub_look']);
      expect((await client.callTool({ name: 'hub_restart', arguments: {} })).isError).toBe(true);
    });
  });
});
