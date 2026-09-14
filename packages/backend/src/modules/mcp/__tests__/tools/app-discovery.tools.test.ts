import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { HubAction } from '@/core/portal/hub-actions';
import { GRANTED_ACTOR, REFUSED_CALLERS, asGrantedOperator, lifecycleActorGate } from '@/tests/utils/lifecycle-actor-gate';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { AppDiscoveryTools } from '../../tools/app-discovery.tools';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppsService } from '@/modules/apps/apps.service';
import { DockerService } from '@/modules/docker/docker.service';

describe('AppDiscoveryTools', () => {
  let tools: AppDiscoveryTools;
  let appsService: MockProxy<AppsService>;
  let dockerService: MockProxy<DockerService>;
  let lifecycle: MockProxy<AppLifecycleService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppDiscoveryTools,
        { provide: AppsService, useValue: mock<AppsService>() },
        { provide: DockerService, useValue: mock<DockerService>() },
        { provide: McpToolRegistry, useValue: mock<McpToolRegistry>() },
        { provide: AppLifecycleService, useValue: mock<AppLifecycleService>() },
      ],
    }).compile();

    tools = module.get<AppDiscoveryTools>(AppDiscoveryTools);
    appsService = module.get(AppsService);
    dockerService = module.get(DockerService);
    lifecycle = module.get(AppLifecycleService);
    // The real actor decision, which every per-app tool here asks before it touches the app.
    lifecycle.assertActorMay.mockImplementation(lifecycleActorGate());
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('hub_list_installed_apps', () => {
    it('should return array of installed apps with app, info, and metadata fields', async () => {
      const mockApps = [{ app: { status: 'running' }, info: { name: 'test', urn: 'ci-store:test' }, metadata: { latestVersion: 1 } }];
      appsService.getInstalledApps.mockResolvedValue(mockApps as any);
      const result = await tools.listInstalledApps();
      expect(appsService.getInstalledApps).toHaveBeenCalled();
      expect(result).toEqual(mockApps);
    });

    it('should only include apps with a database record', async () => {
      appsService.getInstalledApps.mockResolvedValue([]);
      const result = await tools.listInstalledApps();
      expect(result).toEqual([]);
    });
  });

  describe('hub_get_app', () => {
    it('should return detailed app info including form_fields and supported architectures', async () => {
      const mockApp = { app: {}, info: { form_fields: [], architectures: ['amd64'] }, metadata: {} };
      appsService.getApp.mockResolvedValue(mockApp as any);
      const result = await asGrantedOperator(() => tools.getApp({ appUrn: 'ci-store:nextcloud' }));
      expect(appsService.getApp).toHaveBeenCalled();
      expect(result).toEqual(mockApp);
    });

    it('should return info from app store with app: null for non-existent URN', async () => {
      const mockApp = { app: null, info: { name: 'test' }, metadata: {} };
      appsService.getApp.mockResolvedValue(mockApp as any);
      const result = await asGrantedOperator(() => tools.getApp({ appUrn: 'ci-store:nonexistent' }));
      expect(result.app).toBeNull();
    });

    it('should require appUrn parameter', async () => {
      appsService.getApp.mockRejectedValue(new Error('Invalid'));
      await expect(asGrantedOperator(() => tools.getApp({ appUrn: '' }))).rejects.toThrow('Invalid namespaced app id');
    });
  });

  describe('hub_check_app_availability', () => {
    it('should return available: true with url for reachable app', async () => {
      appsService.checkAppAvailability.mockResolvedValue({ available: true, appUrl: 'http://localhost:8080' } as any);
      const result = await asGrantedOperator(() => tools.checkAppAvailability({ appUrn: 'ci-store:test' }));
      expect(result.available).toBe(true);
      expect(result.url).toBe('http://localhost:8080');
    });

    it('should return available: false with error for unreachable app', async () => {
      appsService.checkAppAvailability.mockResolvedValue({ available: false, reason: 'Connection refused' } as any);
      const result = await asGrantedOperator(() => tools.checkAppAvailability({ appUrn: 'ci-store:test' }));
      expect(result.available).toBe(false);
      expect(result.error).toBe('Connection refused');
    });
  });

  describe('hub_resolve_app_availability', () => {
    it('should attempt to fix availability issues and return success with message', async () => {
      appsService.resolveAppAvailability.mockResolvedValue({ success: true, action: 'restart', detail: 'Restarted container' });
      const result = await asGrantedOperator(() => tools.resolveAppAvailability({ appUrn: 'ci-store:test' }));
      expect(result.success).toBe(true);
      expect(result.message).toBe('Restarted container');
    });

    it('should return success: false when fix attempt fails', async () => {
      appsService.resolveAppAvailability.mockResolvedValue({ success: false, action: 'none', detail: 'No fix available' });
      const result = await asGrantedOperator(() => tools.resolveAppAvailability({ appUrn: 'ci-store:test' }));
      expect(result.success).toBe(false);
    });
  });

  describe('hub_get_compose_diff', () => {
    it('should return current and new compose content', async () => {
      appsService.getAppComposeDiff.mockResolvedValue({ current: '{}', new: '{"version":"2"}' });
      const result = await asGrantedOperator(() => tools.getComposeDiff({ appUrn: 'ci-store:test' }));
      expect(result.current).toBe('{}');
      expect(result.new).toBe('{"version":"2"}');
    });

    it('should return null values when no diff exists', async () => {
      appsService.getAppComposeDiff.mockResolvedValue({ current: null, new: null });
      const result = await asGrantedOperator(() => tools.getComposeDiff({ appUrn: 'ci-store:test' }));
      expect(result.current).toBeNull();
      expect(result.new).toBeNull();
    });
  });

  describe('hub_get_config_diff', () => {
    it('should return current and new config content', async () => {
      appsService.getAppConfigDiff.mockResolvedValue({ current: '{}', new: '{"port":8080}' });
      const result = await asGrantedOperator(() => tools.getConfigDiff({ appUrn: 'ci-store:test' }));
      expect(result.current).toBe('{}');
    });

    it('should return null values when no diff exists', async () => {
      appsService.getAppConfigDiff.mockResolvedValue({ current: null, new: null });
      const result = await asGrantedOperator(() => tools.getConfigDiff({ appUrn: 'ci-store:test' }));
      expect(result.current).toBeNull();
    });
  });

  /*
   * `AppsService` and `DockerService` cannot ask the lifecycle's actor gate, so each tool on one app asks
   * it first (CI-Hub#1397): a refused caller never reaches the service, and the grant asked for is the
   * one the app routes assert for the same read or repair.
   */
  describe('the actor gate', () => {
    const appUrn = 'immich:ci-marketplace';

    const calls: Array<[string, HubAction, () => Promise<unknown>, () => unknown]> = [
      ['hub_get_app', 'view', () => tools.getApp({ appUrn }), () => appsService.getApp],
      ['hub_get_app_logs', 'view', () => tools.getAppLogs({ appUrn }), () => dockerService.getLogsStream],
      ['hub_check_app_availability', 'view', () => tools.checkAppAvailability({ appUrn }), () => appsService.checkAppAvailability],
      ['hub_resolve_app_availability', 'configure', () => tools.resolveAppAvailability({ appUrn }), () => appsService.resolveAppAvailability],
      ['hub_get_compose_diff', 'view', () => tools.getComposeDiff({ appUrn }), () => appsService.getAppComposeDiff],
      ['hub_get_config_diff', 'view', () => tools.getConfigDiff({ appUrn }), () => appsService.getAppConfigDiff],
    ];

    beforeEach(() => {
      // No container to stream from: the logs tool settles at once instead of on its five-second timeout.
      dockerService.getLogsStream.mockRejectedValue(new Error('no container'));
      appsService.checkAppAvailability.mockResolvedValue({ available: true, appUrl: 'http://immich' } as any);
      appsService.resolveAppAvailability.mockResolvedValue({ success: true, action: 'none', detail: '' });
    });

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
