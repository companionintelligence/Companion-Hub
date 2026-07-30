import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DestructiveToolDisabledError,
  McpToolNotFoundError,
  McpToolRegistry,
  WriteToolDeniedError,
  toToolDescriptor,
} from '../mcp-tool-registry.service';

/** A minimal read-only tool. `access` is required by the type, so every definition here states it —
 *  which is the point: a new tool cannot reach a read-only key by forgetting to. */
const readTool = (name: string, result: unknown = { ok: true }) => ({
  name,
  access: 'read' as const,
  description: '',
  inputSchema: {},
  handler: async () => result,
});

const writeTool = (name: string, result: unknown = { changed: true }) => ({
  name,
  access: 'write' as const,
  description: '',
  inputSchema: {},
  handler: async () => result,
});

describe('McpToolRegistry', () => {
  let registry: McpToolRegistry;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [McpToolRegistry],
    }).compile();

    registry = module.get<McpToolRegistry>(McpToolRegistry);
  });

  it('should be defined', () => {
    expect(registry).toBeDefined();
  });

  describe('tool registration', () => {
    it('should register a tool with name and schema', () => {
      registry.register(readTool('test_tool'));
      expect(registry.hasTool('test_tool')).toBe(true);
    });

    it('should reject duplicate tool names', () => {
      registry.register(readTool('dup_tool'));
      expect(() => registry.register(readTool('dup_tool'))).toThrow("Tool 'dup_tool' is already registered");
    });
  });

  describe('tool listing', () => {
    it('should return all registered tools with their JSON schemas', () => {
      registry.register({ ...readTool('tool_a'), inputSchema: { type: 'object' } });
      registry.register({ ...readTool('tool_b'), inputSchema: { type: 'string' } });
      const tools = registry.listTools();
      expect(tools).toHaveLength(2);
      expect(tools[0]?.name).toBe('tool_a');
      expect(tools[1]?.name).toBe('tool_b');
    });

    it('should return empty array when no tools registered', () => {
      expect(registry.listTools()).toEqual([]);
    });
  });

  describe('tool dispatch', () => {
    it('should invoke the correct handler for a registered tool', async () => {
      registry.register(readTool('my_tool', { result: 'ok' }));
      const result = await registry.callTool('my_tool', {});
      expect(result).toEqual({ result: 'ok' });
    });

    it('should throw McpToolNotFoundError for an unregistered tool name', async () => {
      await expect(registry.callTool('nonexistent', {})).rejects.toThrow(McpToolNotFoundError);
    });

    it('should pass parameters to the tool handler', async () => {
      let receivedParams: Record<string, unknown> = {};
      registry.register({
        ...readTool('param_tool'),
        handler: async (params) => {
          receivedParams = params;
          return {};
        },
      });
      await registry.callTool('param_tool', { foo: 'bar' });
      expect(receivedParams).toEqual({ foo: 'bar' });
    });
  });

  // A key's `capability` decides what it may run. This replaced the appliance-wide
  // MCP_ALLOW_DESTRUCTIVE env: the same ISSUE-MCP-2 guarantee, but per credential.
  describe('capability gating', () => {
    beforeEach(() => {
      registry.register(readTool('safe'));
      registry.register(writeTool('mutate'));
      registry.register({ ...writeTool('danger', { wiped: true }), destructive: true });
    });

    it('lets a read-only key run read tools', async () => {
      await expect(registry.callTool('safe', {}, { capability: 'read' })).resolves.toEqual({ ok: true });
    });

    it('refuses a mutating tool to a read-only key, and says write is what is needed', async () => {
      await expect(registry.callTool('mutate', {}, { capability: 'read' })).rejects.toThrow(WriteToolDeniedError);
      // Telling a caller to ask for 'full' when 'write' would do is how keys end up over-privileged.
      await expect(registry.callTool('mutate', {}, { capability: 'read' })).rejects.toThrow(/'write' capability/);
    });

    it('lets a write key mutate but still refuses destructive tools', async () => {
      await expect(registry.callTool('mutate', {}, { capability: 'write' })).resolves.toEqual({ changed: true });
      await expect(registry.callTool('danger', {}, { capability: 'write' })).rejects.toThrow(DestructiveToolDisabledError);
    });

    it('lets a full key run everything', async () => {
      await expect(registry.callTool('danger', {}, { capability: 'full' })).resolves.toEqual({ wiped: true });
    });

    it('names the calling capability in the destructive refusal, so the fix is obvious from the error', async () => {
      await expect(registry.callTool('danger', {}, { capability: 'read' })).rejects.toThrow(/capability is 'read'/);
    });

    it('reports a destructive tool as destructive to a read-only key, not merely as mutating', async () => {
      // The stronger fact first: 'write' would NOT be enough for this tool, so a WriteToolDeniedError
      // here would send the operator to grant a capability that still cannot run it.
      await expect(registry.callTool('danger', {}, { capability: 'read' })).rejects.toThrow(DestructiveToolDisabledError);
    });

    // Fail-closed: the agent path always supplies a capability, so its absence means the request
    // context was lost — which must read as the least authority, never the most.
    it('falls back to read-only when no capability is supplied', async () => {
      await expect(registry.callTool('safe', {})).resolves.toEqual({ ok: true });
      await expect(registry.callTool('mutate', {})).rejects.toThrow(WriteToolDeniedError);
    });

    it('honours an explicit allowDestructive override (the operator admin runner)', async () => {
      await expect(registry.callTool('danger', {}, { capability: 'full', allowDestructive: true })).resolves.toEqual({ wiped: true });
      // ...and refuses when the operator did not confirm, even at 'full'.
      await expect(registry.callTool('danger', {}, { capability: 'full', allowDestructive: false })).rejects.toThrow(DestructiveToolDisabledError);
    });
  });

  // hub_call_app_api is the one tool whose authority genuinely depends on its arguments: a GET only
  // reads, a DELETE destroys. Both axes therefore carry a predicate, and they must agree.
  describe('argument-dependent tools', () => {
    beforeEach(() => {
      const isRead = (p: Record<string, unknown>) => String(p.method ?? '').toUpperCase() === 'GET';
      registry.register({
        ...writeTool('proxy', { proxied: true }),
        isDestructive: (p) => !isRead(p),
        isReadOnly: isRead,
      });
    });

    it('lets a read-only key make the read call', async () => {
      await expect(registry.callTool('proxy', { method: 'GET' }, { capability: 'read' })).resolves.toEqual({ proxied: true });
    });

    it('refuses the mutating call to anything below full', async () => {
      await expect(registry.callTool('proxy', { method: 'DELETE' }, { capability: 'read' })).rejects.toThrow(DestructiveToolDisabledError);
      await expect(registry.callTool('proxy', { method: 'DELETE' }, { capability: 'write' })).rejects.toThrow(DestructiveToolDisabledError);
      await expect(registry.callTool('proxy', { method: 'DELETE' }, { capability: 'full' })).resolves.toEqual({ proxied: true });
    });

    it('treats a missing method as mutating, so a malformed call gets the strict reading', async () => {
      await expect(registry.callTool('proxy', {}, { capability: 'read' })).rejects.toThrow(DestructiveToolDisabledError);
    });
  });

  // tools/list shows a key only what it could run, so an agent never burns a turn on a tool that was
  // always going to be refused.
  describe('listToolsForCapability', () => {
    beforeEach(() => {
      registry.register(readTool('safe'));
      registry.register(writeTool('mutate'));
      registry.register({ ...writeTool('danger'), destructive: true });
      registry.register({ ...writeTool('proxy'), isDestructive: () => true, isReadOnly: (p) => p.method === 'GET' });
    });

    it('shows a read-only key read tools plus anything readable for some arguments', () => {
      const names = registry.listToolsForCapability('read').map((tool) => tool.name);
      // 'proxy' is listed despite being 'write' statically: some of its calls are reads, and the
      // per-call gate decides. Dropping it would take away the half of the tool that is safe.
      expect(names).toEqual(['safe', 'proxy']);
    });

    it('hides statically destructive tools from a write key, but keeps argument-dependent ones', () => {
      const names = registry.listToolsForCapability('write').map((tool) => tool.name);
      expect(names).toEqual(['safe', 'mutate', 'proxy']);
      expect(names).not.toContain('danger');
    });

    it('shows a full key everything', () => {
      expect(registry.listToolsForCapability('full')).toHaveLength(4);
    });
  });

  // MCP standard annotations, so a client can warn its user before it calls rather than discovering
  // the refusal afterwards.
  describe('toToolDescriptor annotations', () => {
    it('marks a read tool read-only and not destructive', () => {
      expect(toToolDescriptor(readTool('safe')).annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    });

    it('marks a write tool as neither read-only nor destructive', () => {
      expect(toToolDescriptor(writeTool('mutate')).annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    });

    it('marks a destructive tool destructive', () => {
      expect(toToolDescriptor({ ...writeTool('danger'), destructive: true }).annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });

    it('flags an argument-dependent tool by its worst case, since a hint cannot see the arguments', () => {
      const proxy = { ...writeTool('proxy'), isDestructive: () => true, isReadOnly: () => true };
      expect(toToolDescriptor(proxy).annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    });
  });
});
