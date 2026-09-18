import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import { EnvUtils } from '@/modules/env/env.utils';
import type { AppUrn } from '@ci-hub/common/types';
import type { AppLifecycleService } from '../app-lifecycle.service';
import { DeviceKeyRefreshService } from '../device-key-refresh.service';

const MEMORY = 'ci-memory:ci-marketplace' as AppUrn;
const N8N = 'n8n:ci-marketplace' as AppUrn;

/*
 * Pairing issues a new Portal device key, and Memory gets it as `HUB_API_KEY` only when its env is
 * generated. Nothing regenerated it after a re-pair, so a Memory that stayed installed kept calling the
 * Portal with the key the pairing had replaced.
 */
describe('DeviceKeyRefreshService', () => {
  let apps: MockProxy<AppsRepository>;
  let files: MockProxy<AppFilesManager>;
  let lifecycle: MockProxy<AppLifecycleService>;
  let deviceKey: string | null;
  let envs: Record<string, string>;
  let service: DeviceKeyRefreshService;

  const row = (urn: AppUrn, status: string) => {
    const [appName, appStoreSlug] = urn.split(':');
    return { appName, appStoreSlug, status } as never;
  };

  beforeEach(() => {
    deviceKey = 'new-device-key';
    envs = { [MEMORY]: 'HUB_DEVICE_ID=device\nHUB_API_KEY=old-device-key', [N8N]: 'APP_PORT=5678' };

    apps = mock<AppsRepository>();
    apps.getApps.mockResolvedValue([row(MEMORY, 'running'), row(N8N, 'running')]);
    files = mock<AppFilesManager>();
    files.getInstalledAppInfo.mockImplementation(async (urn) => ({ id: urn.split(':')[0], urn }) as never);
    files.getAppEnv.mockImplementation(async (urn) => ({ path: `/app-data/${urn}/app.env`, content: envs[urn] ?? '' }));
    lifecycle = mock<AppLifecycleService>();
    lifecycle.restartApp.mockResolvedValue({ requestId: 'r' });
    lifecycle.regenerateAppEnv.mockResolvedValue(true);

    service = new DeviceKeyRefreshService(
      mock<LoggerService>(),
      { getConfig: () => ({ ciHubApiKey: deviceKey }) } as unknown as ConfigurationService,
      apps,
      files,
      new EnvUtils(),
      lifecycle,
    );
  });

  it('restarts a running Memory that holds another device key, and nothing else', async () => {
    await expect(service.refreshStaleDeviceKeys()).resolves.toEqual([MEMORY]);

    expect(lifecycle.restartApp).toHaveBeenCalledTimes(1);
    expect(lifecycle.restartApp).toHaveBeenCalledWith({ appUrn: MEMORY, skipPull: true, actor: { kind: 'system', reason: 'device-key-refresh' } });
    expect(lifecycle.regenerateAppEnv).not.toHaveBeenCalled();
  });

  it('rewrites the env of a stopped Memory without starting it', async () => {
    apps.getApps.mockResolvedValue([row(MEMORY, 'stopped')]);

    await expect(service.refreshStaleDeviceKeys()).resolves.toEqual([MEMORY]);

    expect(lifecycle.regenerateAppEnv).toHaveBeenCalledWith(MEMORY);
    expect(lifecycle.restartApp).not.toHaveBeenCalled();
  });

  it('refreshes a Memory whose key was cleared when local setup was reset', async () => {
    envs[MEMORY] = 'HUB_DEVICE_ID=device';

    await expect(service.refreshStaleDeviceKeys()).resolves.toEqual([MEMORY]);
  });

  it('leaves a Memory that already holds the current key alone', async () => {
    envs[MEMORY] = 'HUB_API_KEY=new-device-key';

    await expect(service.refreshStaleDeviceKeys()).resolves.toEqual([]);

    expect(lifecycle.restartApp).not.toHaveBeenCalled();
  });

  it('leaves a Memory with an operation under way to it', async () => {
    apps.getApps.mockResolvedValue([row(MEMORY, 'installing')]);

    await expect(service.refreshStaleDeviceKeys()).resolves.toEqual([]);

    expect(files.getAppEnv).not.toHaveBeenCalled();
  });

  it('does nothing on a Hub with no device key', async () => {
    deviceKey = null;

    await expect(service.refreshStaleDeviceKeys()).resolves.toEqual([]);

    expect(apps.getApps).not.toHaveBeenCalled();
  });

  it('does not restart Memory again for a key it was already handed, but does for the next one', async () => {
    await service.refreshStaleDeviceKeys();
    await service.refreshStaleDeviceKeys();
    expect(lifecycle.restartApp).toHaveBeenCalledTimes(1);

    deviceKey = 'third-device-key';
    await service.refreshStaleDeviceKeys();
    expect(lifecycle.restartApp).toHaveBeenCalledTimes(2);
  });
});
