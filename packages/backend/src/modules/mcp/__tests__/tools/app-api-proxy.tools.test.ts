import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { LifecycleActorFor } from '@/core/portal/lifecycle-actor';
import { GRANTED_ACTOR, OTHER_APP, asKey } from '@/tests/utils/lifecycle-actor-gate';
import { AppApiProxyTools } from '../../tools/app-api-proxy.tools';
import { mcpAdminCallContext } from '../../mcp-call-context';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { AgentConfigService } from '../../agents/agent-config.service';
import { ApiProxyService } from '../../agents/api-proxy.service';
import { AppsService } from '@/modules/apps/apps.service';

/** A key nobody is recorded as creating: the plainest caller the proxy tool acts for. */
const asAgent = <T>(call: () => Promise<T>) => asKey({ ownerAppUrn: null, createdByUserId: null }, call);

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

      const result = await asAgent(() =>
        tools.callAppApi({
          appUrn: 'ci-store:test',
          method: 'GET',
          path: '/api/status',
        }),
      );

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

      await asAgent(() =>
        tools.callAppApi({
          appUrn: 'ci-store:test',
          method: 'GET',
          path: '/api/test',
        }),
      );

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

      const result = await asAgent(() =>
        tools.callAppApi({
          appUrn: 'ci-store:test',
          method: 'GET',
          path: '/api/test',
        }),
      );

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

      await asAgent(() =>
        tools.callAppApi({
          appUrn: 'ci-store:test',
          method: 'POST',
          path: '/api/data',
          body: { key: 'value' },
          headers: { 'X-Custom': 'header' },
          queryParams: { page: '1' },
        }),
      );

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

  /*
   * The proxy asks the lifecycle's actor gate with the actor the tool hands it (CI-Hub#1397). What is
   * pinned here is that the tool names the caller in flight, for the verb the request's method takes.
   */
  describe('the actor handed to the proxy', () => {
    beforeEach(() => {
      appsService.getApp.mockResolvedValue({ info: { urn: 'ci-store:test' } } as any);
      agentConfigService.getAgentConfig.mockResolvedValue(null);
      apiProxy.proxyRequest.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    });

    it('hands over the calling key — a managed one with its owning app, so the gate can keep it off this one', async () => {
      await asKey({ ownerAppUrn: OTHER_APP, createdByUserId: null }, () =>
        tools.callAppApi({ appUrn: 'ci-store:test', method: 'GET', path: '/api' }),
      );

      expect(apiProxy.proxyRequest).toHaveBeenCalledWith(
        'ci-store:test',
        expect.objectContaining({ actor: { kind: 'mcp', ownerAppUrn: OTHER_APP, createdByUserId: null } }),
      );
    });

    it.each([
      ['GET', 'view'],
      ['POST', 'configure'],
      ['PUT', 'configure'],
      ['PATCH', 'configure'],
      ['DELETE', 'configure'],
    ])('names the admin-runner person for a %s as the %s grant', async (method, action) => {
      const actorFor = vi.fn<LifecycleActorFor>(() => GRANTED_ACTOR);

      await mcpAdminCallContext.run(actorFor, () => tools.callAppApi({ appUrn: 'ci-store:test', method, path: '/api' }));

      expect(actorFor).toHaveBeenCalledWith(action);
      expect(apiProxy.proxyRequest).toHaveBeenCalledWith('ci-store:test', expect.objectContaining({ method, actor: GRANTED_ACTOR }));
    });

    it('refuses a call that names no caller before the app is read or the request is made', async () => {
      await expect(tools.callAppApi({ appUrn: 'ci-store:test', method: 'DELETE', path: '/api/users/1' })).rejects.toThrow('APP_ACTION_GRANT_DENIED');

      expect(appsService.getApp).not.toHaveBeenCalled();
      expect(apiProxy.proxyRequest).not.toHaveBeenCalled();
    });
  });
});
