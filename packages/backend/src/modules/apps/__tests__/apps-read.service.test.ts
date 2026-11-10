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
import { LifecycleJobService } from '../../app-lifecycle/lifecycle-job.service';
import { ExposureSyncService } from '../../app-lifecycle/exposure-sync.service';
import { RegistrationService } from '../../registration/registration.service';
import type { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';

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

describe('AppsReadService.getApp failure', () => {
  const appUrn = 'ci-memory:ci-marketplace' as AppUrn;
  const serviceFailure = { kind: 'restarting', service: 'summary-service', exitCode: 126 };

  const failedAt = '2026-11-02T10:00:00.000Z';
  let jobService: ReturnType<typeof mock<LifecycleJobService>>;

  function build(status: string, jobs: unknown[], updatedAt = '2026-11-02T10:00:01.000Z') {
    const appsRepository = mock<AppsRepository>();
    const appFilesManager = mock<AppFilesManager>();
    const marketplaceService = mock<MarketplaceService>();
    jobService = mock<LifecycleJobService>();
    const moduleRef = mock<ModuleRef>();
    appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status, updatedAt } as never);
    appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'ci-memory' } as never);
    appFilesManager.getUserComposeFile.mockResolvedValue({ content: null } as never);
    appFilesManager.getUserEnv.mockResolvedValue({ content: null } as never);
    appFilesManager.getDockerComposeJson.mockResolvedValue({ content: null } as never);
    marketplaceService.getAppUpdateInfo.mockResolvedValue({ latestVersion: 1, latestDockerVersion: '1' } as never);
    marketplaceService.resolveAppDescription.mockResolvedValue({ id: 'ci-memory' } as never);
    jobService.listJobs.mockImplementation((async ({ excludeOperations = [], limit }: { excludeOperations?: string[]; limit?: number }) =>
      (jobs as Array<{ operation?: string }>)
        .filter(({ operation }) => !operation || !excludeOperations.includes(operation))
        .slice(0, limit)) as never);
    moduleRef.get.mockImplementation(((token: unknown) => (token === LifecycleJobService ? jobService : undefined)) as never);
    const portAllocationRepository = mock<PortAllocationRepository>();
    portAllocationRepository.getByAppUrn.mockResolvedValue([] as never);
    const configurationService = mock<ConfigurationService>();
    configurationService.getConfig.mockReturnValue({ userSettings: {} } as never);
    return new AppsReadService(
      appsRepository,
      appFilesManager,
      mock<LoggerService>(),
      marketplaceService,
      configurationService,
      portAllocationRepository,
      mock<InstallPipelineTracker>(),
      moduleRef,
    );
  }

  const failedJob = (failure: unknown, error = 'summary-service keeps restarting (exit 126)') => ({
    status: 'failed',
    error,
    finishedAt: failedAt,
    metadata: { failure },
  });

  it('gives a failed install the reason its last job recorded, so a reload does not lose it', async () => {
    const service = build('install_failed', [failedJob({ errorDetail: 'logs', serviceFailure })]);

    await expect(service.getApp(appUrn)).resolves.toMatchObject({
      failure: { message: 'summary-service keeps restarting (exit 126)', errorDetail: 'logs', serviceFailure },
    });
  });

  it('keeps any reason for a failed install, not only a crash', async () => {
    const service = build('install_failed', [failedJob({ errorCode: 'network_overlap' }, 'App network range conflict')]);

    await expect(service.getApp(appUrn)).resolves.toMatchObject({ failure: { message: 'App network range conflict', errorCode: 'network_overlap' } });
  });

  it('gives a stopped app the reason when its containers did not come up', async () => {
    const service = build('stopped', [failedJob({ serviceFailure })]);

    await expect(service.getApp(appUrn)).resolves.toMatchObject({ failure: { serviceFailure } });
  });

  it('gives a stopped app no reason for any other failed start, which its toast told', async () => {
    const service = build('stopped', [failedJob({ errorCode: undefined }, 'address already in use')]);

    await expect(service.getApp(appUrn)).resolves.toMatchObject({ failure: null });
  });

  it('gives a stopped app no reason when its row moved on long after the job, as when the sync brought it back and it stopped again', async () => {
    const service = build('stopped', [failedJob({ serviceFailure })], '2026-11-05T08:00:00.000Z');

    await expect(service.getApp(appUrn)).resolves.toMatchObject({ failure: null });
  });

  it('keeps the reason of a failed install however long ago it failed', async () => {
    const service = build('install_failed', [failedJob({ serviceFailure })], '2026-11-05T08:00:00.000Z');

    await expect(service.getApp(appUrn)).resolves.toMatchObject({ failure: { serviceFailure } });
  });

  it('gives no reason once a later job went fine, such as a Stop', async () => {
    const service = build('stopped', [{ status: 'completed', error: null, metadata: {} }]);

    await expect(service.getApp(appUrn)).resolves.toMatchObject({ failure: null });
  });

  it('keeps the reason past a backup or an env rewrite and never gives their failure as the reason', async () => {
    const serviceFailure = { kind: 'exited', service: 'migrate', exitCode: 1 };
    const service = build('stopped', [
      { operation: 'generate_env', status: 'failed', error: 'Could not write app.env', metadata: { failure: {} } },
      { operation: 'backup', status: 'completed', error: null, metadata: {} },
      { operation: 'start', ...failedJob({ serviceFailure }, 'migrate exited (exit 1)') },
    ]);

    await expect(service.getApp(appUrn)).resolves.toMatchObject({ failure: { message: 'migrate exited (exit 1)', serviceFailure } });
  });

  it('never shows the stack trace of a job that threw', async () => {
    const service = build('install_failed', [{ status: 'failed', error: 'Error: boom\n    at foo.ts:1', metadata: {} }]);

    await expect(service.getApp(appUrn)).resolves.toMatchObject({ failure: null });
  });

  it('gives a running app no reason and does not read its jobs', async () => {
    const service = build('running', [failedJob({ serviceFailure })]);

    await expect(service.getApp(appUrn)).resolves.toMatchObject({ failure: null });
    expect(jobService.listJobs).not.toHaveBeenCalled();
  });
});

