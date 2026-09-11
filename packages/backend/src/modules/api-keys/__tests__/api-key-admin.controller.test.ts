import type { Request } from 'express';
import { ModuleRef } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { ApiKeyAdminController } from '../api-key-admin.controller';
import { ApiKeyAdminService } from '../api-key-admin.service';

const session = (id = 7) => ({ hubPrincipal: 'session', user: { id } }) as unknown as Request;
const cli = { hubPrincipal: 'cli', user: { id: 1 } } as unknown as Request;
const portalPush = { hubPrincipal: 'portal-device', user: { id: 1 } } as unknown as Request;

describe('ApiKeyAdminController', () => {
  let admin: MockProxy<ApiKeyAdminService>;
  let whois: { isOrgManager: ReturnType<typeof vi.fn> };
  let moduleRef: MockProxy<ModuleRef>;
  let controller: ApiKeyAdminController;

  beforeEach(() => {
    admin = mock<ApiKeyAdminService>();
    whois = { isOrgManager: vi.fn(async () => false) };
    moduleRef = mock<ModuleRef>();
    moduleRef.get.mockImplementation(((token: unknown) => (token === MarketplaceWhoIsService ? whois : undefined)) as never);
    controller = new ApiKeyAdminController(admin, moduleRef);
  });

  /*
   * A key acts with the grants and role of the person who created it, so the
   * route records the signed-in person — and records nobody for a principal with
   * no person behind it, rather than whichever account it happens to carry.
   */
  describe('who created a key', () => {
    it.each([
      ['the signed-in person', session(), 7],
      ['nobody for the CLI', cli, null],
      ['nobody for the Portal device push', portalPush, null],
    ])('records %s', async (_label, req, createdBy) => {
      await controller.createKey({ name: 'n8n', capability: 'write' } as never, req);

      expect(admin.createKey).toHaveBeenCalledWith('n8n', 'write', createdBy);
    });
  });

  /*
   * A key acts with its creator's grants, but `full` also opens the destructive
   * tools no per-app grant stands behind, so handing it out is an organization
   * owner's or admin's call — asked fresh, and a no whenever it cannot be told.
   */
  describe('full capability takes an organization owner or admin', () => {
    it('refuses a member creating a full key, and creates nothing', async () => {
      await expect(controller.createKey({ name: 'n8n', capability: 'full' } as never, session())).rejects.toMatchObject({
        message: 'API_KEY_FULL_ROLE_REQUIRED',
        status: 403,
      });
      expect(whois.isOrgManager).toHaveBeenCalledWith(7);
      expect(admin.createKey).not.toHaveBeenCalled();
    });

    it('lets an owner or admin create one', async () => {
      whois.isOrgManager.mockResolvedValue(true);

      await controller.createKey({ name: 'n8n', capability: 'full' } as never, session());

      expect(admin.createKey).toHaveBeenCalledWith('n8n', 'full', 7);
    });

    it.each([
      ['the CLI', cli],
      ['the Portal device push', portalPush],
    ])('admits %s by name, without asking', async (_label, req) => {
      await controller.createKey({ name: 'n8n', capability: 'full' } as never, req);

      expect(whois.isOrgManager).not.toHaveBeenCalled();
      expect(admin.createKey).toHaveBeenCalled();
    });

    it.each(['read', 'write'] as const)('asks nobody about a %s key', async (capability) => {
      await controller.createKey({ name: 'n8n', capability } as never, session());

      expect(whois.isOrgManager).not.toHaveBeenCalled();
      expect(admin.createKey).toHaveBeenCalled();
    });

    it('refuses a member raising a key to full, and changes nothing', async () => {
      await expect(controller.updateKey(3, { capability: 'full' } as never, session())).rejects.toThrow('API_KEY_FULL_ROLE_REQUIRED');
      expect(admin.setKeyCapability).not.toHaveBeenCalled();
    });

    it('lets anyone tighten a key, without asking', async () => {
      await controller.updateKey(3, { capability: 'read' } as never, session());

      expect(whois.isOrgManager).not.toHaveBeenCalled();
      expect(admin.setKeyCapability).toHaveBeenCalledWith(3, 'read');
    });

    it('refuses when WhoIs cannot be resolved — not knowing is not permission', async () => {
      moduleRef.get.mockImplementation((() => {
        throw new Error('no provider');
      }) as never);

      await expect(controller.createKey({ name: 'n8n', capability: 'full' } as never, session())).rejects.toThrow('API_KEY_FULL_ROLE_REQUIRED');
      expect(admin.createKey).not.toHaveBeenCalled();
    });

    it('refuses a caller with no recognised principal, without asking', async () => {
      const unrecognised = { user: { id: 7 } } as unknown as Request;

      await expect(controller.createKey({ name: 'n8n', capability: 'full' } as never, unrecognised)).rejects.toThrow('API_KEY_FULL_ROLE_REQUIRED');
      expect(whois.isOrgManager).not.toHaveBeenCalled();
    });

    it.each([true, false])('tells the screen whether the caller may give full capability (%s)', async (manager) => {
      whois.isOrgManager.mockResolvedValue(manager);
      admin.listKeys.mockResolvedValue([]);

      await expect(controller.listKeys(session())).resolves.toEqual({ keys: [], canGrantFull: manager });
    });
  });
});
