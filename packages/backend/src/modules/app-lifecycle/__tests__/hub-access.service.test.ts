import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import { type MockProxy, mock } from 'vitest-mock-extended';
import type { AppUrn } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { EnvUtils } from '@/modules/env/env.utils';
import { AppLifecycleService } from '../app-lifecycle.service';
import { HubAccessService } from '../hub-access.service';

/** Per-app operator surface for Hub trust material: status view + the rotation lever (#74). */
describe('HubAccessService', () => {
  let service: HubAccessService;
  let apiKeys: MockProxy<ApiKeyService>;
  let appFilesManager: MockProxy<AppFilesManager>;
  let appLifecycle: MockProxy<AppLifecycleService>;

  const urn = 'importer:ci-marketplace' as AppUrn;
  const managedKey = fromPartial<Awaited<ReturnType<ApiKeyService['list']>>[number]>({
    id: 3,
    prefix: 'abcd1234',
    scopes: ['app'],
    managed: true,
    ownerAppUrn: urn,
    lastUsedAt: '2026-07-20T00:00:00Z',
    createdAt: '2026-07-01T00:00:00Z',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    apiKeys = mock<ApiKeyService>();
    appFilesManager = mock<AppFilesManager>();
    appLifecycle = mock<AppLifecycleService>();
    service = new HubAccessService(apiKeys, appFilesManager, appLifecycle, new EnvUtils(), mock<LoggerService>());

    appFilesManager.getInstalledAppInfo.mockResolvedValue(
      fromPartial({ urn, hub_integration: { memory: { url_env: 'CI_SERVER_URL', token_env: 'CI_SERVER_TOKEN' } } }),
    );
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/x', content: 'CI_HUB_FORWARD_AUTH_SECRET=s3cret\nOTHER=1\n' });
    apiKeys.list.mockResolvedValue([managedKey]);
    appLifecycle.restartApp.mockResolvedValue({ requestId: 'req-1' });
  });

  describe('getStatus', () => {
    it("reports the app's key metadata (never raw values) + identity verification + provisioning eligibility", async () => {
      const status = await service.getStatus(urn);
      expect(status).toEqual({
        appKey: { prefix: 'abcd1234', scopes: ['app'], lastUsedAt: '2026-07-20T00:00:00Z', createdAt: '2026-07-01T00:00:00Z' },
        identityVerification: true,
        provisioned: true,
      });
      // Nothing resembling a secret escapes: the serialized status contains no raw key or secret.
      expect(JSON.stringify(status)).not.toContain('s3cret');
    });

    it('reports null key + no identity verification for an unprovisioned app', async () => {
      apiKeys.list.mockResolvedValue([]);
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/x', content: '' });
      appFilesManager.getInstalledAppInfo.mockResolvedValue(fromPartial({ urn, hub_integration: undefined }));
      const status = await service.getStatus(urn);
      expect(status).toEqual({ appKey: null, identityVerification: false, provisioned: false });
    });

    it('404s for an unknown app', async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue(null as never);
      await expect(service.getStatus(urn)).rejects.toThrow(NotFoundException);
    });
  });

  describe('rotate', () => {
    it('revokes the managed key, clears the forward-auth secret from app.env, and restarts the app', async () => {
      const res = await service.rotate(urn);

      expect(apiKeys.revokeManagedByApp).toHaveBeenCalledWith(urn);
      // The secret is removed so the next env generation's preserve-or-mint finds
      // nothing to preserve and mints fresh; other vars survive untouched.
      const written = appFilesManager.writeAppEnv.mock.calls[0]?.[1] as string;
      expect(written).not.toContain('CI_HUB_FORWARD_AUTH_SECRET');
      expect(written).toContain('OTHER=1');
      // The restart is what regenerates env + reloads the container in one event.
      expect(appLifecycle.restartApp).toHaveBeenCalledWith({ appUrn: urn });
      expect(res).toEqual({ requestId: 'req-1' });
    });

    it('skips the env write when no secret is present, but still revokes and restarts', async () => {
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/x', content: 'OTHER=1\n' });
      await service.rotate(urn);
      expect(appFilesManager.writeAppEnv).not.toHaveBeenCalled();
      expect(apiKeys.revokeManagedByApp).toHaveBeenCalled();
      expect(appLifecycle.restartApp).toHaveBeenCalled();
    });

    it('404s for an unknown app without revoking anything', async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue(null as never);
      await expect(service.rotate(urn)).rejects.toThrow(NotFoundException);
      expect(apiKeys.revokeManagedByApp).not.toHaveBeenCalled();
    });
  });
});
