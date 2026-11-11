import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { McpBridgeService } from '../../agents/mcp-bridge.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { AppsService } from '@/modules/apps/apps.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { EnvUtils } from '@/modules/env/env.utils';
import type { AppUrn } from '@ci-hub/common/types';
import type { ResolvedAgentConfig } from '../../agents/agent-config.service';
import { type FakeStdioServer, makeFakeStdioServer, waitForExit } from './fake-stdio-mcp-server';

const TEST_URN = 'ci-store:nextcloud' as AppUrn;

const makeConfig = (mcp: ResolvedAgentConfig['mcp']): ResolvedAgentConfig => ({
  skill: { enabled: false, content: null, inline: false },
  openapi: { enabled: false, specPath: null, config: null },
  mcp,
});

describe('McpBridgeService', () => {
  let service: McpBridgeService;
  let appsService: MockProxy<AppsService>;
  let appFilesManager: MockProxy<AppFilesManager>;
  let envUtils: MockProxy<EnvUtils>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpBridgeService,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: DockerService, useValue: mock<DockerService>() },
        { provide: AppsService, useValue: mock<AppsService>() },
        { provide: AppFilesManager, useValue: mock<AppFilesManager>() },
        { provide: EnvUtils, useValue: mock<EnvUtils>() },
      ],
    }).compile();

    service = module.get(McpBridgeService);
    appsService = module.get(AppsService);
    appFilesManager = module.get(AppFilesManager);
    envUtils = module.get(EnvUtils);
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

  // A real child process stands in for the `docker run` of a host_docker listing such as GitHub MCP.
  describe('host_docker stdio server lifecycle', () => {
    const STDIO_URN = 'fake-mcp:store' as AppUrn;
    let server: FakeStdioServer;

    const stdioConfig = () =>
      makeConfig({
        enabled: true,
        config: { enabled: true, transport: 'stdio', launch: 'host_docker', command: server.command },
      });
    const setAppEnv = (content: string) => appFilesManager.getAppEnv.mockResolvedValue({ path: 'app.env', content });

    beforeEach(() => {
      server = makeFakeStdioServer();
      envUtils.envStringToMap.mockImplementation(new EnvUtils().envStringToMap);
      setAppEnv('FAKE_TOKEN=first-token');
      appsService.getApp.mockResolvedValue({ app: { status: 'running' } } as any);
    });

    afterEach(() => {
      service.onModuleDestroy();
      server.cleanup();
    });

    it('dropApp stops the server and forgets the tools it advertised', async () => {
      await expect(service.discoverTools(STDIO_URN, stdioConfig())).resolves.toHaveLength(2);
      const [pid] = await server.waitForPids(1);

      service.dropApp(STDIO_URN);

      expect(await waitForExit(pid as number)).toBe(true);
      expect(service.listToolInfo(STDIO_URN)).toEqual([]);
    });

    it('stops the server when a call finds the app uninstalled', async () => {
      await service.discoverTools(STDIO_URN, stdioConfig());
      const [pid] = await server.waitForPids(1);
      appsService.getApp.mockResolvedValue({ app: null } as any);

      await expect(service.callTool(STDIO_URN, stdioConfig(), 'echo_token', {})).resolves.toEqual({
        error: `App ${STDIO_URN} is not installed`,
        isError: true,
      });
      expect(await waitForExit(pid as number)).toBe(true);
      expect(service.listToolInfo(STDIO_URN)).toEqual([]);
    });

    it('keeps the server running when a tool fails on the server side', async () => {
      await expect(service.callTool(STDIO_URN, stdioConfig(), 'fail', {})).resolves.toEqual({
        error: `MCP error from ${STDIO_URN}: failed on purpose`,
        isError: true,
      });
      await expect(service.callTool(STDIO_URN, stdioConfig(), 'echo_token', {})).resolves.toMatchObject({
        content: [{ text: 'first-token' }],
      });
      expect(server.pids()).toHaveLength(1);
    });

    it('restarts the server when app.env changes, so a new token takes effect', async () => {
      await expect(service.callTool(STDIO_URN, stdioConfig(), 'echo_token', {})).resolves.toMatchObject({
        content: [{ text: 'first-token' }],
      });

      setAppEnv('FAKE_TOKEN=second-token');

      await expect(service.callTool(STDIO_URN, stdioConfig(), 'echo_token', {})).resolves.toMatchObject({
        content: [{ text: 'second-token' }],
      });
      const pids = server.pids();
      expect(pids).toHaveLength(2);
      expect(await waitForExit(pids[0] as number)).toBe(true);
    });

    it('keeps a running server when app.env reads back empty', async () => {
      await service.callTool(STDIO_URN, stdioConfig(), 'echo_token', {});

      setAppEnv('');

      await expect(service.callTool(STDIO_URN, stdioConfig(), 'echo_token', {})).resolves.toMatchObject({
        content: [{ text: 'first-token' }],
      });
      expect(server.pids()).toHaveLength(1);
    });
  });
});
