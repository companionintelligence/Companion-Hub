import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppsReadService } from '../apps-read.service';
import { AppsRepository } from '../apps.repository';
import { AppFilesManager } from '../app-files-manager';
import { LoggerService } from '@/core/logger/logger.service';
import { MarketplaceService } from '../../marketplace/marketplace.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { PortAllocationRepository } from '../../network/port-allocation.repository';
import { InstallPipelineTracker } from '../install-pipeline.tracker';

/**
 * `countUpdatesAvailable` measured live on the fleet: beta-max ran `ci-openclaw` `2026.9.14` while the
 * marketplace catalog was already at `2026.9.21.1`, and `/api/apps/updates-available` reported 0.
 *
 * The reason: `app.version` / `updateInfo.latestVersion` are `cihub_app_version`, a manifest/catalog
 * schema-revision counter (`z.number().default(1)`) that no CI-OpenClaw or CI-Hermes config sets, so it
 * reads 1 on both the installed row and the catalog forever. The actual product release lives in
 * `updateInfo.latestDockerVersion` — a date-shaped string the old code never looked at.
 */
function buildApp(over: Partial<{ status: string; version: number; ignoredVersion: number | null; appName: string; appStoreSlug: string }> = {}) {
  return {
    id: 'app-1',
    appName: 'ci-openclaw',
    appStoreSlug: 'ci-marketplace',
    status: 'running',
    version: 1,
    ...over,
  } as unknown as Awaited<ReturnType<AppsRepository['getApps']>>[number];
}

describe('AppsReadService.countUpdatesAvailable', () => {
  function build() {
    const appsRepository = mock<AppsRepository>();
    const appFilesManager = mock<AppFilesManager>();
    const logger = mock<LoggerService>();
    const marketplaceService = mock<MarketplaceService>();
    const configurationService = mock<ConfigurationService>();
    const portAllocationRepository = mock<PortAllocationRepository>();
    const installPipelineTracker = mock<InstallPipelineTracker>();
    const service = new AppsReadService(
      appsRepository,
      appFilesManager,
      logger,
      marketplaceService,
      configurationService,
      portAllocationRepository,
      installPipelineTracker,
    );
    return { service, appsRepository, appFilesManager, marketplaceService };
  }

  it('beta-max, measured: same schema counter (1), different docker tag — an update IS available', async () => {
    const { service, appsRepository, appFilesManager, marketplaceService } = build();
    appsRepository.getApps.mockResolvedValue([buildApp()]);
    marketplaceService.getAppUpdateInfo.mockResolvedValue({
      latestVersion: 1,
      latestDockerVersion: '2026.9.21.1',
      minHubVersion: null,
    } as any);
    appFilesManager.getInstalledAppInfo.mockResolvedValue({ version: '2026.9.14' } as any);

    await expect(service.countUpdatesAvailable()).resolves.toBe(1);
  });

  it('does not flag an update when the installed and catalog docker versions match', async () => {
    const { service, appsRepository, appFilesManager, marketplaceService } = build();
    appsRepository.getApps.mockResolvedValue([buildApp()]);
    marketplaceService.getAppUpdateInfo.mockResolvedValue({
      latestVersion: 1,
      latestDockerVersion: '2026.9.21.1',
      minHubVersion: null,
    } as any);
    appFilesManager.getInstalledAppInfo.mockResolvedValue({ version: '2026.9.21.1' } as any);

    await expect(service.countUpdatesAvailable()).resolves.toBe(0);
  });

  it('a schema-counter bump alone still counts, with no docker version change at all', async () => {
    const { service, appsRepository, appFilesManager, marketplaceService } = build();
    appsRepository.getApps.mockResolvedValue([buildApp({ version: 1 })]);
    marketplaceService.getAppUpdateInfo.mockResolvedValue({
      latestVersion: 2,
      latestDockerVersion: '2026.9.14',
      minHubVersion: null,
    } as any);
    appFilesManager.getInstalledAppInfo.mockResolvedValue({ version: '2026.9.14' } as any);

    await expect(service.countUpdatesAvailable()).resolves.toBe(1);
  });

  it('an unreadable installed config does not crash the count, and reports no update for that app', async () => {
    const { service, appsRepository, appFilesManager, marketplaceService } = build();
    appsRepository.getApps.mockResolvedValue([buildApp()]);
    marketplaceService.getAppUpdateInfo.mockResolvedValue({
      latestVersion: 1,
      latestDockerVersion: '2026.9.21.1',
      minHubVersion: null,
    } as any);
    appFilesManager.getInstalledAppInfo.mockRejectedValue(new Error('ENOENT'));

    await expect(service.countUpdatesAvailable()).resolves.toBe(0);
  });

  it('does not count a schema-counter bump the operator ignored', async () => {
    const { service, appsRepository, appFilesManager, marketplaceService } = build();
    appsRepository.getApps.mockResolvedValue([buildApp({ version: 1, ignoredVersion: 2 })]);
    marketplaceService.getAppUpdateInfo.mockResolvedValue({ latestVersion: 2, latestDockerVersion: '2026.9.14', minHubVersion: null } as any);
    appFilesManager.getInstalledAppInfo.mockResolvedValue({ version: '2026.9.14' } as any);

    await expect(service.countUpdatesAvailable()).resolves.toBe(0);
  });

  it('counts an image bump even when the counter bump was ignored', async () => {
    const { service, appsRepository, appFilesManager, marketplaceService } = build();
    appsRepository.getApps.mockResolvedValue([buildApp({ version: 1, ignoredVersion: 2 })]);
    marketplaceService.getAppUpdateInfo.mockResolvedValue({ latestVersion: 2, latestDockerVersion: '2026.9.21.1', minHubVersion: null } as any);
    appFilesManager.getInstalledAppInfo.mockResolvedValue({ version: '2026.9.14' } as any);

    await expect(service.countUpdatesAvailable()).resolves.toBe(1);
  });

  it('an app mid-update is never counted', async () => {
    const { service, appsRepository, appFilesManager, marketplaceService } = build();
    appsRepository.getApps.mockResolvedValue([buildApp({ status: 'updating' })]);

    await expect(service.countUpdatesAvailable()).resolves.toBe(0);
    expect(marketplaceService.getAppUpdateInfo).not.toHaveBeenCalled();
    expect(appFilesManager.getInstalledAppInfo).not.toHaveBeenCalled();
  });
});
