import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { McpService } from '../mcp.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsService } from '@/modules/apps/apps.service';
import { AgentConfigService } from '../agents/agent-config.service';
import { McpBridgeService } from '../agents/mcp-bridge.service';

describe('McpService', () => {
  let service: McpService;
  let toolRegistry: McpToolRegistry;
  let appsService: MockProxy<AppsService>;
  let agentConfigService: MockProxy<AgentConfigService>;
  let mcpBridgeService: MockProxy<McpBridgeService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpService,
        McpToolRegistry,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: AppsService, useValue: mock<AppsService>() },
        { provide: AgentConfigService, useValue: mock<AgentConfigService>() },
        { provide: McpBridgeService, useValue: mock<McpBridgeService>() },
      ],
    }).compile();

    service = module.get<McpService>(McpService);
    toolRegistry = module.get(McpToolRegistry);
    appsService = module.get(AppsService);
    agentConfigService = module.get(AgentConfigService);
    mcpBridgeService = module.get(McpBridgeService);
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

  describe('getRegistry', () => {
    it('should return only installed apps with MCP enabled', async () => {
      appsService.getInstalledApps.mockResolvedValue([
        { app: { status: 'running' }, info: { urn: 'nextcloud:ci-store', name: 'Nextcloud' } },
        { app: { status: 'stopped' }, info: { urn: 'vaultwarden:ci-store', name: 'Vaultwarden' } },
        { app: { status: 'running' }, info: { urn: 'paperless:ci-store', name: 'Paperless' } },
      ] as any);

      agentConfigService.getAgentConfig
        .mockResolvedValueOnce({
          skill: { enabled: false, content: null, inline: false },
          openapi: { enabled: false, specPath: null, config: null },
          mcp: { enabled: true, config: { enabled: true, transport: 'sse', url: 'http://nextcloud:80/mcp' } },
        } as any)
        .mockResolvedValueOnce({
          skill: { enabled: false, content: null, inline: false },
          openapi: { enabled: false, specPath: null, config: null },
          mcp: { enabled: true, config: { enabled: true, transport: 'stdio' } },
        } as any)
        .mockResolvedValueOnce(null);

      mcpBridgeService.listRemoteTools.mockResolvedValue([{ name: 'list_files', description: 'List files', inputSchema: {} }]);

      const result = await service.getRegistry();

      expect(result).toEqual({
        servers: [
          {
            appUrn: 'nextcloud:ci-store',
            name: 'Nextcloud',
            transport: 'sse',
            url: 'http://nextcloud:80/mcp',
            tools: ['list_files'],
            status: 'running',
          },
          {
            appUrn: 'vaultwarden:ci-store',
            name: 'Vaultwarden',
            transport: 'stdio',
            url: null,
            tools: [],
            status: 'stopped',
          },
        ],
      });
      expect(mcpBridgeService.listRemoteTools).toHaveBeenCalledTimes(1);
    });

    it('should mark a running app as error when MCP discovery fails', async () => {
      appsService.getInstalledApps.mockResolvedValue([
        { app: { status: 'running' }, info: { urn: 'home-assistant:ci-store', name: 'Home Assistant' } },
      ] as any);
      agentConfigService.getAgentConfig.mockResolvedValue({
        skill: { enabled: false, content: null, inline: false },
        openapi: { enabled: false, specPath: null, config: null },
        mcp: { enabled: true, config: { enabled: true, transport: 'sse', url: 'http://home-assistant:8123/mcp' } },
      } as any);
      mcpBridgeService.listRemoteTools.mockRejectedValue(new Error('connection refused'));

      const result = await service.getRegistry();

      expect(result).toEqual({
        servers: [
          {
            appUrn: 'home-assistant:ci-store',
            name: 'Home Assistant',
            transport: 'sse',
            url: 'http://home-assistant:8123/mcp',
            tools: [],
            status: 'error',
          },
        ],
      });
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

  describe('JSON-RPC validation', () => {
    it('should reject requests without jsonrpc 2.0 field', async () => {
      const res = await service.handleMessage({ jsonrpc: '1.0' as any, id: 6, method: 'initialize' });
      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(-32600);
    });
  });
});
