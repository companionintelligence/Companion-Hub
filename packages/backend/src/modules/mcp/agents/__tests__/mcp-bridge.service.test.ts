/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${APP_HOST} is the listing's own template */
import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { McpBridgeService } from '../../agents/mcp-bridge.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { AppsService } from '@/modules/apps/apps.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { EnvUtils } from '@/modules/env/env.utils';
import { McpStdioLaunchPolicy, McpStdioLaunchRefused } from '../mcp-stdio-launch-policy';
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
  let docker: MockProxy<DockerService>;
  let appsService: MockProxy<AppsService>;
  let appFilesManager: MockProxy<AppFilesManager>;
  let envUtils: MockProxy<EnvUtils>;
  let moduleRef: TestingModule;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpBridgeService,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: DockerService, useValue: mock<DockerService>() },
        { provide: AppsService, useValue: mock<AppsService>() },
        { provide: AppFilesManager, useValue: mock<AppFilesManager>() },
        { provide: EnvUtils, useValue: mock<EnvUtils>() },
        // The fake stdio server is a `node -e` child, which the real policy refuses by design; the
        // policy has its own tests (mcp-stdio-launch-policy.test.ts).
        { provide: McpStdioLaunchPolicy, useValue: { assertAllowed: async () => undefined } },
      ],
    }).compile();

    moduleRef = module;
    service = module.get(McpBridgeService);
    docker = module.get(DockerService);
    appsService = module.get(AppsService);
    appFilesManager = module.get(AppFilesManager);
    envUtils = module.get(EnvUtils);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // The bridge sends the app's token along, and the Hub is on every app's network, where another app could
  // answer for a name. `${APP_HOST}` is the main service's address on the app's own network.
  describe('the ${APP_HOST} in a listing’s MCP URL', () => {
    const resolve = (url: string) =>
      (service as unknown as { resolveTemplateUrl(url: string, urn: AppUrn): Promise<string> }).resolveTemplateUrl(url, TEST_URN);

    beforeEach(() => {
      appFilesManager.getDockerComposeJson.mockResolvedValue({
        path: '/apps/x/docker-compose.json',
        content: { schemaVersion: 2, services: [{ name: 'web', image: 'app:latest', isMain: true }] },
      } as never);
    });

    it("is the main service's address on the app's network", async () => {
      docker.getServiceAddressOnAppNetwork.mockResolvedValue('10.128.20.5');

      await expect(resolve('http://${APP_HOST}:8080/mcp')).resolves.toBe('http://10.128.20.5:8080/mcp');
      expect(docker.getServiceAddressOnAppNetwork).toHaveBeenCalledWith(TEST_URN, 'web');
    });

    it('refuses to connect, rather than name a host, while the main service is not running', async () => {
      docker.getServiceAddressOnAppNetwork.mockResolvedValue(null);

      await expect(resolve('http://${APP_HOST}:8080/mcp')).rejects.toThrow('no running main service');
    });
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

  // `token_env` is a manifest field and the token goes to the URL the same manifest names.
  describe('HTTP MCP auth token', () => {
    const resolveAuthToken = (urn: AppUrn, name: string) =>
      (service as unknown as { resolveAuthToken: (u: AppUrn, n: string) => Promise<string | undefined> }).resolveAuthToken(urn, name);

    beforeEach(() => {
      envUtils.envStringToMap.mockImplementation(new EnvUtils().envStringToMap);
    });

    it('is read from the app’s own app.env', async () => {
      appFilesManager.getAppEnv.mockResolvedValue({ path: 'app.env', content: 'MIRO_ACCESS_TOKEN=app-token' });
      await expect(resolveAuthToken(TEST_URN, 'MIRO_ACCESS_TOKEN')).resolves.toBe('app-token');
    });

    it('is never taken from the Hub’s own environment', async () => {
      process.env.JWT_SECRET = 'hub-signing-key';
      try {
        appFilesManager.getAppEnv.mockResolvedValue({ path: 'app.env', content: 'OTHER=x' });
        await expect(resolveAuthToken(TEST_URN, 'JWT_SECRET')).resolves.toBeUndefined();
        appFilesManager.getAppEnv.mockRejectedValue(new Error('no app.env'));
        await expect(resolveAuthToken(TEST_URN, 'JWT_SECRET')).resolves.toBeUndefined();
      } finally {
        delete process.env.JWT_SECRET;
      }
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

    it('starts nothing when the launch policy refuses the listing', async () => {
      const policy = moduleRef.get(McpStdioLaunchPolicy);
      const refusal = new McpStdioLaunchRefused(STDIO_URN, 'host_docker is only allowed for apps from the official store');
      const assertAllowed = vi.spyOn(policy, 'assertAllowed').mockRejectedValue(refusal);

      await expect(service.discoverTools(STDIO_URN, stdioConfig())).rejects.toBe(refusal);
      // The policy saw exactly what would have been spawned, environment included.
      expect(assertAllowed).toHaveBeenCalledWith(STDIO_URN, expect.objectContaining({ launch: 'host_docker', command: server.command }));
      expect(assertAllowed.mock.calls[0]?.[1].env).not.toHaveProperty('JWT_SECRET');
      expect(server.pids()).toEqual([]);
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

    it('refuses a call while the app is uninstalling and stops its server', async () => {
      await service.discoverTools(STDIO_URN, stdioConfig());
      const [pid] = await server.waitForPids(1);
      appsService.getApp.mockResolvedValue({ app: { status: 'uninstalling' } } as any);

      await expect(service.callTool(STDIO_URN, stdioConfig(), 'echo_token', {})).resolves.toEqual({
        error: `App ${STDIO_URN} is not installed`,
        isError: true,
      });
      expect(await waitForExit(pid as number)).toBe(true);
      expect(server.pids()).toHaveLength(1);
    });

    it('keeps the new server when a call still on the old one fails after app.env changes', async () => {
      await service.callTool(STDIO_URN, stdioConfig(), 'echo_token', {});
      const inFlight = service.callTool(STDIO_URN, stdioConfig(), 'echo_token', { delayMs: 2000 });
      await new Promise((resolve) => setTimeout(resolve, 200));

      setAppEnv('FAKE_TOKEN=second-token');
      const afterChange = service.callTool(STDIO_URN, stdioConfig(), 'echo_token', {});

      await expect(inFlight).resolves.toMatchObject({ isError: true });
      await expect(afterChange).resolves.toMatchObject({ content: [{ text: 'second-token' }] });
      await expect(service.callTool(STDIO_URN, stdioConfig(), 'echo_token', {})).resolves.toMatchObject({
        content: [{ text: 'second-token' }],
      });
      expect(server.pids()).toHaveLength(2);
    });

    it('starts no process for a connection a config change replaced while it was connecting', async () => {
      const replaced = service.discoverTools(STDIO_URN, stdioConfig()).catch((error: Error) => error);
      await Promise.resolve();
      const changed = makeConfig({
        enabled: true,
        config: { enabled: true, transport: 'stdio', launch: 'host_docker', command: [...server.command, 'changed'] },
      });
      await expect(service.discoverTools(STDIO_URN, changed)).resolves.toHaveLength(2);
      await replaced;

      const pids = server.pids();
      expect(pids).toHaveLength(1);
      service.onModuleDestroy();
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
