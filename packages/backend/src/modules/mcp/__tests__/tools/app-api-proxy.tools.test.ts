import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AppApiProxyTools } from '../../tools/app-api-proxy.tools';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { AgentConfigService } from '../../agents/agent-config.service';
import { ApiProxyService } from '../../agents/api-proxy.service';
import { AppsService } from '@/modules/apps/apps.service';

describe('AppApiProxyTools', () => {
  let tools: AppApiProxyTools;
  let registry: MockProxy<McpToolRegistry>;
  let appsService: MockProxy<AppsService>;
  let agentConfigService: MockProxy<AgentConfigService>;
  let apiProxy: MockProxy<ApiProxyService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppApiProxyTools,
        { provide: AppsService, useValue: mock<AppsService>() },
        { provide: McpToolRegistry, useValue: mock<McpToolRegistry>() },
        { provide: AgentConfigService, useValue: mock<AgentConfigService>() },
        { provide: ApiProxyService, useValue: mock<ApiProxyService>() },
      ],
    }).compile();

    tools = module.get(AppApiProxyTools);
    registry = module.get(McpToolRegistry);
    appsService = module.get(AppsService);
    agentConfigService = module.get(AgentConfigService);
    apiProxy = module.get(ApiProxyService);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('tool registration', () => {
    it('should register hub_call_app_api tool', () => {
      tools.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'hub_call_app_api' }));
    });
  });

  describe('S-APX-1.1: makes HTTP request to app container', () => {
    it('should proxy request through ApiProxyService', async () => {
      appsService.getApp.mockResolvedValue({ info: { urn: 'ci-store:test' } } as any);
      agentConfigService.getAgentConfig.mockResolvedValue({
        openapi: { config: { auth: { type: 'bearer', token_env: 'TOKEN' } } },
      } as any);
      apiProxy.proxyRequest.mockResolvedValue({
        content: [{ type: 'text', text: '{"status":"ok"}' }],
      });

      const result = await tools.callAppApi({
        appUrn: 'ci-store:test',
        method: 'GET',
        path: '/api/status',
      });

      expect(apiProxy.proxyRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          method: 'GET',
          path: '/api/status',
        }),
      );
      expect(result.content[0]?.text).toContain('ok');
    });
  });

  describe('S-APX-1.2: injects auth from OpenAPI config', () => {
    it('should pass auth config to proxy service', async () => {
      const authConfig = { type: 'bearer' as const, token_env: 'APP_TOKEN' };
      appsService.getApp.mockResolvedValue({ info: { urn: 'ci-store:test' } } as any);
      agentConfigService.getAgentConfig.mockResolvedValue({
        openapi: { config: { auth: authConfig } },
      } as any);
      apiProxy.proxyRequest.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });

      await tools.callAppApi({
        appUrn: 'ci-store:test',
        method: 'GET',
        path: '/api/test',
      });

      expect(apiProxy.proxyRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          auth: authConfig,
        }),
      );
    });
  });

  describe('S-APX-1.3: works without agent config', () => {
    it('should still proxy when agent config lookup fails', async () => {
      appsService.getApp.mockRejectedValue(new Error('Not found'));
      apiProxy.proxyRequest.mockResolvedValue({
        content: [{ type: 'text', text: 'response' }],
      });

      const result = await tools.callAppApi({
        appUrn: 'ci-store:test',
        method: 'GET',
        path: '/api/test',
      });

      expect(apiProxy.proxyRequest).toHaveBeenCalled();
      expect(result.content[0]?.text).toBe('response');
    });
  });

  describe('passes through all parameters', () => {
    it('should forward body, headers, and queryParams', async () => {
      appsService.getApp.mockRejectedValue(new Error('Not found'));
      apiProxy.proxyRequest.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });

      await tools.callAppApi({
        appUrn: 'ci-store:test',
        method: 'POST',
        path: '/api/data',
        body: { key: 'value' },
        headers: { 'X-Custom': 'header' },
        queryParams: { page: '1' },
      });

      expect(apiProxy.proxyRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          method: 'POST',
          path: '/api/data',
          body: { key: 'value' },
          headers: { 'X-Custom': 'header' },
          queryParams: { page: '1' },
        }),
      );
    });
  });
});
