import path from 'node:path';
import { vol } from 'memfs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { CacheService } from '@/core/cache/cache.service';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { PortalClientService } from '@/core/portal/portal-client.service';
import type { AppRehydrationService } from '@/modules/app-lifecycle/app-rehydration.service';
import type { DeviceKeyRefreshService } from '@/modules/app-lifecycle/device-key-refresh.service';
import type { ExposureSyncService } from '@/modules/app-lifecycle/exposure-sync.service';
import { PairingAppRestoreService } from '@/modules/app-lifecycle/pairing-app-restore.service';
import type { PairingAppCheckFile } from '@/modules/app-lifecycle/registration-recovery-state';
import type { AppStoreRepository } from '@/modules/app-stores/app-store.repository';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import type { ReposHelpers } from '@/modules/app-stores/repos.helpers';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import type { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { MarketplaceCacheBus } from '@/modules/marketplace/marketplace-cache.bus';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import type { PortalCatalogService } from '@/core/portal/portal-catalog.service';
import type { RepoEventsQueue } from '@/modules/queue/entities/repo-events';
import type { RegistrationService } from '@/modules/registration/registration.service';
import { FactoryResetService } from '../factory-reset.service';

/** The recovery state files, in memory: they are written with `node:fs/promises`, which memfs does not cover. */
const recovery = vi.hoisted(() => ({
  check: null as PairingAppCheckFile | null,
  restoreIntent: false,
  rehydration: null as { completedAt: string } | null,
}));

vi.mock('@/modules/app-lifecycle/registration-recovery-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/app-lifecycle/registration-recovery-state')>()),
  clearRegistrationRecoveryArtifacts: vi.fn(async () => {
    recovery.restoreIntent = false;
    recovery.rehydration = null;
  }),
  readPairingAppCheck: vi.fn(async () => recovery.check),
  writePairingAppCheck: vi.fn(async (check?: PairingAppCheckFile) => {
    recovery.check = check ?? { markedAt: new Date().toISOString() };
  }),
  clearPairingAppCheck: vi.fn(async () => {
    recovery.check = null;
  }),
  hasRestoreIntent: vi.fn(async () => recovery.restoreIntent),
  writeRestoreIntent: vi.fn(async () => {
    recovery.restoreIntent = true;
  }),
  clearRestoreIntent: vi.fn(async () => {
    recovery.restoreIntent = false;
  }),
  readRehydrationState: vi.fn(async () => recovery.rehydration),
  startRestoreNotice: vi.fn(async () => undefined),
}));
vi.mock('@/modules/app-lifecycle/commands/uninstall-app-command', () => ({ UninstallAppCommand: class {} }));

const PORTAL = 'https://portal.example.test';
const CLOUD_STORE_URL = `${PORTAL}/api`;

type StoreRow = {
  slug: string;
  hash: string;
  name: string;
  enabled: boolean;
  url: string;
  branch: string;
  type: string | null;
  createdAt: string;
  updatedAt: string;
};

/** `app_store`, in memory, with the calls `AppStoreService` makes on it. */
class StoreTable {
  readonly rows = new Map<string, StoreRow>();

  add(row: Partial<StoreRow> & Pick<StoreRow, 'slug' | 'url'>): void {
    this.rows.set(row.slug, {
      hash: `hash-${row.url}`,
      name: row.slug,
      enabled: true,
      branch: 'main',
      type: 'git',
      createdAt: '',
      updatedAt: '',
      ...row,
    });
  }

  repository(): AppStoreRepository {
    return {
      getAppStoreBySlug: async (slug: string) => this.rows.get(slug),
      createAppStore: async (data: Omit<StoreRow, 'hash' | 'branch' | 'createdAt' | 'updatedAt'>) => {
        this.add({ ...data });
        return this.rows.get(data.slug);
      },
      updateAppStoreHashAndUrl: async (slug: string, data: { hash: string; url: string }) => {
        const row = this.rows.get(slug);
        if (row) Object.assign(row, data);
      },
      updateAppStoreType: async (slug: string, type: string) => {
        const row = this.rows.get(slug);
        if (row) row.type = type;
      },
      getEnabledAppStores: async () => [...this.rows.values()].filter((row) => row.enabled),
      getAllAppStores: async () => [...this.rows.values()],
    } as unknown as AppStoreRepository;
  }
}

