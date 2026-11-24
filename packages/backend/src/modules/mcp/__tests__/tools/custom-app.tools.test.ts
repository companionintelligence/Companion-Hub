import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import {
  GRANTED_ACTOR,
  UNGRANTED_CALLERS,
  asGrantedOperator,
  asManagedKeyOnOtherApp,
  gateChecks,
  lifecycleActorGate,
} from '@/tests/utils/lifecycle-actor-gate';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { CustomAppTools } from '../../tools/custom-app.tools';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { CustomAppService } from '@/modules/custom-apps/custom-apps.service';
import { formatToolError } from '../../mcp-error.handler';

/** A compose the custom-app form accepts. */
const validConfig = { schemaVersion: 2, services: [{ name: 'web', image: 'nginx:alpine', internalPort: 80, isMain: true }] };

/** `validConfig` with extra settings on its one service. */
const configWith = (settings: Record<string, unknown>) => ({ ...validConfig, services: [{ ...validConfig.services[0], ...settings }] });

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
      const result = await asGrantedOperator(() => tools.createCustomApp({ name: 'myapp', config: validConfig }));
      expect(customAppService.createCustomApp).toHaveBeenCalled();
      expect(result).toEqual({ appUrn: 'custom:myapp', appName: 'myapp', storeId: 'custom' });
    });

    // Creating one takes an organization owner or admin; the lifecycle decides it for the caller's actor.
    it('asks the lifecycle whether the caller may create one, before the service writes anything', async () => {
      await asGrantedOperator(() => tools.createCustomApp({ name: 'myapp', config: validConfig }));

      expect(lifecycle.assertActorMayCreateCustomApp).toHaveBeenCalledWith(GRANTED_ACTOR);
    });

    it('writes nothing when the caller may not', async () => {
      lifecycle.assertActorMayCreateCustomApp.mockRejectedValue(new Error('CUSTOM_APP_CREATE_ROLE_REQUIRED'));

      await expect(asGrantedOperator(() => tools.createCustomApp({ name: 'myapp', config: validConfig }))).rejects.toThrow(
        'CUSTOM_APP_CREATE_ROLE_REQUIRED',
      );
      expect(customAppService.createCustomApp).not.toHaveBeenCalled();
    });

    it('refuses a call that names no caller', async () => {
      await expect(tools.createCustomApp({ name: 'myapp', config: validConfig })).rejects.toThrow('APP_ACTION_GRANT_DENIED');
      expect(customAppService.createCustomApp).not.toHaveBeenCalled();
    });
  });

  describe('hub_update_custom_app', () => {
    it('should update the custom app compose configuration', async () => {
      customAppService.updateCustomApp.mockResolvedValue(undefined);
      const result = await asGrantedOperator(() => tools.updateCustomApp({ appUrn: 'custom:myapp', config: validConfig }));
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
   * The tools run the config through the schema `POST` and `PATCH /api/custom-apps` use, so an agent is
   * refused what the form refuses, with the same key, and nothing is stored (CI-Hub#2372).
   */
  describe('the compose schema', () => {
    it('refuses a create that adds SYS_ADMIN, and never reaches the service', async () => {
      await expect(asGrantedOperator(() => tools.createCustomApp({ name: 'myapp', config: configWith({ capAdd: ['SYS_ADMIN'] }) }))).rejects.toThrow(
        'config.services.0.capAdd.0: CUSTOM_APP_ERROR_CAP_ADD_NOT_ALLOWED',
      );
      expect(customAppService.createCustomApp).not.toHaveBeenCalled();
    });

    it.each([true, 'true'])('refuses a create with privileged %j, and never reaches the service', async (privileged) => {
      await expect(asGrantedOperator(() => tools.createCustomApp({ name: 'myapp', config: configWith({ privileged }) }))).rejects.toThrow(
        'config.services.0.privileged',
      );
      expect(customAppService.createCustomApp).not.toHaveBeenCalled();
    });

    it('refuses a create whose name the form refuses', async () => {
      await expect(asGrantedOperator(() => tools.createCustomApp({ name: '', config: validConfig }))).rejects.toThrow('name:');
      expect(customAppService.createCustomApp).not.toHaveBeenCalled();
    });

    it('refuses an update to pid host, and never reaches the service', async () => {
      await expect(asGrantedOperator(() => tools.updateCustomApp({ appUrn: 'myapp:custom', config: configWith({ pid: 'host' }) }))).rejects.toThrow(
        'config.services.0.pid: CUSTOM_APP_ERROR_PID_HOST_NOT_ALLOWED',
      );
      expect(customAppService.updateCustomApp).not.toHaveBeenCalled();
    });

    it('passes an allowed config to the service as the schema parsed it', async () => {
      const config = configWith({ capAdd: ['NET_BIND_SERVICE'], networkMode: 'bridge', notAComposeField: 'dropped' });

      await asGrantedOperator(() => tools.createCustomApp({ name: '  My App  ', config }));
      await asGrantedOperator(() => tools.updateCustomApp({ appUrn: 'myapp:custom', config }));

      const parsed = configWith({ capAdd: ['NET_BIND_SERVICE'], networkMode: 'bridge' });
      expect(customAppService.createCustomApp).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'My App', config: expect.objectContaining(parsed) }),
      );
      expect(customAppService.createCustomApp.mock.calls[0]?.[0].config.services[0]).not.toHaveProperty('notAComposeField');
      expect(customAppService.updateCustomApp).toHaveBeenCalledWith('myapp:custom', expect.objectContaining(parsed));
    });

    it('reports the refusal to the agent as an error naming the key', async () => {
      const error = await asGrantedOperator(() =>
        tools.createCustomApp({ name: 'myapp', config: configWith({ capAdd: ['SYS_ADMIN'] }) }).then(
          () => undefined,
          (e: unknown) => e,
        ),
      );

      const result = formatToolError(error);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('CUSTOM_APP_ERROR_CAP_ADD_NOT_ALLOWED');
    });
  });

  /*
   * The custom-app routes assert no grant, so `CustomAppService` takes no actor; a change to an existing
   * app asks the lifecycle's actor gate for `configure` in the tool instead (CI-Hub#1397).
   */
  describe('the actor gate', () => {
    const appUrn = 'myapp:custom';

    const calls: Array<[string, () => Promise<unknown>, () => unknown]> = [
      ['hub_update_custom_app', () => tools.updateCustomApp({ appUrn, config: validConfig }), () => customAppService.updateCustomApp],
      ['hub_update_app_metadata', () => tools.updateAppMetadata({ appUrn, data: 'description: Mine' }), () => customAppService.updateAppMetadata],
    ];

    describe.each(calls)('%s', (_tool, call, service) => {
      it.each(UNGRANTED_CALLERS)('refuses %s, and never reaches the service', async (_label, as) => {
        await expect(as(call)).rejects.toThrow('APP_ACTION_GRANT_DENIED');

        expect(service()).not.toHaveBeenCalled();
      });

      // Rewriting another app's compose or metadata changes it, which a managed app key needs `full` for.
      it("refuses a managed app's key at write on another app, and never reaches the service", async () => {
        await expect(asManagedKeyOnOtherApp(call)).rejects.toThrow('APP_ACTION_GRANT_DENIED');

        expect(service()).not.toHaveBeenCalled();
      });

      it("reaches the service for a managed app's key at full on another app", async () => {
        await asManagedKeyOnOtherApp(call, 'full');

        expect(service()).toHaveBeenCalled();
      });

      it('reaches the service for a person holding configure', async () => {
        await asGrantedOperator(call);

        expect(gateChecks(lifecycle.assertActorMay)).toEqual([[GRANTED_ACTOR, appUrn, 'configure', undefined]]);
        expect(service()).toHaveBeenCalled();
      });
    });
  });
});
