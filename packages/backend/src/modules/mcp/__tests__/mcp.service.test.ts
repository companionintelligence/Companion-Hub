import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { McpService } from '../mcp.service';
import { AgentNotifyService } from '../../agent-notify/agent-notify.service';
import { LoggerService } from '@/core/logger/logger.service';

// BUG-MCP-1: JSON-RPC protocol handling moved to the SDK (see mcp-server.factory.test.ts for the
// end-to-end protocol coverage). McpService is now just identity + capabilities + a bootstrap log.
describe('McpService', () => {
  let service: McpService;
  let agentNotify: AgentNotifyService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpService,
        McpToolRegistry,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: AgentNotifyService, useValue: mock<AgentNotifyService>() },
      ],
    }).compile();

    service = module.get<McpService>(McpService);
    agentNotify = module.get(AgentNotifyService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('advertises server info with name "ci-hub"', () => {
    expect(service.getServerInfo().name).toBe('ci-hub');
    expect(service.getServerInfo().version).toBeTruthy();
  });

  it('advertises a tools capability', () => {
    expect(service.getCapabilities()).toHaveProperty('tools');
  });

  it('notifies agent-notify that MCP is ready at bootstrap', () => {
    service.onApplicationBootstrap();
    expect(agentNotify.notify).toHaveBeenCalledWith('system.mcp_ready', expect.objectContaining({ toolCount: expect.any(Number) }), 'info');
  });

  it('does not throw at bootstrap when agent-notify is absent', () => {
    const registry = new McpToolRegistry();
    const standalone = new McpService(registry, mock<LoggerService>(), undefined);
    expect(() => standalone.onApplicationBootstrap()).not.toThrow();
    vi.clearAllMocks();
  });
});