/** What each store's catalog download writes under `repos/`. */
const CATALOGS: Record<string, string[]> = { 'ci-marketplace': ['cyberchef', 'kimai'], 'my-store': ['my-wiki'] };

const writeCatalog = (slug: string) => {
  for (const app of CATALOGS[slug] ?? []) {
    const file = path.join('/data', 'repos', slug, 'apps', app, 'config.json');
    vol.mkdirSync(path.dirname(file), { recursive: true });
    vol.writeFileSync(file, JSON.stringify({ id: app }));
  }
};

/**
 * One Hub process: the real factory reset, app store and marketplace services and the real restore that
 * follows a pairing, over an in-memory `app_store` and the suite's memfs disk. Portal lists two apps for
 * the device. The restore installs them once the catalog lists them, which is what the real one needs.
 */
function hub() {
  const logger = mock<LoggerService>();
  const table = new StoreTable();
  table.add({ slug: 'ci-marketplace', url: CLOUD_STORE_URL, type: 'ci_cloud_api' });
  table.add({ slug: 'my-store', url: 'https://git.example.test/my-store.git' });
  writeCatalog('ci-marketplace');
  writeCatalog('my-store');

  const pulls: string[] = [];
  const repoHelpers = {
    getRepoHash: (url: string) => `hash-${url}`,
    pullRepo: vi.fn(async (_url: string, slug: string) => {
      pulls.push(slug);
      writeCatalog(slug);
      return { success: true, message: 'pulled' };
    }),
  } as unknown as ReposHelpers;
  const configuration = Object.assign(Object.create(ConfigurationService.prototype) as ConfigurationService, {
    logger,
    config: { demoMode: false, rootFolderHost: '/opt/ci-hub', directories: { dataDir: '/data' }, userSettings: {}, ciCloudUrl: PORTAL },
  });
  const cacheBus = new MarketplaceCacheBus();
  const appStores = new AppStoreService(
    logger,
    { onEvent: vi.fn() } as unknown as RepoEventsQueue,
    repoHelpers,
    configuration,
    table.repository(),
    mock<PortalClientService>(),
    cacheBus,
  );
  const filesystem = new FilesystemService(logger);
  const marketplace = new MarketplaceService(configuration, filesystem, logger, mock<PortalCatalogService>(), appStores, cacheBus);

  const registration = mock<RegistrationService>();
  registration.resetRegistration.mockResolvedValue(undefined);
  const providers = new Map<unknown, unknown>([
    [AppStoreService, appStores],
    [MarketplaceService, marketplace],
  ]);
  const reset = new FactoryResetService(
    { execute: vi.fn(async () => table.rows.clear()), query: { app: { findMany: async () => [] } } } as never,
    {} as never,
    { get: (token: unknown) => providers.get(token) } as never,
    filesystem,
    configuration,
    mock<CacheService>(),
    new SessionUserCache(),
    logger,
    registration,
  );

  // After the next pairing: registered, with the new device key, on a device that lists two apps.
  const installed: Array<{ appName: string; appStoreSlug: string; status: string }> = [];
  const apps = mock<AppsRepository>();
  apps.getApps.mockImplementation(async () => installed as never);
  const restoreRegistration = mock<RegistrationService>();
  restoreRegistration.getLiveRegistrationStatus.mockResolvedValue({ phase: 'publicly_ready' } as never);
  const cloudflare = mock<CloudflareClientService>();
  cloudflare.getDeviceApplications.mockResolvedValue(
    ['cyberchef', 'kimai'].map((name) => ({ id: `id-${name}`, name, slug: name, port: 80, publicDomain: null })) as never,
  );
  const rehydration = mock<AppRehydrationService>();
  rehydration.executeRehydrate.mockImplementation(async () => {
    const available = await marketplace.getAvailableAppUrns();
    const missing = ['cyberchef', 'kimai'].filter((name) => !available.includes(`${name}:ci-marketplace` as never));
    if (missing.length > 0) {
      throw new Error('CI Portal lists 2 app(s) for this device, but the app catalog has not been downloaded yet');
    }
    installed.push(...['cyberchef', 'kimai'].map((appName) => ({ appName, appStoreSlug: 'ci-marketplace', status: 'running' })));
    recovery.rehydration = { completedAt: new Date().toISOString() };
    return { success: true, message: 'Queued 2 install(s)', incomplete: false, queued: [], started: [], skipped: [] } as never;
  });
  const keyRefresh = mock<DeviceKeyRefreshService>();
  keyRefresh.refreshStaleDeviceKeys.mockResolvedValue([]);
  const exposureSync = mock<ExposureSyncService>();
  exposureSync.syncExposurePublic.mockResolvedValue(undefined);
  const restore = new PairingAppRestoreService(
    logger,
    { getConfig: () => ({ ciHubApiKey: 'new-device-key' }) } as unknown as ConfigurationService,
    restoreRegistration,
    cloudflare,
    apps,
    marketplace,
    appStores,
    rehydration,
    exposureSync,
    keyRefresh,
  );

  return { reset, restore, table, marketplace, pulls, installed, logger };
}

