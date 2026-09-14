import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { HubAction } from '@/core/portal/hub-actions';
import type { ActorCheckContext } from '@/core/portal/lifecycle-actor';
import {
  GRANTED_ACTOR,
  UNGRANTED_CALLERS,
  asGrantedOperator,
  asManagedKeyOnOtherApp,
  gateChecks,
  lifecycleActorGate,
} from '@/tests/utils/lifecycle-actor-gate';
import { AppAgentTools } from '../../tools/app-agent.tools';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { AgentConfigService } from '../../agents/agent-config.service';
import { SkillResolverService } from '../../agents/skill-resolver.service';
import { OpenApiBridgeService } from '../../agents/openapi-bridge.service';
import { McpBridgeService } from '../../agents/mcp-bridge.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppsService } from '@/modules/apps/apps.service';

describe('AppAgentTools', () => {
  let tools: AppAgentTools;
  let registry: MockProxy<McpToolRegistry>;
  let appsService: MockProxy<AppsService>;
  let agentConfigService: MockProxy<AgentConfigService>;
  let skillResolver: MockProxy<SkillResolverService>;
  let openapiBridge: MockProxy<OpenApiBridgeService>;
  let mcpBridge: MockProxy<McpBridgeService>;
  let lifecycle: MockProxy<AppLifecycleService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppAgentTools,
        { provide: AppsService, useValue: mock<AppsService>() },
        { provide: McpToolRegistry, useValue: mock<McpToolRegistry>() },
        { provide: AgentConfigService, useValue: mock<AgentConfigService>() },
        { provide: SkillResolverService, useValue: mock<SkillResolverService>() },
        { provide: OpenApiBridgeService, useValue: mock<OpenApiBridgeService>() },
        { provide: McpBridgeService, useValue: mock<McpBridgeService>() },
        { provide: AppLifecycleService, useValue: mock<AppLifecycleService>() },
      ],
    }).compile();

    tools = module.get(AppAgentTools);
    registry = module.get(McpToolRegistry);
    appsService = module.get(AppsService);
    agentConfigService = module.get(AgentConfigService);
    skillResolver = module.get(SkillResolverService);
    openapiBridge = module.get(OpenApiBridgeService);
    mcpBridge = module.get(McpBridgeService);
    lifecycle = module.get(AppLifecycleService);
    // The real actor decision, which every per-app tool here asks before it touches the app.
    lifecycle.assertActorMay.mockImplementation(lifecycleActorGate());
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('tool registration', () => {
    it('should register hub_get_app_skill tool', () => {
      tools.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'hub_get_app_skill' }));
    });

    it('should register hub_list_agent_apps tool', () => {
      tools.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'hub_list_agent_apps' }));
    });

    it('should register hub_list_app_tools tool', () => {
      tools.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'hub_list_app_tools' }));
    });

    it('should register hub_get_app_openapi tool', () => {
      tools.onModuleInit();
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'hub_get_app_openapi' }));
    });
  });

  describe('S-ASK-1: hub_get_app_skill', () => {
    it('should return skill content for an app', async () => {
      appsService.getApp.mockResolvedValue({ info: { urn: 'ci-store:test' } } as any);
      agentConfigService.getAgentConfig.mockResolvedValue({
        skill: { enabled: true, content: null, inline: false },
        openapi: { enabled: false, specPath: null, config: null },
        mcp: { enabled: false, config: null },
      });
      skillResolver.getSkillContent.mockResolvedValue({ content: '# Test App', available: true });

      const result = await asGrantedOperator(() => tools.getAppSkill({ appUrn: 'ci-store:test' }));
      expect(result.available).toBe(true);
      expect(result.content).toBe('# Test App');
    });

    it('should return available=false when no skill', async () => {
      appsService.getApp.mockResolvedValue({ info: { urn: 'ci-store:test' } } as any);
      agentConfigService.getAgentConfig.mockResolvedValue(null);
      skillResolver.getSkillContent.mockResolvedValue({ content: '', available: false });

      const result = await asGrantedOperator(() => tools.getAppSkill({ appUrn: 'ci-store:test' }));
      expect(result.available).toBe(false);
    });
  });

  describe('S-ASK-2: hub_list_agent_apps', () => {
    it('should return only apps with agent integration', async () => {
      appsService.getInstalledApps.mockResolvedValue([
        { info: { urn: 'ci-store:app1', name: 'App 1' } },
        { info: { urn: 'ci-store:app2', name: 'App 2' } },
        { info: { urn: 'ci-store:app3', name: 'App 3' } },
      ] as any);

      agentConfigService.getAgentSummary
        .mockResolvedValueOnce({ hasSkill: true, hasOpenApi: false, hasMcp: false })
        .mockResolvedValueOnce(null) // app2 has no agent config
        .mockResolvedValueOnce({ hasSkill: true, hasOpenApi: true, hasMcp: false });

      const result = await tools.listAgentApps();
      expect(result.apps).toHaveLength(2);
      expect(result.apps[0]?.appUrn).toBe('ci-store:app1');
      expect(result.apps[1]?.appUrn).toBe('ci-store:app3');
    });

    it('should return empty when no apps have agent config', async () => {
      appsService.getInstalledApps.mockResolvedValue([]);
      const result = await tools.listAgentApps();
      expect(result.apps).toEqual([]);
    });
  });

  describe('S-AOA-5: hub_list_app_tools', () => {
    it('should return combined openapi and mcp tools', async () => {
      appsService.getApp.mockResolvedValue({ info: { urn: 'ci-store:test' } } as any);
      agentConfigService.getAgentConfig.mockResolvedValue({
        skill: { enabled: false, content: null, inline: false },
        openapi: { enabled: true, specPath: '/spec', config: {} },
        mcp: { enabled: true, config: {} },
      } as any);

      openapiBridge.listToolInfo.mockResolvedValue([
        { name: 'ci-store_test__listUsers', description: 'List users', source: 'openapi', method: 'get', path: '/api/users' },
      ]);
      mcpBridge.discoverTools.mockResolvedValue([{ name: 'ci-store_test__custom_tool', description: 'Custom tool', source: 'mcp' }]);

      const result = await asGrantedOperator(() => tools.listAppTools({ appUrn: 'ci-store:test' }));
      expect(result.tools).toHaveLength(2);
      expect(result.tools[0]?.source).toBe('openapi');
      expect(result.tools[1]?.source).toBe('mcp');
    });

    it('falls back to cached tool info when discovery fails', async () => {
      appsService.getApp.mockResolvedValue({ info: { urn: 'ci-store:test' } } as any);
      agentConfigService.getAgentConfig.mockResolvedValue({
        skill: { enabled: false, content: null, inline: false },
        openapi: { enabled: false, specPath: null, config: null },
        mcp: { enabled: true, config: {} },
      } as any);

      openapiBridge.listToolInfo.mockResolvedValue([]);
      mcpBridge.discoverTools.mockRejectedValue(new Error('app not running'));
      mcpBridge.listToolInfo.mockReturnValue([{ name: 'ci-store_test__cached', description: 'Cached', source: 'mcp' }]);

      const result = await asGrantedOperator(() => tools.listAppTools({ appUrn: 'ci-store:test' }));
      expect(result.tools).toEqual([{ name: 'ci-store_test__cached', description: 'Cached', source: 'mcp' }]);
    });

    it('should return empty when no agent config', async () => {
      appsService.getApp.mockResolvedValue({ info: { urn: 'ci-store:test' } } as any);
      agentConfigService.getAgentConfig.mockResolvedValue(null);

      const result = await asGrantedOperator(() => tools.listAppTools({ appUrn: 'ci-store:test' }));
      expect(result.tools).toEqual([]);
    });
  });

  describe('S-AOA-4: hub_get_app_openapi', () => {
    it('should return raw OpenAPI spec', async () => {
      appsService.getApp.mockResolvedValue({ info: { urn: 'ci-store:test' } } as any);
      agentConfigService.getAgentConfig.mockResolvedValue({
        skill: { enabled: false, content: null, inline: false },
        openapi: { enabled: true, specPath: '/spec', config: {} },
        mcp: { enabled: false, config: null },
      } as any);
      openapiBridge.getRawSpec.mockResolvedValue({ spec: '{"openapi":"3.0.0"}', available: true });

      const result = await asGrantedOperator(() => tools.getAppOpenApi({ appUrn: 'ci-store:test' }));
      expect(result.available).toBe(true);
      expect(result.spec).toContain('3.0.0');
    });

    it('should return available=false when no spec', async () => {
      appsService.getApp.mockResolvedValue({ info: { urn: 'ci-store:test' } } as any);
      agentConfigService.getAgentConfig.mockResolvedValue(null);

      const result = await asGrantedOperator(() => tools.getAppOpenApi({ appUrn: 'ci-store:test' }));
      expect(result.available).toBe(false);
    });
  });

  /*
   * Each tool on one app starts by reading it through `AppsService`, which cannot ask the lifecycle's
   * actor gate, so the tool asks first (CI-Hub#1397): `view` to read about the app, `configure` to call
   * into it. A refused caller never reads the app, nor reaches its MCP server.
   */
  describe('the actor gate', () => {
    const appUrn = 'immich:ci-marketplace';

    /** Each tool, the grant a person needs for it, and the context its check is marked with. */
    const calls: Array<[string, HubAction, ActorCheckContext | undefined, () => Promise<unknown>]> = [
      ['hub_get_app_skill', 'view', undefined, () => tools.getAppSkill({ appUrn })],
      ['hub_list_app_tools', 'view', undefined, () => tools.listAppTools({ appUrn })],
      ['hub_call_app_tool', 'configure', { appCall: true }, () => tools.callAppTool({ appUrn, tool: 'delete_everything', arguments: {} })],
      ['hub_get_app_openapi', 'view', undefined, () => tools.getAppOpenApi({ appUrn })],
    ];

    beforeEach(() => {
      appsService.getApp.mockResolvedValue({ info: { urn: appUrn } } as any);
      agentConfigService.getAgentConfig.mockResolvedValue(null);
    });

    describe.each(calls)('%s', (_tool, action, context, call) => {
      it.each(UNGRANTED_CALLERS)('refuses %s before it reads the app', async (_label, as) => {
        await expect(as(call)).rejects.toThrow('APP_ACTION_GRANT_DENIED');

        expect(appsService.getApp).not.toHaveBeenCalled();
        expect(mcpBridge.callTool).not.toHaveBeenCalled();
        expect(mcpBridge.discoverTools).not.toHaveBeenCalled();
      });

      // Reading about an app and calling its tools both operate it, which a managed app key may do on any app.
      it("reads the app for a managed app's key on another app", async () => {
        await asManagedKeyOnOtherApp(call);

        expect(appsService.getApp).toHaveBeenCalledWith(appUrn);
      });

      it(`reads the app for a person holding ${action}`, async () => {
        await asGrantedOperator(call);

        expect(gateChecks(lifecycle.assertActorMay)).toEqual([[GRANTED_ACTOR, appUrn, action, context]]);
        expect(appsService.getApp).toHaveBeenCalledWith(appUrn);
      });
    });

    it('still takes configure from a person to call a tool: view alone is refused', async () => {
      lifecycle.assertActorMay.mockImplementation(lifecycleActorGate((_userId, _appUrn, action) => action === 'view'));

      await expect(asGrantedOperator(() => tools.callAppTool({ appUrn, tool: 'delete_everything', arguments: {} }))).rejects.toThrow(
        'APP_ACTION_GRANT_DENIED',
      );
      expect(appsService.getApp).not.toHaveBeenCalled();
      expect(mcpBridge.callTool).not.toHaveBeenCalled();
    });
  });
});
