import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { HubAction } from '@/core/portal/hub-actions';
import { GRANTED_ACTOR, REFUSED_CALLERS, asGrantedOperator, lifecycleActorGate } from '@/tests/utils/lifecycle-actor-gate';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { AppConfigTools } from '../../tools/app-config.tools';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { UserConfigService } from '@/modules/user-config/user-config.service';
import { AppsService } from '@/modules/apps/apps.service';

describe('AppConfigTools', () => {
  let tools: AppConfigTools;
  let userConfigService: MockProxy<UserConfigService>;
  let appsService: MockProxy<AppsService>;
  let lifecycle: MockProxy<AppLifecycleService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppConfigTools,
        { provide: UserConfigService, useValue: mock<UserConfigService>() },
        { provide: AppsService, useValue: mock<AppsService>() },
        { provide: McpToolRegistry, useValue: mock<McpToolRegistry>() },
        { provide: AppLifecycleService, useValue: mock<AppLifecycleService>() },
      ],
    }).compile();
    tools = module.get<AppConfigTools>(AppConfigTools);
    userConfigService = module.get(UserConfigService);
    appsService = module.get(AppsService);
    lifecycle = module.get(AppLifecycleService);
    // The real actor decision, which every tool here asks before it touches the app.
    lifecycle.assertActorMay.mockImplementation(lifecycleActorGate());
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('hub_get_user_config', () => {
    it('should return dockerCompose, appEnv, and isEnabled', async () => {
      userConfigService.getUserConfig.mockResolvedValue({ dockerCompose: 'yaml', appEnv: 'KEY=val', isEnabled: true });
      const result = await asGrantedOperator(() => tools.getUserConfig({ appUrn: 'ci-store:test' }));
      expect(result.dockerCompose).toBe('yaml');
      expect(result.appEnv).toBe('KEY=val');
      expect(result.isEnabled).toBe(true);
    });
  });

  describe('hub_update_user_config', () => {
    it('should update user config files and return success', async () => {
      userConfigService.updateUserConfig.mockResolvedValue(undefined);
      const result = await asGrantedOperator(() => tools.updateUserConfig({ appUrn: 'ci-store:test', dockerCompose: 'new-yaml', appEnv: 'NEW=val' }));
      expect(userConfigService.updateUserConfig).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe('hub_enable_user_config', () => {
    it('should enable user config for the specified app', async () => {
      userConfigService.enableUserConfig.mockResolvedValue(undefined);
      const result = await asGrantedOperator(() => tools.enableUserConfig({ appUrn: 'ci-store:test' }));
      expect(userConfigService.enableUserConfig).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe('hub_disable_user_config', () => {
    it('should disable user config for the specified app', async () => {
      userConfigService.disableUserConfig.mockResolvedValue(undefined);
      const result = await asGrantedOperator(() => tools.disableUserConfig({ appUrn: 'ci-store:test' }));
      expect(userConfigService.disableUserConfig).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe('hub_ignore_app_version', () => {
    it('should mark the app version as ignored', async () => {
      appsService.ignoreAppVersion.mockResolvedValue(undefined as any);
      await asGrantedOperator(() => tools.ignoreAppVersion({ appUrn: 'ci-store:test' }));
      expect(appsService.ignoreAppVersion).toHaveBeenCalled();
    });
  });

  describe('hub_unignore_app_version', () => {
    it('should unmark the app version as ignored', async () => {
      appsService.unignoreAppVersion.mockResolvedValue(undefined as any);
      await asGrantedOperator(() => tools.unignoreAppVersion({ appUrn: 'ci-store:test' }));
      expect(appsService.unignoreAppVersion).toHaveBeenCalled();
    });
  });

  /*
   * Neither `UserConfigService` nor `AppsService` can ask the lifecycle's actor gate, so each tool asks
   * it first (CI-Hub#1397): a refused caller never reaches the service, and the grant asked for is the
   * one the app routes assert for the same change.
   */
  describe('the actor gate', () => {
    const appUrn = 'immich:ci-marketplace';

    const calls: Array<[string, HubAction, () => Promise<unknown>, () => unknown]> = [
      ['hub_get_user_config', 'view', () => tools.getUserConfig({ appUrn }), () => userConfigService.getUserConfig],
      [
        'hub_update_user_config',
        'configure',
        () => tools.updateUserConfig({ appUrn, dockerCompose: 'services: {}', appEnv: 'A=1' }),
        () => userConfigService.updateUserConfig,
      ],
      ['hub_enable_user_config', 'configure', () => tools.enableUserConfig({ appUrn }), () => userConfigService.enableUserConfig],
      ['hub_disable_user_config', 'configure', () => tools.disableUserConfig({ appUrn }), () => userConfigService.disableUserConfig],
      ['hub_ignore_app_version', 'configure', () => tools.ignoreAppVersion({ appUrn }), () => appsService.ignoreAppVersion],
      ['hub_unignore_app_version', 'configure', () => tools.unignoreAppVersion({ appUrn }), () => appsService.unignoreAppVersion],
    ];

    describe.each(calls)('%s', (_tool, action, call, service) => {
      it.each(REFUSED_CALLERS)('refuses %s, and never reaches the service', async (_label, as) => {
        await expect(as(call)).rejects.toThrow('APP_ACTION_GRANT_DENIED');

        expect(service()).not.toHaveBeenCalled();
      });

      it(`reaches the service for a person holding ${action}`, async () => {
        await asGrantedOperator(call);

        expect(lifecycle.assertActorMay).toHaveBeenCalledWith(GRANTED_ACTOR, appUrn, action);
        expect(service()).toHaveBeenCalled();
      });
    });
  });
});