/** Lets the downloads the reset and the restore start in the background finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('FactoryResetService: the app stores', () => {
  beforeEach(() => {
    recovery.check = null;
    recovery.restoreIntent = false;
    recovery.rehydration = null;
  });

  // Boot is the only thing that writes the CI Marketplace row. The reset emptied the table, so nothing
  // downloaded a catalog until the Hub restarted.
  it('leaves the CI Marketplace store registered and enabled and downloads its catalog again', async () => {
    const { reset, table, marketplace, pulls } = hub();
    await marketplace.initialize();

    await reset.execute();
    await settle();

    expect([...table.rows.values()]).toEqual([
      expect.objectContaining({ slug: 'ci-marketplace', url: CLOUD_STORE_URL, type: 'ci_cloud_api', enabled: true }),
    ]);
    expect(pulls).toEqual(['ci-marketplace']);
    await expect(marketplace.getAvailableAppUrns()).resolves.toEqual(['cyberchef:ci-marketplace', 'kimai:ci-marketplace']);
  });

  it('still removes a store a person added, from the table and from the marketplace', async () => {
    const { reset, table, marketplace } = hub();
    await marketplace.initialize();
    await expect(marketplace.getAvailableAppUrns()).resolves.toContain('my-wiki:my-store');

    await reset.execute();
    await settle();

    expect(table.rows.has('my-store')).toBe(false);
    await expect(marketplace.getAvailableAppUrns()).resolves.not.toContain('my-wiki:my-store');
    expect(vol.existsSync(path.join('/data', 'repos', 'my-store'))).toBe(false);
  });

  // The restore after pairing again waited for the catalog for good: "App sync stays held because the apps
  // could not be restored: CI Portal lists 2 app(s) for this device, but the app catalog has not been
  // downloaded yet", until the Hub restarted.
  it('restores the apps after the next pairing, with no restart', async () => {
    const { reset, restore, marketplace, installed } = hub();
    await marketplace.initialize();
    await reset.execute();
    await settle();

    // Pairing again leaves the apps check, as `RegistrationService` does.
    recovery.check = { markedAt: new Date().toISOString() };
    let outcome = await restore.runCheck();
    for (let pass = 0; pass < 3 && outcome !== 'released'; pass++) {
      // A pass that found no catalog started a download and backs off. Let both run out.
      await settle();
      vi.spyOn(Date, 'now').mockReturnValueOnce(Date.now() + 10 * 60_000);
      outcome = await restore.runCheck();
    }

    expect(outcome).toBe('released');
    expect(installed.map((app) => app.appName)).toEqual(['cyberchef', 'kimai']);
  });
});
