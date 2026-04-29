import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { McpToolNotFoundError, McpToolRegistry } from '../mcp-tool-registry.service';
import { McpService } from '../mcp.service';

describe('McpService', () => {
  let service: McpService;
  let toolRegistry: McpToolRegistry;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [McpService, McpToolRegistry],
    }).compile();

    service = module.get<McpService>(McpService);
    toolRegistry = module.get(McpToolRegistry);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('initialize', () => {
    it('should return serverInfo with name "ci-hub"', async () => {
      const res = await service.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
      expect((res.result as any).serverInfo.name).toBe('ci-hub');
    });

    it('should return capabilities with tools object', async () => {
      const res = await service.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
      expect((res.result as any).capabilities.tools).toEqual({});
    });
  });

  describe('tools/list', () => {
    it('should return all registered tool definitions', async () => {
      toolRegistry.register({ name: 'test_tool', description: 'A test', inputSchema: { type: 'object' }, handler: async () => ({}) });
      const res = await service.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const tools = (res.result as any).tools;
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('test_tool');
    });

    it('should return empty array when no tools registered', async () => {
      const res = await service.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect((res.result as any).tools).toEqual([]);
    });
  });

  describe('tools/call', () => {
    it('should dispatch to the correct tool handler', async () => {
      let called = false;
      toolRegistry.register({
        name: 'my_tool',
        description: '',
        inputSchema: {},
        handler: async () => {
          called = true;
          return { ok: true };
        },
      });
      await service.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'my_tool', arguments: {} } });
      expect(called).toBe(true);
    });

    it('should return the tool handler result', async () => {
      toolRegistry.register({ name: 'ret_tool', description: '', inputSchema: {}, handler: async () => ({ value: 42 }) });
      const res = await service.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ret_tool', arguments: {} } });
      expect(res.result).toBeDefined();
      expect(res.error).toBeUndefined();
    });
  });

  describe('tools/call — unknown tool', () => {
    it('should return JSON-RPC error with code -32602 for unknown tool name', async () => {
      const res = await service.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nonexistent', arguments: {} } });
      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(-32602);
    });
  });

  describe('unknown method', () => {
    it('should return JSON-RPC error -32601 for unknown methods', async () => {
      const res = await service.handleMessage({ jsonrpc: '2.0', id: 5, method: 'unknown/method' });
      expect(res.error?.code).toBe(-32601);
    });
  });
});
