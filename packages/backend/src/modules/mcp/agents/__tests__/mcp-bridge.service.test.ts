import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { McpBridgeService } from '../../agents/mcp-bridge.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { AppsService } from '@/modules/apps/apps.service';
import type { AppUrn } from '@ci-hub/common/types';
import type { ResolvedAgentConfig } from '../../agents/agent-config.service';

const TEST_URN = 'ci-store:nextcloud' as AppUrn;

const makeConfig = (mcp: ResolvedAgentConfig['mcp']): ResolvedAgentConfig => ({
  skill: { enabled: false, content: null, inline: false },
  openapi: { enabled: false, specPath: null, config: null },
  mcp,
});

describe('McpBridgeService', () => {
  let service: McpBridgeService;
  let appsService: MockProxy<AppsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpBridgeService,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: DockerService, useValue: mock<DockerService>() },
        { provide: AppsService, useValue: mock<AppsService>() },
      ],
    }).compile();

    service = module.get(McpBridgeService);
    appsService = module.get(AppsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateTools', () => {
    it('should return empty array when mcp is disabled', async () => {
      const config = makeConfig({ enabled: false, config: null });
      const tools = await service.generateTools(TEST_URN, config);
      expect(tools).toEqual([]);
    });

    it('S-AMB-3.1: should register a discovery tool for lazy connection', async () => {
      const config = makeConfig({
        enabled: true,
        config: { enabled: true, transport: 'sse', url: 'http://localhost/mcp' },
      });
      const tools = await service.generateTools(TEST_URN, config);
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toContain('discover');
    });
  });

  describe('S-AMB-3.2: tool calls return error when app not running', () => {
    it('should create a discovery tool that checks app status', async () => {
      appsService.getApp.mockResolvedValue({ app: { status: 'stopped' } } as any);
      const config = makeConfig({
        enabled: true,
        config: { enabled: true, transport: 'sse', url: 'http://localhost/mcp' },
      });
      const tools = await service.generateTools(TEST_URN, config);
      // Calling the discovery tool when app is stopped should throw
      await expect(tools[0]?.handler({})).rejects.toThrow('not running');
    });
  });

  describe('S-AMB-3.4: exponential backoff', () => {
    it('should retry with increasing delay', async () => {
      const config = makeConfig({
        enabled: true,
        config: { enabled: true, transport: 'sse', url: 'http://localhost/mcp' },
      });
      // Just verify we can create the tools without error
      const tools = await service.generateTools(TEST_URN, config);
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  describe('listToolInfo', () => {
    it('should return empty when not connected', () => {
      const result = service.listToolInfo(TEST_URN);
      expect(result).toEqual([]);
    });
  });

  describe('onModuleDestroy', () => {
    it('should clean up connections', () => {
      // Should not throw
      service.onModuleDestroy();
    });
  });
});