describe('AppsReadService.getGuestDashboardApps', () => {
  const row = {
    id: 3,
    appName: 'jellyfin',
    appStoreSlug: 'ci-marketplace',
    localSubdomain: 'jellyfin',
    exposureMode: 'cloudflare',
    exposedLocal: true,
  };
  const urn = 'jellyfin:ci-marketplace';

  function build(
    options: {
      refused?: string[];
      registration?: () => Promise<unknown>;
      guestDashboard?: boolean;
      registrationMissing?: boolean;
      customDomain?: string;
      settingsDomain?: string;
    } = {},
  ) {
    const appsRepository = mock<AppsRepository>();
    appsRepository.getGuestDashboardApps.mockResolvedValue([{ ...row, customDomain: options.customDomain ?? null }] as never);
    const appFilesManager = mock<AppFilesManager>();
    appFilesManager.getInstalledAppInfo.mockResolvedValue({ urn, exposable: true } as never);
    appFilesManager.getDockerComposeJson.mockResolvedValue({ content: null } as never);
    const marketplaceService = mock<MarketplaceService>();
    marketplaceService.getAppUpdateInfo.mockResolvedValue({ latestVersion: 1, latestDockerVersion: '1', minHubVersion: null } as never);
    const configurationService = mock<ConfigurationService>();
    configurationService.getConfig.mockReturnValue({
      domain: 'paired.example',
      userSettings: { domain: options.settingsDomain ?? 'example.com', guestDashboard: options.guestDashboard ?? true },
    } as never);
    const moduleRef = mock<ModuleRef>();
    moduleRef.get.mockImplementation(((token: unknown) => {
      if (token === RegistrationService) {
        if (options.registrationMissing) {
          throw new Error('Nest could not find RegistrationService');
        }
        return {
          getDeviceRegistrationInfo:
            options.registration ?? (async () => ({ slug: 'my-org', hubSubdomain: 'hub-my-device-my-org', tunnelId: 'tunnel-1' })),
        };
      }
      return token === ExposureSyncService
        ? { publicDnsRefusalFor: (appUrn: string) => (options.refused?.includes(appUrn) ? 'subdomain_quota_exceeded' : null) }
        : undefined;
    }) as never);

    return new AppsReadService(
      appsRepository,
      appFilesManager,
      mock<LoggerService>(),
      marketplaceService,
      configurationService,
      mock<PortAllocationRepository>(),
      mock<InstallPipelineTracker>(),
      moduleRef,
    );
  }

  it('gives an app on Public web its public address', async () => {
    const [entry] = await build().getGuestDashboardApps();

    expect(entry?.publicUrl).toBe('https://jellyfin-my-device-my-org.example.com');
  });

  it('gives no address the Portal refused, because no DNS record exists for it', async () => {
    const [entry] = await build({ refused: [urn] }).getGuestDashboardApps();

    expect(entry?.publicUrl).toBeNull();
  });

  it('keeps a custom hostname when the Portal refused the platform name, because it has its own ingress rule', async () => {
    const [entry] = await build({ refused: [urn], customDomain: 'media.example.org' }).getGuestDashboardApps();

    expect(entry?.publicUrl).toBe('https://media.example.org');
  });

  it('uses the domain the Hub paired into when no setting overrides it, as the tunnel sync does', async () => {
    const [entry] = await build({ settingsDomain: '  ' }).getGuestDashboardApps();

    expect(entry?.publicUrl).toBe('https://jellyfin-my-device-my-org.paired.example');
  });

  it('gives no public address on a Hub with no tunnel, because the sync publishes nothing', async () => {
    const [entry] = await build({
      registration: async () => ({ slug: 'my-org', hubSubdomain: 'hub-my-device-my-org', tunnelId: null }),
      customDomain: 'media.example.org',
    }).getGuestDashboardApps();

    expect(entry?.app).toMatchObject({ id: 3 });
    expect(entry?.publicUrl).toBeNull();
  });

  it('gives no public address while the guest dashboard is turned off', async () => {
    const [entry] = await build({ guestDashboard: false }).getGuestDashboardApps();

    expect(entry?.app).toMatchObject({ id: 3 });
    expect(entry?.publicUrl).toBeNull();
  });

  it('still serves the tile when the registration service cannot be resolved', async () => {
    const [entry] = await build({ registrationMissing: true }).getGuestDashboardApps();

    expect(entry?.app).toMatchObject({ id: 3 });
    expect(entry?.publicUrl).toBeNull();
  });

  it('still serves the tile when the registration cannot be read', async () => {
    const [entry] = await build({ registration: () => Promise.reject(new Error('database down')) }).getGuestDashboardApps();

    expect(entry?.app).toMatchObject({ id: 3 });
    expect(entry?.publicUrl).toBeNull();
  });
});
