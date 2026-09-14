import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { GRANTED_ACTOR, REFUSED_CALLERS, asGrantedOperator, lifecycleActorGate } from '@/tests/utils/lifecycle-actor-gate';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { CustomAppTools } from '../../tools/custom-app.tools';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { CustomAppService } from '@/modules/custom-apps/custom-apps.service';

describe('CustomAppTools', () => {
  let tools: CustomAppTools;
  let customAppService: MockProxy<CustomAppService>;
  let lifecycle: MockProxy<AppLifecycleService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomAppTools,
        { provide: CustomAppService, useValue: mock<CustomAppService>() },
        { provide: McpToolRegistry, useValue: mock<McpToolRegistry>() },
        { provide: AppLifecycleService, useValue: mock<AppLifecycleService>() },
      ],
    }).compile();
    tools = module.get<CustomAppTools>(CustomAppTools);
    customAppService = module.get(CustomAppService);
    lifecycle = module.get(AppLifecycleService);
    // The real actor decision, which a change to an existing app asks before it touches the app.
    lifecycle.assertActorMay.mockImplementation(lifecycleActorGate());
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('hub_create_custom_app', () => {
    it('should create a custom app and return appUrn, appName, storeId', async () => {
      customAppService.createCustomApp.mockResolvedValue({ appUrn: 'custom:myapp', appName: 'myapp', storeId: 'custom' } as any);
      const result = await tools.createCustomApp({ name: 'myapp', config: { services: {} } });
      expect(customAppService.createCustomApp).toHaveBeenCalled();
      expect(result).toEqual({ appUrn: 'custom:myapp', appName: 'myapp', storeId: 'custom' });
    });
  });

  describe('hub_update_custom_app', () => {
    it('should update the custom app compose configuration', async () => {
      customAppService.updateCustomApp.mockResolvedValue(undefined);
      const result = await asGrantedOperator(() => tools.updateCustomApp({ appUrn: 'custom:myapp', config: { services: {} } }));
      expect(customAppService.updateCustomApp).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe('hub_update_app_metadata', () => {
    it('should update the app frontmatter metadata', async () => {
      customAppService.updateAppMetadata.mockResolvedValue(undefined);
      const result = await asGrantedOperator(() => tools.updateAppMetadata({ appUrn: 'custom:myapp', data: 'description: My App' }));
      expect(customAppService.updateAppMetadata).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  /*
   * The custom-app routes assert no grant, so `CustomAppService` takes no actor; a change to an existing
   * app asks the lifecycle's actor gate for `configure` in the tool instead (CI-Hub#1397).
   */
  describe('the actor gate', () => {
    const appUrn = 'myapp:custom';

    const calls: Array<[string, () => Promise<unknown>, () => unknown]> = [
      ['hub_update_custom_app', () => tools.updateCustomApp({ appUrn, config: { services: {} } }), () => customAppService.updateCustomApp],
      ['hub_update_app_metadata', () => tools.updateAppMetadata({ appUrn, data: 'description: Mine' }), () => customAppService.updateAppMetadata],
    ];

    describe.each(calls)('%s', (_tool, call, service) => {
      it.each(REFUSED_CALLERS)('refuses %s, and never reaches the service', async (_label, as) => {
        await expect(as(call)).rejects.toThrow('APP_ACTION_GRANT_DENIED');

        expect(service()).not.toHaveBeenCalled();
      });

      it('reaches the service for a person holding configure', async () => {
        await asGrantedOperator(call);

        expect(lifecycle.assertActorMay).toHaveBeenCalledWith(GRANTED_ACTOR, appUrn, 'configure');
        expect(service()).toHaveBeenCalled();
      });
    });
  });
});
