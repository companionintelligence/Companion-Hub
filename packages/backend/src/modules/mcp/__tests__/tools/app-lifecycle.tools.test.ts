import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { LifecycleActor, LifecycleActorFor } from '@/core/portal/lifecycle-actor';
import type { ApiKeyContext } from '@/modules/api-keys/api-key.service';
import { mcpAdminCallContext, mcpCallContext } from '../../mcp-call-context';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { AppLifecycleTools } from '../../tools/app-lifecycle.tools';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';

/** An operator-created key: the lifecycle tools act only for a named caller, and this is the plainest one. */
const OPERATOR_KEY: ApiKeyContext = { id: 1, name: 'Laptop CLI', capability: 'write', ownerAppUrn: null };
const asKey = <T>(fn: () => Promise<T>, key: ApiKeyContext = OPERATOR_KEY) => mcpCallContext.run(key, fn);

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
      const result = await asKey(() => tools.installApp({ appUrn: 'ci-store:nextcloud', form: { port: 8080 } }));
      expect(lifecycleService.installApp).toHaveBeenCalled();
      expect(result).toEqual({ requestId: 'uuid-1' });
    });
    it('should return error when app is already installed', async () => {
      lifecycleService.validateAppConfig.mockResolvedValue({ valid: true, errors: [] });
      lifecycleService.installApp.mockRejectedValue(new Error('Already installed'));
      await expect(asKey(() => tools.installApp({ appUrn: 'ci-store:nextcloud' }))).rejects.toThrow('Already installed');
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
      const result = await asKey(() => tools.updateAppConfig({ appUrn: 'ci-store:test', form: { port: 9090 } }));
      expect(result).toEqual({ requestId: 'uuid-8' });
    });
    it('should pass form values to the lifecycle service', async () => {
      lifecycleService.updateAppConfig.mockResolvedValue({ requestId: 'uuid-8' });
      await asKey(() => tools.updateAppConfig({ appUrn: 'ci-store:test', form: { port: 9090, exposed: true } }));
      expect(lifecycleService.updateAppConfig).toHaveBeenCalledWith(expect.objectContaining({ form: { port: 9090, exposed: true } }));
    });
  });

  describe('hub_update_all_apps', () => {
    it('should invoke bulk update', async () => {
      lifecycleService.updateAllApps.mockResolvedValue(undefined);
      await asKey(() => tools.updateAllApps());
      expect(lifecycleService.updateAllApps).toHaveBeenCalled();
    });
  });

  describe('hub_start_all_apps', () => {
    it('should invoke bulk start', async () => {
      lifecycleService.startAllApps.mockResolvedValue(undefined);
      await asKey(() => tools.startAllApps());
      expect(lifecycleService.startAllApps).toHaveBeenCalled();
    });
  });

  describe('hub_stop_all_apps', () => {
    it('should invoke bulk stop', async () => {
      lifecycleService.stopAllApps.mockResolvedValue(undefined);
      await asKey(() => tools.stopAllApps());
      expect(lifecycleService.stopAllApps).toHaveBeenCalled();
    });
  });

  describe('hub_restart_all_apps', () => {
    it('should invoke bulk restart', async () => {
      lifecycleService.restartAllApps.mockResolvedValue(undefined);
      await asKey(() => tools.restartAllApps());
      expect(lifecycleService.restartAllApps).toHaveBeenCalled();
    });
  });

  describe('the actor handed to the lifecycle service (CI-Hub#1397)', () => {
    it('names an unmanaged MCP key with no owning app', async () => {
      lifecycleService.validateAppConfig.mockResolvedValue({ valid: true, errors: [] });
      lifecycleService.installApp.mockResolvedValue({ requestId: 'uuid-1' });

      await asKey(() => tools.installApp({ appUrn: 'ci-store:nextcloud', form: { port: 8080 } }));

      expect(lifecycleService.installApp).toHaveBeenCalledWith(
        expect.objectContaining({ actor: { kind: 'mcp', ownerAppUrn: null, createdByUserId: null } }),
      );
    });

    it('names the person who created an unmanaged key, so it acts with their grants and role', async () => {
      lifecycleService.updateAppConfig.mockResolvedValue({ requestId: 'uuid-9' });
      const createdKey: ApiKeyContext = { ...OPERATOR_KEY, createdByUserId: 4 };

      await asKey(() => tools.updateAppConfig({ appUrn: 'ci-store:test', form: { port: 9090 } }), createdKey);

      expect(lifecycleService.updateAppConfig).toHaveBeenCalledWith(
        expect.objectContaining({ actor: { kind: 'mcp', ownerAppUrn: null, createdByUserId: 4 } }),
      );
    });

    it("carries a managed key's owning app, so the service can confine it to that app", async () => {
      lifecycleService.updateAppConfig.mockResolvedValue({ requestId: 'uuid-8' });
      const managedKey = { id: 3, name: 'importer', capability: 'write', ownerAppUrn: 'importer:ci-store', createdByUserId: null } as const;

      await asKey(() => tools.updateAppConfig({ appUrn: 'ci-store:test', form: { port: 9090 } }), managedKey);

      expect(lifecycleService.updateAppConfig).toHaveBeenCalledWith(
        expect.objectContaining({ actor: { kind: 'mcp', ownerAppUrn: 'importer:ci-store', createdByUserId: null } }),
      );
    });

    it.each(['updateAllApps', 'startAllApps', 'stopAllApps', 'restartAllApps'] as const)('hands %s the MCP actor', async (sweep) => {
      lifecycleService[sweep].mockResolvedValue(undefined);

      await asKey(() => tools[sweep]());

      expect(lifecycleService[sweep]).toHaveBeenCalledWith({ kind: 'mcp', ownerAppUrn: null, createdByUserId: null });
    });

    it('acts as the person an admin-runner call names, for the verb it runs', async () => {
      const operator: LifecycleActor = { kind: 'operator', userId: 7 };
      const actorFor = vi.fn<LifecycleActorFor>(() => operator);
      lifecycleService.updateAppConfig.mockResolvedValue({ requestId: 'uuid-8' });
      lifecycleService.stopAllApps.mockResolvedValue(undefined);

      await mcpAdminCallContext.run(actorFor, async () => {
        await tools.updateAppConfig({ appUrn: 'ci-store:test', form: { port: 9090 } });
        await tools.stopAllApps();
      });

      expect(actorFor).toHaveBeenNthCalledWith(1, 'configure');
      expect(actorFor).toHaveBeenNthCalledWith(2, 'stop');
      expect(lifecycleService.updateAppConfig).toHaveBeenCalledWith(expect.objectContaining({ actor: operator }));
      expect(lifecycleService.stopAllApps).toHaveBeenCalledWith(operator);
    });

    it('refuses a call that names no caller, rather than taking it for an unmanaged key', async () => {
      // The admin runner sets no key context, and "no key" used to read as an unconfined one.
      await expect(tools.installApp({ appUrn: 'ci-store:nextcloud', form: {} })).rejects.toThrow('APP_ACTION_GRANT_DENIED');
      await expect(tools.updateAppConfig({ appUrn: 'ci-store:test', form: { port: 9090 } })).rejects.toThrow('APP_ACTION_GRANT_DENIED');
      await expect(tools.restartAllApps()).rejects.toThrow('APP_ACTION_GRANT_DENIED');

      expect(lifecycleService.validateAppConfig).not.toHaveBeenCalled();
      expect(lifecycleService.installApp).not.toHaveBeenCalled();
      expect(lifecycleService.updateAppConfig).not.toHaveBeenCalled();
      expect(lifecycleService.restartAllApps).not.toHaveBeenCalled();
    });
  });
});
