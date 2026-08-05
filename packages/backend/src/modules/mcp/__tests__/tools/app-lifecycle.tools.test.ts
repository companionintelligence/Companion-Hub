import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { AppLifecycleTools } from '../../tools/app-lifecycle.tools';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';

describe('AppLifecycleTools', () => {
  let tools: AppLifecycleTools;
  let lifecycleService: MockProxy<AppLifecycleService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppLifecycleTools,
        { provide: AppLifecycleService, useValue: mock<AppLifecycleService>() },
        { provide: McpToolRegistry, useValue: mock<McpToolRegistry>() },
      ],
    }).compile();
    tools = module.get<AppLifecycleTools>(AppLifecycleTools);
    lifecycleService = module.get(AppLifecycleService);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('hub_install_app', () => {
    it('should enqueue an install command and return a requestId', async () => {
      lifecycleService.validateAppConfig.mockResolvedValue({ valid: true, errors: [] });
      lifecycleService.installApp.mockResolvedValue({ requestId: 'uuid-1' });
      const result = await tools.installApp({ appUrn: 'ci-store:nextcloud', form: { port: 8080 } });
      expect(lifecycleService.installApp).toHaveBeenCalled();
      expect(result).toEqual({ requestId: 'uuid-1' });
    });
    it('should return error when app is already installed', async () => {
      lifecycleService.validateAppConfig.mockResolvedValue({ valid: true, errors: [] });
      lifecycleService.installApp.mockRejectedValue(new Error('Already installed'));
      await expect(tools.installApp({ appUrn: 'ci-store:nextcloud' })).rejects.toThrow();
    });
  });

  describe('hub_start_app', () => {
    it('should accept appUrn and return requestId', async () => {
      lifecycleService.startApp.mockResolvedValue({ requestId: 'uuid-2' });
      const result = await tools.startApp({ appUrn: 'ci-store:test' });
      expect(result).toEqual({ requestId: 'uuid-2' });
    });
    it('should return error when app is not installed', async () => {
      lifecycleService.startApp.mockRejectedValue(new Error('Not found'));
      await expect(tools.startApp({ appUrn: 'ci-store:test' })).rejects.toThrow();
    });
  });

  describe('hub_stop_app', () => {
    it('should accept appUrn and return requestId', async () => {
      lifecycleService.stopApp.mockResolvedValue({ requestId: 'uuid-3' });
      const result = await tools.stopApp({ appUrn: 'ci-store:test' });
      expect(result).toEqual({ requestId: 'uuid-3' });
    });
  });

  describe('hub_restart_app', () => {
    it('should accept appUrn and return requestId', async () => {
      lifecycleService.restartApp.mockResolvedValue({ requestId: 'uuid-4' });
      const result = await tools.restartApp({ appUrn: 'ci-store:test' });
      expect(result).toEqual({ requestId: 'uuid-4' });
    });
  });

  describe('hub_uninstall_app', () => {
    it('should enqueue uninstall command with deleteAllData defaulting to true', async () => {
      lifecycleService.uninstallApp.mockResolvedValue({ requestId: 'uuid-5' });
      await tools.uninstallApp({ appUrn: 'ci-store:test' });
      expect(lifecycleService.uninstallApp).toHaveBeenCalledWith(expect.objectContaining({ deleteAllData: true }));
    });
    it('should pass deleteAllData: false when specified', async () => {
      lifecycleService.uninstallApp.mockResolvedValue({ requestId: 'uuid-5' });
      await tools.uninstallApp({ appUrn: 'ci-store:test', deleteAllData: false });
      expect(lifecycleService.uninstallApp).toHaveBeenCalledWith(expect.objectContaining({ deleteAllData: false }));
    });
    it('should return a requestId', async () => {
      lifecycleService.uninstallApp.mockResolvedValue({ requestId: 'uuid-5' });
      const result = await tools.uninstallApp({ appUrn: 'ci-store:test' });
      expect(result.requestId).toBe('uuid-5');
    });
    it('should default force to false and pass force: true when specified', async () => {
      lifecycleService.uninstallApp.mockResolvedValue({ requestId: 'uuid-5' });
      await tools.uninstallApp({ appUrn: 'ci-store:test' });
      expect(lifecycleService.uninstallApp).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
      await tools.uninstallApp({ appUrn: 'ci-store:test', force: true });
      expect(lifecycleService.uninstallApp).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    });
    it('should propagate a guard rejection from the service', async () => {
      lifecycleService.uninstallApp.mockRejectedValue(new Error('APP_ERROR_MEMORY_PROVIDER_IN_USE'));
      await expect(tools.uninstallApp({ appUrn: 'ci-memory:ci-marketplace' })).rejects.toThrow();
    });
  });

  describe('hub_reset_app', () => {
    it('should enqueue a reset command and return requestId', async () => {
      lifecycleService.resetApp.mockResolvedValue({ requestId: 'uuid-6' });
      const result = await tools.resetApp({ appUrn: 'ci-store:test' });
      expect(result).toEqual({ requestId: 'uuid-6' });
    });
    it('should default force to false and pass force: true when specified', async () => {
      lifecycleService.resetApp.mockResolvedValue({ requestId: 'uuid-6' });
      await tools.resetApp({ appUrn: 'ci-store:test' });
      expect(lifecycleService.resetApp).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
      await tools.resetApp({ appUrn: 'ci-store:test', force: true });
      expect(lifecycleService.resetApp).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    });
  });

  describe('hub_update_app', () => {
    it('should enqueue update command with performBackup defaulting to true', async () => {
      lifecycleService.updateApp.mockResolvedValue({ requestId: 'uuid-7' });
      await tools.updateApp({ appUrn: 'ci-store:test' });
      expect(lifecycleService.updateApp).toHaveBeenCalledWith(expect.objectContaining({ performBackup: true }));
    });
    it('should pass performBackup: false when specified', async () => {
      lifecycleService.updateApp.mockResolvedValue({ requestId: 'uuid-7' });
      await tools.updateApp({ appUrn: 'ci-store:test', performBackup: false });
      expect(lifecycleService.updateApp).toHaveBeenCalledWith(expect.objectContaining({ performBackup: false }));
    });
  });

  describe('hub_update_app_config', () => {
    it('should enqueue config update and return requestId', async () => {
      lifecycleService.updateAppConfig.mockResolvedValue({ requestId: 'uuid-8' });
      const result = await tools.updateAppConfig({ appUrn: 'ci-store:test', form: { port: 9090 } });
      expect(result).toEqual({ requestId: 'uuid-8' });
    });
    it('should pass form values to the lifecycle service', async () => {
      lifecycleService.updateAppConfig.mockResolvedValue({ requestId: 'uuid-8' });
      await tools.updateAppConfig({ appUrn: 'ci-store:test', form: { port: 9090, exposed: true } });
      expect(lifecycleService.updateAppConfig).toHaveBeenCalledWith(expect.objectContaining({ form: { port: 9090, exposed: true } }));
    });
  });

  describe('hub_update_all_apps', () => {
    it('should invoke bulk update', async () => {
      lifecycleService.updateAllApps.mockResolvedValue(undefined);
      await tools.updateAllApps();
      expect(lifecycleService.updateAllApps).toHaveBeenCalled();
    });
  });

  describe('hub_start_all_apps', () => {
    it('should invoke bulk start', async () => {
      lifecycleService.startAllApps.mockResolvedValue(undefined);
      await tools.startAllApps();
      expect(lifecycleService.startAllApps).toHaveBeenCalled();
    });
  });

  describe('hub_stop_all_apps', () => {
    it('should invoke bulk stop', async () => {
      lifecycleService.stopAllApps.mockResolvedValue(undefined);
      await tools.stopAllApps();
      expect(lifecycleService.stopAllApps).toHaveBeenCalled();
    });
  });

  describe('hub_restart_all_apps', () => {
    it('should invoke bulk restart', async () => {
      lifecycleService.restartAllApps.mockResolvedValue(undefined);
      await tools.restartAllApps();
      expect(lifecycleService.restartAllApps).toHaveBeenCalled();
    });
  });
});
