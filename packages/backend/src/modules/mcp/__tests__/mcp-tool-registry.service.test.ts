import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { DestructiveToolDisabledError, McpToolNotFoundError, McpToolRegistry } from '../mcp-tool-registry.service';

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
      registry.register({ name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' }, handler: async () => ({}) });
      expect(registry.hasTool('test_tool')).toBe(true);
    });

    it('should reject duplicate tool names', () => {
      const tool = { name: 'dup_tool', description: 'dup', inputSchema: {}, handler: async () => ({}) };
      registry.register(tool);
      expect(() => registry.register(tool)).toThrow("Tool 'dup_tool' is already registered");
    });
  });

  describe('tool listing', () => {
    it('should return all registered tools with their JSON schemas', () => {
      registry.register({ name: 'tool_a', description: 'A', inputSchema: { type: 'object' }, handler: async () => ({}) });
      registry.register({ name: 'tool_b', description: 'B', inputSchema: { type: 'string' }, handler: async () => ({}) });
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
      const handler = async () => ({ result: 'ok' });
      registry.register({ name: 'my_tool', description: '', inputSchema: {}, handler });
      const result = await registry.callTool('my_tool', {});
      expect(result).toEqual({ result: 'ok' });
    });

    it('should throw McpToolNotFoundError for an unregistered tool name', async () => {
      await expect(registry.callTool('nonexistent', {})).rejects.toThrow(McpToolNotFoundError);
    });

    it('should pass parameters to the tool handler', async () => {
      let receivedParams: Record<string, unknown> = {};
      registry.register({
        name: 'param_tool',
        description: '',
        inputSchema: {},
        handler: async (params) => {
          receivedParams = params;
          return {};
        },
      });
      await registry.callTool('param_tool', { foo: 'bar' });
      expect(receivedParams).toEqual({ foo: 'bar' });
    });

    it('should return the handler result', async () => {
      registry.register({ name: 'ret_tool', description: '', inputSchema: {}, handler: async () => ({ value: 42 }) });
      const result = await registry.callTool('ret_tool', {});
      expect(result).toEqual({ value: 42 });
    });
  });

  // ISSUE-MCP-2: destructive tools are gated behind MCP_ALLOW_DESTRUCTIVE (env) or an explicit
  // per-call override (the admin runner after operator confirmation).
  describe('destructive tool gating', () => {
    const registerDestructive = () =>
      registry.register({ name: 'danger', destructive: true, description: '', inputSchema: {}, handler: async () => ({ wiped: true }) });

    beforeEach(() => {
      delete process.env.MCP_ALLOW_DESTRUCTIVE;
    });

    it('blocks a destructive tool by default', async () => {
      registerDestructive();
      await expect(registry.callTool('danger', {})).rejects.toThrow(DestructiveToolDisabledError);
    });

    it('allows a destructive tool when MCP_ALLOW_DESTRUCTIVE=true', async () => {
      registerDestructive();
      process.env.MCP_ALLOW_DESTRUCTIVE = 'true';
      await expect(registry.callTool('danger', {})).resolves.toEqual({ wiped: true });
    });

    it('allows a destructive tool with an explicit allowDestructive override', async () => {
      registerDestructive();
      await expect(registry.callTool('danger', {}, { allowDestructive: true })).resolves.toEqual({ wiped: true });
    });

    it('does not gate non-destructive tools', async () => {
      registry.register({ name: 'safe', description: '', inputSchema: {}, handler: async () => ({ ok: true }) });
      await expect(registry.callTool('safe', {})).resolves.toEqual({ ok: true });
    });
  });
});
