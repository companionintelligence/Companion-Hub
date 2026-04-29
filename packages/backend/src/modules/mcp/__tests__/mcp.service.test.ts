import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { McpService } from '../mcp.service';
import { McpToolRegistry } from '../mcp-tool-registry.service';

describe('McpService', () => {
  let service: McpService;
  let toolRegistry: MockProxy<McpToolRegistry>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [McpService, { provide: McpToolRegistry, useValue: mock<McpToolRegistry>() }],
    }).compile();

    service = module.get<McpService>(McpService);
    toolRegistry = module.get(McpToolRegistry);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // S-MCP-1.2: initialize request returns serverInfo.name = "ci-hub" and capabilities.tools = {}
  describe('initialize', () => {
    it.todo('should return serverInfo with name "ci-hub"');
    it.todo('should return capabilities with tools object');
  });

  // S-MCP-1.3: tools/list returns all registered tool definitions
  describe('tools/list', () => {
    it.todo('should return all registered tool definitions');
    it.todo('should return empty array when no tools registered');
  });

  // S-MCP-1.4: tools/call invokes corresponding service method and returns result
  describe('tools/call', () => {
    it.todo('should dispatch to the correct tool handler');
    it.todo('should return the tool handler result');
  });

  // S-MCP-1.6: tools/call for unknown tool returns JSON-RPC error -32602
  describe('tools/call — unknown tool', () => {
    it.todo('should return JSON-RPC error with code -32602 for unknown tool name');
  });

  // S-MCP-1.7: concurrent SSE connections
  describe('concurrent connections', () => {
    it.todo('should support at least 4 simultaneous SSE clients');
  });
});
