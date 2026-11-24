import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { UserConfigController } from '../user-config.controller';
import { UserConfigService } from '../user-config.service';

describe('UserConfigController', () => {
  const req = { hubPrincipal: 'session', user: { id: 7 } } as unknown as Request;

  let controller: UserConfigController;
  let userConfigService: MockProxy<UserConfigService>;
  let whois: MockProxy<MarketplaceWhoIsService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UserConfigController],
      providers: [
        { provide: UserConfigService, useValue: mock<UserConfigService>() },
        { provide: MarketplaceWhoIsService, useValue: mock<MarketplaceWhoIsService>() },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: vi.fn().mockReturnValue(true) })
      .compile();

    controller = moduleRef.get(UserConfigController);
    userConfigService = moduleRef.get(UserConfigService);
    whois = moduleRef.get(MarketplaceWhoIsService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getUserConfig', () => {
    it('should return user config for an app', async () => {
      const config = { exposed: false, domain: null, openPort: null };
      userConfigService.getUserConfig.mockResolvedValue(config as any);

      const result = await controller.getUserConfig('my-app:my-store', req);
      expect(result).toBeDefined();
      expect(userConfigService.getUserConfig).toHaveBeenCalled();
    });
  });

  describe('updateUserConfig', () => {
    it('should update user config', async () => {
      userConfigService.updateUserConfig.mockResolvedValue(undefined);

      await controller.updateUserConfig('my-app:my-store', { exposed: true } as any, req);
      expect(userConfigService.updateUserConfig).toHaveBeenCalled();
    });
  });

  describe('enableUserConfig', () => {
    it('should enable user config', async () => {
      userConfigService.enableUserConfig.mockResolvedValue(undefined as any);

      await controller.enableUserConfig('my-app:my-store', req);
      expect(userConfigService.enableUserConfig).toHaveBeenCalled();
    });
  });

  describe('disableUserConfig', () => {
    it('should disable user config', async () => {
      userConfigService.disableUserConfig.mockResolvedValue(undefined as any);

      await controller.disableUserConfig('my-app:my-store', req);
      expect(userConfigService.disableUserConfig).toHaveBeenCalled();
    });
  });

  /*
   * These routes read and write an app's compose override and env values. They asked for nothing but
   * a sign-in while their MCP tools asked for the app's grant; now they assert the same verbs.
   */
  describe('the grant each route asserts', () => {
    const routes = [
      ['getUserConfig', 'view', (c: UserConfigController, urn: string) => c.getUserConfig(urn, req)],
      [
        'updateUserConfig',
        'configure',
        (c: UserConfigController, urn: string) => c.updateUserConfig(urn, { dockerCompose: '', appEnv: '' } as never, req),
      ],
      ['enableUserConfig', 'configure', (c: UserConfigController, urn: string) => c.enableUserConfig(urn, req)],
      ['disableUserConfig', 'configure', (c: UserConfigController, urn: string) => c.disableUserConfig(urn, req)],
    ] as const;

    it.each(routes)('%s asserts %s on a catalog app', async (_method, action, route) => {
      await route(controller, 'immich:ci-marketplace');

      expect(whois.assertSessionAction).toHaveBeenCalledWith(req, 'immich:ci-marketplace', action);
    });

    it.each(routes)('%s asserts configure on a custom app, whose env values are for its owners and admins', async (_method, _action, route) => {
      await route(controller, 'my-compose:_user');

      expect(whois.assertSessionAction).toHaveBeenCalledWith(req, 'my-compose:_user', 'configure');
    });

    it.each(routes)('%s reads or writes nothing when the grant is refused', async (method, _action, route) => {
      whois.assertSessionAction.mockRejectedValue(new Error('APP_ACTION_GRANT_DENIED'));

      await expect(route(controller, 'immich:ci-marketplace')).rejects.toThrow('APP_ACTION_GRANT_DENIED');
      expect(userConfigService[method]).not.toHaveBeenCalled();
    });
  });
});
