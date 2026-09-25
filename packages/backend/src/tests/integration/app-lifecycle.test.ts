import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import fs from 'node:fs';
import { APP_DATA_DIR, APP_DIR, DATA_DIR } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DATABASE } from '@/core/database/database.module';
import { DatabaseService } from '@/core/database/database.service';
import { appStore, deviceRegistration as deviceRegistrationTable } from '@/core/database/drizzle/schema';
import { app as appTable } from '@/core/database/drizzle/schema';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
// Import RegistrationService and ReposHelpers BEFORE AppStoreService to avoid circular dependency issues
import { RegistrationService } from '@/modules/registration/registration.service';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { BackupManager } from '@/modules/backups/backup.manager';
import { SSEService } from '@/core/sse/sse.service';
import { ReposHelpers } from '@/modules/app-stores/repos.helpers';
import { AppLifecycleCommandFactory } from '@/modules/app-lifecycle/app-lifecycle-command.factory';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { ExposureSyncService } from '@/modules/app-lifecycle/exposure-sync.service';
import { AppStoreRepository } from '@/modules/app-stores/app-store.repository';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AppsReadService } from '@/modules/apps/apps-read.service';
import { AppsService } from '@/modules/apps/apps.service';
import { AppRuntimeMonitorService } from '@/modules/apps/app-runtime-monitor.service';
import { InstallPipelineTracker } from '@/modules/apps/install-pipeline.tracker';
import { AppOperationRegistry } from '@/modules/app-lifecycle/app-operation-registry';
import { PortAllocationRepository } from '@/modules/network/port-allocation.repository';
import { DOCKERODE } from '@/modules/docker/constants';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import { DockerService } from '@/modules/docker/docker.service';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { MarketplaceCacheBus } from '@/modules/marketplace/marketplace-cache.bus';
import { ImageSizeService } from '@/modules/marketplace/image-size.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import { AppEventsQueue, appEventSchema } from '@/modules/queue/entities/app-events';
import { RepoEventsQueue } from '@/modules/queue/entities/repo-events';
import { QueueFactory } from '@/modules/queue/queue.factory';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { Test } from '@nestjs/testing';
import { fromPartial } from '@total-typescript/shoehorn';
import { eq } from 'drizzle-orm';
import { type MockInstance, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import waitFor from 'wait-for-expect';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import type { FsMock } from '../__mocks__/fs';
import { createAppInStore } from '../utils/create-app-in-store';
import { type TestDatabase, cleanTestData, createTestDatabase } from '../utils/create-test-database';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { InferenceEnvResolver } from '@/modules/inference/inference-env-resolver';
import { CloudFallbackService } from '@/modules/inference/cloud-fallback.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { MemoryConnectionService } from '@/modules/memory-connect/memory-connection.service';
import { PortalCatalogService } from '@/core/portal/portal-catalog.service';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { MarketplaceEntitlementService } from '@/core/portal/marketplace-entitlement.service';

let db: TestDatabase;
const DB_NAME = 'applifecycletest';

function cleanTree(tree: Record<string, string | null>) {
  const newTree: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(tree)) {
    if (value && (key.endsWith('config.json') || key.endsWith('app-data.json'))) {
      try {
        const json = JSON.parse(value);
        if (json.created_at !== undefined) json.created_at = 1769810550000;
        if (json.updated_at !== undefined) json.updated_at = 1769810550000;
        newTree[key] = JSON.stringify(json, null, 2);
      } catch (_e) {
        newTree[key] = value;
      }
    } else if (value && (key.endsWith('docker-compose.yml') || key.endsWith('docker-compose.json'))) {
      // Sanitize subnet to avoid non-determinism in parallel updates
      newTree[key] = value.replace(/subnet: 10\.128\.\d+\.0\/24/g, 'subnet: 10.128.X.0/24');
    } else {
      newTree[key] = value;
    }
  }
  return newTree;
}

/** Install mechanics, not authorization, are under test here — the actor gate is unit-tested in app-lifecycle.service.test.ts. */
const TEST_ACTOR: LifecycleActor = { kind: 'exempt', principal: 'cli' };

describe('App lifecycle', () => {
  let appLifecycleService: AppLifecycleService;
  let exposureSyncService: ExposureSyncService;
  let marketplaceService: MarketplaceService;
  let appsRepository: AppsRepository;
  let appFilesManager: AppFilesManager;
  let deviceRegistrationRepository: DeviceRegistrationRepository;
  const configurationService = mock<ConfigurationService>();
  let databaseService = mock<DatabaseService>();
  const dockerService = mock<DockerService>();
  const dockerReadFacade = mock<DockerReadFacade>();
  const loggerService = mock<LoggerService>();
  const reposHelpers = mock<ReposHelpers>();
  const repoEventsQueue = mock<RepoEventsQueue>();
  const sseService = mock<SSEService>();
  const backupManager = mock<BackupManager>();
  const cloudflareClientService = mock<CloudflareClientService>();
  const traefikConfigService = mock<TraefikConfigService>();
  const registrationService = mock<RegistrationService>();
  const imageSizeService = mock<ImageSizeService>();
  const appRuntimeMonitorService = mock<AppRuntimeMonitorService>();
  const portalCatalogService = mock<PortalCatalogService>();
  const portalClientService = mock<PortalClientService>();
  const marketplaceEntitlementService = mock<MarketplaceEntitlementService>();

  // Create AppStoreRepository manually to ensure we use the real implementation with the correct databaseService reference
  const appStoreRepository = new AppStoreRepository(databaseService, reposHelpers);

  configurationService.get.calledWith('queue').mockReturnValue({
    host: 'localhost',
    password: 'guest',
    username: 'guest',
    port: Number(process.env.RABBITMQ_PORT) || 5672,
  });
  // Queue messages are signed with a key derived from this since CI-Hub#1597, and a
  // queue refuses to start without it — so this suite could not create one at all.
  configurationService.get.calledWith('jwtSecret').mockReturnValue('integration-test-jwt-secret');
  configurationService.get.calledWith('domain').mockReturnValue('ci.test');
  configurationService.get.calledWith('localDomain').mockReturnValue('ci.lan');
  configurationService.get.calledWith('userSettings').mockReturnValue({
    appDataPath: '/opt/ci-hub',
    domain: 'ci.test',
    localDomain: 'ci.lan',
  });
  dockerService.composeApp.mockResolvedValue({ success: true, stdout: '', stderr: '' });
  dockerService.removeAppNetworks.mockResolvedValue(undefined);
  dockerService.pullImages.mockResolvedValue(undefined);
  dockerService.waitForManagedAppContainersReady.mockResolvedValue({
    ok: true,
    appStatus: 'running',
    summary: { total: 1, running: 1, exitZero: 0 },
    message: 'All containers are running',
  });
  // Added alongside UpdateAppCommand's post-update auto-rollback check (#1277). Left
  // unmocked, an unconfigured `mock<DockerService>()` call resolves `undefined`, and
  // `probeResult.healthy` throws — not a failed health check, a crash before the
  // update ever reaches its success path, which is why every "update app" test left
  // the DB status at its pre-update value instead of 'running'.
  dockerService.verifyContainerHealthProbe.mockResolvedValue({
    ok: true,
    healthy: true,
    containers: [],
    message: 'All containers for the app passed health probes',
  });
  dockerReadFacade.diagnoseAppContainers.mockResolvedValue({ unhealthy: [], healthy: [] });

  const queueFactory = new QueueFactory(loggerService, configurationService);
  let appEventsQueue: AppEventsQueue;
  /** Serial for the per-test queue name. See the comment where the queue is created. */
  let queueSerial = 0;

  beforeAll(async () => {
    db = await createTestDatabase(DB_NAME);
  });

  beforeEach(async () => {
    await cleanTestData(db);

    /*
     * ⚠ A QUEUE PER TEST, BECAUSE EVERY EARLIER TEST'S CONSUMER IS STILL LISTENING.
     *
     * This `beforeEach` compiles a fresh module, and `AppLifecycleService`'s constructor
     * calls `appEventsQueue.onEvent(...)` — which registers ANOTHER consumer and does not
     * close the previous one (`Queue.registerConsumer`). One queue for the whole file
     * therefore carries N consumers by test N, and RabbitMQ round-robins between them: an
     * install this test publishes is regularly executed by the services of a test that has
     * already finished, against this test's rows, with this test's mocks. Measured, not
     * theorised — `custom domains` cases were routinely served by an instance two tests
     * old.
     *
     * Nothing asserts on those services, so the work they do is invisible here: their
     * exposure sync writes app columns this test is reading, and no flag this test can see
     * says a pass is running. `runToQuiescence` below waits on the service instance this
     * test holds, which is only the right instance if this test's commands run on it.
     */
    appEventsQueue = await queueFactory.createQueue({
      queueName: `app-events-queue-${++queueSerial}`,
      workers: 1,
      eventSchema: appEventSchema,
    });
    portalCatalogService.warmCacheInBackground.mockReturnValue(undefined);
    portalCatalogService.invalidateCache.mockReturnValue(undefined);
    portalCatalogService.getAppInfoForUrn.mockResolvedValue(null);
    portalCatalogService.fetchDescriptionMarkdown.mockResolvedValue(null);
    portalCatalogService.isCiMarketplaceUrn.mockReturnValue(false);
    portalCatalogService.searchCatalog.mockResolvedValue(null);
    portalClientService.fetchStoreAlternatives.mockResolvedValue([]);
    portalClientService.fetchStoreListings.mockResolvedValue([]);
    marketplaceEntitlementService.assertForInstall.mockResolvedValue(undefined);
    marketplaceEntitlementService.assertForStart.mockResolvedValue(undefined);
    marketplaceEntitlementService.assertForUpdate.mockResolvedValue(undefined);
    // Best-effort arch check: null = registry unreachable, do not block install in tests.
    imageSizeService.verifyAppArchitecture.mockResolvedValue(null);
    appRuntimeMonitorService.getAppRuntimeHealth.mockResolvedValue({
      appUrn: 'test:test',
      appName: 'test',
      status: 'running',
      cpuPercent: 0,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
      highCpu: false,
      sustainedHighCpu: false,
      responsive: true,
      degraded: false,
      forceStopEligible: false,
      reason: null,
      cpuLimit: null,
      usesDefaultCpuLimit: false,
      sampledAt: new Date().toISOString(),
      containers: [],
    } as any);

    const moduleRef = await Test.createTestingModule({
      providers: [
        AppLifecycleService,
        ExposureSyncService,
        MarketplaceService,
        MarketplaceCacheBus,
        {
          provide: ImageSizeService,
          useValue: imageSizeService,
        },
        AppStoreService,
        {
          provide: AppStoreRepository,
          useValue: appStoreRepository,
        },
        FilesystemService,
        QueueFactory,
        AppLifecycleCommandFactory,
        AppFilesManager,
        AppsRepository,
        PortAllocationRepository,
        EnvUtils,
        AppHelpers,
        AppsReadService,
        AppsService,
        {
          provide: AppRuntimeMonitorService,
          useValue: appRuntimeMonitorService,
        },
        InstallPipelineTracker,
        AppOperationRegistry,
        {
          provide: SubnetManagerService,
          useFactory: (appsRepository: AppsRepository, loggerService: LoggerService, docker: typeof DOCKERODE) =>
            new SubnetManagerService(appsRepository, loggerService, docker as never),
          inject: [AppsRepository, LoggerService, DOCKERODE],
        },
        {
          provide: ReposHelpers,
          useValue: reposHelpers,
        },
        {
          provide: RepoEventsQueue,
          useValue: repoEventsQueue,
        },
        {
          provide: SSEService,
          useValue: sseService,
        },
        {
          provide: BackupManager,
          useValue: backupManager,
        },
        {
          provide: CloudflareClientService,
          useValue: cloudflareClientService,
        },
        {
          provide: TraefikConfigService,
          useValue: traefikConfigService,
        },
        {
          provide: RegistrationService,
          useValue: registrationService,
        },
        {
          provide: DeviceRegistrationRepository,
          useClass: DeviceRegistrationRepository,
        },
        {
          provide: APP_ASYNC_MUTEX,
          useValue: new AsyncMutex(),
        },
        {
          provide: DockerService,
          useValue: dockerService,
        },
        {
          provide: DockerReadFacade,
          useValue: dockerReadFacade,
        },
        {
          provide: DatabaseService,
          useValue: databaseService,
        },
        {
          provide: DATABASE,
          useValue: db,
        },
        {
          provide: DOCKERODE,
          useValue: {
            pruneContainers: vi.fn().mockRejectedValue(null),
            pruneNetworks: vi.fn().mockRejectedValue(null),
            listNetworks: vi.fn().mockResolvedValue([]),
          },
        },
        {
          provide: AppEventsQueue,
          useValue: appEventsQueue,
        },
        {
          provide: ConfigurationService,
          useValue: configurationService,
        },
        {
          provide: LoggerService,
          useValue: loggerService,
        },
        {
          provide: InferenceEnvResolver,
          useValue: mock<InferenceEnvResolver>(),
        },
        {
          provide: CloudFallbackService,
          useValue: mock<CloudFallbackService>({
            getEnabledProviders: vi.fn().mockReturnValue([]),
          }),
        },
        {
          provide: ApiKeyService,
          useValue: mock<ApiKeyService>({
            provisionManagedKey: vi.fn().mockResolvedValue('test-managed-mcp-key'),
            revokeManagedByApp: vi.fn().mockResolvedValue(undefined),
          }),
        },
        {
          provide: MemoryConnectionService,
          useValue: mock<MemoryConnectionService>({
            getInjectableCreds: vi.fn().mockResolvedValue(null),
          }),
        },
        {
          provide: PortalCatalogService,
          useValue: portalCatalogService,
        },
        {
          provide: PortalClientService,
          useValue: portalClientService,
        },
        {
          provide: MarketplaceEntitlementService,
          useValue: marketplaceEntitlementService,
        },
      ],
    }).compile();

    appLifecycleService = moduleRef.get(AppLifecycleService);
    exposureSyncService = moduleRef.get(ExposureSyncService);
    databaseService = moduleRef.get(DatabaseService);
    marketplaceService = moduleRef.get(MarketplaceService);
    appsRepository = moduleRef.get(AppsRepository);
    appFilesManager = moduleRef.get(AppFilesManager);
    deviceRegistrationRepository = moduleRef.get(DeviceRegistrationRepository);

    databaseService.db = db;

    configurationService.getConfig.mockReturnValue(
      fromPartial({
        demoMode: false,
        architecture: 'amd64',
        domain: 'ci.test',
        localDomain: 'ci.lan',
        directories: { dataDir: DATA_DIR, appDir: APP_DIR, appDataDir: APP_DATA_DIR },
        internalIp: '127.0.0.1',
        envFilePath: '/data/.env',
        rootFolderHost: '/opt/ci-hub',
        userSettings: {
          appDataPath: '/opt/ci-hub',
          domain: 'ci.test',
          localDomain: 'ci.lan',
        },
      }),
    );

    await db.insert(appStore).values({ slug: 'test', url: 'https://appstore.example.com', hash: 'test', name: 'test', enabled: true }).execute();
    await marketplaceService.initialize();
  });

  describe('install app', () => {
    it('should successfully install app and create expected directory structure', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'test' });

      // act
      await appLifecycleService.installApp({ actor: TEST_ACTOR, appUrn: appInfo.urn, form: {} });

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      // assert
      expect(cleanTree((fs as unknown as FsMock).tree())).toMatchSnapshot();
    });

    it('should not delete an existing app-data folder even if the app is reinstalled', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'test2' });

      await fs.promises.mkdir(`${APP_DATA_DIR}/test/test2/data`, { recursive: true });
      await fs.promises.writeFile(`${APP_DATA_DIR}/test/test2/data/test.txt`, 'test');

      await appLifecycleService.installApp({ actor: TEST_ACTOR, appUrn: appInfo.urn, form: {} });

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      // assert
      expect(cleanTree((fs as unknown as FsMock).tree())).toMatchSnapshot();
    });
  });

  describe('update app', () => {
    it('should successfully update an app to a newer version', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { cihub_app_version: 1 });

      await appLifecycleService.installApp({ actor: TEST_ACTOR, appUrn: appInfo.urn, form: {} });

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
        expect(app?.version).toBe(1);
      });

      await createAppInStore('test', { id: appInfo.id, cihub_app_version: 2 });

      await fs.promises.mkdir(`${APP_DATA_DIR}/test/${appInfo.id}/data`, { recursive: true });
      await fs.promises.writeFile(`${APP_DATA_DIR}/test/${appInfo.id}/data/preserved.txt`, 'data to preserve');

      // act
      await appLifecycleService.updateApp({ actor: TEST_ACTOR, appUrn: appInfo.urn, performBackup: false });

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
        expect(app?.version).toBe(2);
      });

      const dataFileExists = await fs.promises
        .access(`${APP_DATA_DIR}/test/${appInfo.id}/data/preserved.txt`)
        .then(() => true)
        .catch(() => false);
      expect(dataFileExists).toBe(true);
    });
  });

  describe('update all apps', () => {
    it('should update multiple apps that have newer versions available', async () => {
      // arrange
      const app1Info = await createAppInStore('test', { id: 'app1', cihub_app_version: 1 });
      const app2Info = await createAppInStore('test', { id: 'app2', cihub_app_version: 2 });
      const app3Info = await createAppInStore('test', { id: 'app3', cihub_app_version: 3 });

      await appLifecycleService.installApp({ actor: TEST_ACTOR, appUrn: app1Info.urn, form: {} });
      await appLifecycleService.installApp({ actor: TEST_ACTOR, appUrn: app2Info.urn, form: {} });
      await appLifecycleService.installApp({ actor: TEST_ACTOR, appUrn: app3Info.urn, form: {} });

      await waitFor(async () => {
        const app1 = await appsRepository.getAppByUrn(app1Info.urn);
        const app2 = await appsRepository.getAppByUrn(app2Info.urn);
        const app3 = await appsRepository.getAppByUrn(app3Info.urn);
        expect(app1?.status).toBe('running');
        expect(app2?.status).toBe('running');
        expect(app3?.status).toBe('running');
      });

      await createAppInStore('test', { id: 'app1', cihub_app_version: 2 });
      await createAppInStore('test', { id: 'app3', cihub_app_version: 4 });

      // act
      await appLifecycleService.updateAllApps(TEST_ACTOR);

      await waitFor(async () => {
        const app1 = await appsRepository.getAppByUrn(app1Info.urn);
        expect(app1?.status).toBe('running');
        expect(app1?.version).toBe(2);
      });

      await waitFor(async () => {
        const app3 = await appsRepository.getAppByUrn(app3Info.urn);
        expect(app3?.status).toBe('running');
        expect(app3?.version).toBe(4);
      });

      // assert
      const app1 = await appsRepository.getAppByUrn(app1Info.urn);
      const app2 = await appsRepository.getAppByUrn(app2Info.urn);
      const app3 = await appsRepository.getAppByUrn(app3Info.urn);

      expect(app1?.version).toBe(2);
      expect(app2?.version).toBe(2);
      expect(app3?.version).toBe(4);

      expect(app1?.status).toBe('running');
      expect(app2?.status).toBe('running');
      expect(app3?.status).toBe('running');
      expect(cleanTree((fs as unknown as FsMock).tree())).toMatchSnapshot();
    });
  });

  describe('uninstall app', () => {
    it('should preserve app-data when deleteAllData is false', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'preserve-data' });
      const { appStoreId, appName } = extractAppUrn(appInfo.urn);

      await appLifecycleService.installApp({ actor: TEST_ACTOR, appUrn: appInfo.urn, form: {} });
      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      await fs.promises.mkdir(`${APP_DATA_DIR}/${appStoreId}/${appName}/data`, { recursive: true });
      await fs.promises.writeFile(`${APP_DATA_DIR}/${appStoreId}/${appName}/data/preserved.txt`, 'keep-me');

      // act
      await appLifecycleService.uninstallApp({ actor: TEST_ACTOR, appUrn: appInfo.urn, deleteAllData: false });

      // assert
      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app).toBeUndefined();
      });

      const appDataStillExists = await fs.promises
        .access(`${APP_DATA_DIR}/${appStoreId}/${appName}/data/preserved.txt`)
        .then(() => true)
        .catch(() => false);
      expect(appDataStillExists).toBe(true);
    });

    it('should remove app-data when deleteAllData is true', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'delete-data' });
      const { appStoreId, appName } = extractAppUrn(appInfo.urn);

      await appLifecycleService.installApp({ actor: TEST_ACTOR, appUrn: appInfo.urn, form: {} });
      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      await fs.promises.mkdir(`${APP_DATA_DIR}/${appStoreId}/${appName}/data`, { recursive: true });
      await fs.promises.writeFile(`${APP_DATA_DIR}/${appStoreId}/${appName}/data/delete-me.txt`, 'remove-me');

      // act
      await appLifecycleService.uninstallApp({ actor: TEST_ACTOR, appUrn: appInfo.urn, deleteAllData: true });

      // assert
      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app).toBeUndefined();
      });

      const appDataStillExists = await fs.promises
        .access(`${APP_DATA_DIR}/${appStoreId}/${appName}/data/delete-me.txt`)
        .then(() => true)
        .catch(() => false);
      expect(appDataStillExists).toBe(false);
    });
  });

  describe('app subnet assignment', () => {
    it('should assign a subnet to an app when started if it has none', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'subnet-test' });

      await appLifecycleService.installApp({ actor: TEST_ACTOR, appUrn: appInfo.urn, form: {} });

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      // Remove subnet value to simulate an app without a subnet
      await db.update(appTable).set({ subnet: null }).where(eq(appTable.appName, appInfo.id)).execute();

      let app = await appsRepository.getAppByUrn(appInfo.urn);
      expect(app?.subnet).toBeNull();

      // act
      await appLifecycleService.startApp({ actor: TEST_ACTOR, appUrn: appInfo.urn });

      // assert
      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      app = await appsRepository.getAppByUrn(appInfo.urn);
      expect(app?.subnet).not.toBeNull();
      expect(app?.subnet).toMatch(/^10\.128\.\d+\.0\/24$/);
    });
  });

  describe('architecture-specific overrides', () => {
    it('should apply architecture-specific overrides when generating docker-compose file', async () => {
      // arrange
      configurationService.get.calledWith('architecture').mockReturnValue('arm64');
      const appInfo = await createAppInStore('test', { id: 'arch-test' });
      const composeJson = {
        schemaVersion: 2,
        services: [
          {
            name: 'app',
            image: 'app:latest',
            isMain: true,
            internalPort: 80,
          },
        ],
        overrides: [
          {
            architecture: 'arm64',
            services: [
              {
                name: 'app',
                image: 'app:arm64-latest',
              },
            ],
          },
        ],
      };

      await fs.promises.mkdir(`${DATA_DIR}/repos/test/apps/arch-test`, { recursive: true });
      await fs.promises.writeFile(`${DATA_DIR}/repos/test/apps/arch-test/docker-compose.json`, JSON.stringify(composeJson));

      // act
      await appLifecycleService.installApp({ actor: TEST_ACTOR, appUrn: appInfo.urn, form: {} });

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      // assert
      const composeFileContent = await fs.promises.readFile(`${DATA_DIR}/apps/test/arch-test/docker-compose.yml`, 'utf8');
      expect(composeFileContent).toContain('app:arm64-latest');
      expect(composeFileContent).not.toContain('app:latest');
    });
  });

  /*
   * The whole custom-domain path, against a real database and the real
   * migrations: Companion Portal reports a wired hostname → it lands on the app row →
   * a restart regenerates the env with it → dropping it reverts the app.
   *
   * The unit tests cover each link; this covers the seams, and is the only test
   * that proves the new column actually exists after `migrate`.
   */
  describe('custom domains', () => {
    const ORG = { id: 'org-1', slug: 'acme', name: 'Acme', hubSubdomain: 'core2-acme', tunnelId: 'tunnel-1' };

    const exposedForm = { exposureMode: 'cloudflare' as const, exposedLocal: true, openPort: false };

    /** Cloudflare passes run by THIS test's service. See {@link runToQuiescence}. */
    let cloudflarePasses: MockInstance<ExposureSyncService['triggerCloudflareSync']>;

    /** The env actually written for the app, parsed. */
    const readEnv = async (urn: AppUrn) => {
      const env = await appFilesManager.getAppEnv(urn);

      return new EnvUtils().envStringToMap(env.content ?? '');
    };

    /**
     * Wait for the point at which a lifecycle command is REALLY finished.
     *
     * ⚠ `status === 'running'` IS NOT THAT POINT, and every case in this block
     * depends on the difference. The start outcome writes `running` and only
     * THEN runs the Cloudflare pass, from `settleCommandOutcome`'s `afterApply`
     * (`AppLifecycleService`). That pass re-reads every app row at its bind step
     * and writes `custom_domain_intent: null` on the rows it gives up on
     * (`ExposureSyncService`'s `abandonChoice`) — so anything a test sets up
     * between the `running` poll and the end of the pass is set up in a row the
     * Hub is about to overwrite.
     *
     * That is how `custom_domain_intent` written straight to the database below
     * was silently reverted on a loaded GitHub runner, leaving `authorize`
     * uncalled, while every local run passed because the pass finished inside
     * `waitFor`'s first poll — on this branch (CI-Hub#1497, run 35289141993) and
     * on unrelated ones, which is what it looks like when the cause is the clock
     * rather than the change under review.
     *
     * Both halves are needed, and a sleep would give neither: the spy proves a
     * pass STARTED, and `isCloudflareSyncInFlight` — the same flag the periodic
     * poll stands down on — proves it FINISHED. The flag alone would sail
     * straight past a pass that had not begun yet, in the window where the
     * status write has committed but `cloudflareSyncDepth` has not moved.
     *
     * Both read the service THIS test holds, which is why the queue is per-test
     * (see the `beforeEach` at the top of the file). Counting passes on the
     * shared `cloudflareClientService` mock instead looks equivalent and is not:
     * it also counts passes run by an earlier test's service, and those tick the
     * counter while this test's own pass has not started, so the wait ends early
     * and the race is back. Measured — with one queue for the file, this block's
     * installs were regularly executed by a service two tests old. If a command
     * is ever served elsewhere again, this times out and says so rather than
     * quietly returning too soon.
     */
    const runToQuiescence = async (appUrn: AppUrn, command: () => Promise<unknown>) => {
      const passesBefore = cloudflarePasses.mock.calls.length;

      await command();

      await waitFor(async () => {
        expect((await appsRepository.getAppByUrn(appUrn))?.status).toBe('running');
        expect(cloudflarePasses.mock.calls.length).toBeGreaterThan(passesBefore);
        expect(exposureSyncService.isCloudflareSyncInFlight()).toBe(false);
      });
    };

    /** Install an exposed app and return once its own exposure sync has settled. */
    const installExposed = async (id: string, form: { customDomain?: string } = {}) => {
      const appInfo = await createAppInStore('test', { id });

      await runToQuiescence(appInfo.urn, () =>
        appLifecycleService.installApp({ actor: TEST_ACTOR, appUrn: appInfo.urn, form: { ...exposedForm, ...form } }),
      );

      return appInfo;
    };

    /** Restart an exposed app and return once the exposure sync that restart triggers has settled. */
    const restartExposed = async (appUrn: AppUrn) => {
      await runToQuiescence(appUrn, () => appLifecycleService.restartApp({ actor: TEST_ACTOR, appUrn, skipPull: true }));
    };

    /** The row id for an installed app, failing the test outright if it is missing. */
    const rowIdOf = async (urn: AppUrn) => {
      const row = await appsRepository.getAppByUrn(urn);
      if (!row) throw new Error(`no app row for ${urn}`);
      return row.id;
    };

    const syncReporting = async (customDomains: unknown) => {
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 1, customDomains } as never);
      await appLifecycleService.triggerCloudflareSync();
    };

    beforeEach(async () => {
      // Spied, not stubbed: `vi.spyOn` keeps the real pass and only counts it.
      cloudflarePasses = vi.spyOn(exposureSyncService, 'triggerCloudflareSync');
      await db.delete(deviceRegistrationTable);
      await deviceRegistrationRepository.createDeviceRegistration(ORG);
      registrationService.getDeviceRegistrationInfo.mockResolvedValue(fromPartial(ORG));
      registrationService.getDeviceId.mockResolvedValue('device-1');
    });

    it('binds a wired hostname, publishes it on restart, and reverts when it is dropped', async () => {
      const appInfo = await installExposed('cdomain');
      const platformHostname = 'cdomain-test-core2-acme.ci.test';

      // Installed on the platform hostname — Companion Portal cannot have wired a domain
      // to an app it had not been told about yet.
      expect((await readEnv(appInfo.urn)).get('APP_PUBLIC_URL')).toBe(`https://${platformHostname}`);

      // Companion Portal reports the alias it actually produced an ingress rule for.
      await syncReporting([{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: platformHostname }]);

      const bound = await appsRepository.getAppByUrn(appInfo.urn);
      expect(bound?.customDomain).toBe('comfy.acme.com');
      // Flagged, not recreated: the running container is left alone.
      expect(bound?.pendingRestart).toBe(true);
      expect((await readEnv(appInfo.urn)).get('APP_PUBLIC_URL')).toBe(`https://${platformHostname}`);

      await restartExposed(appInfo.urn);

      const boundEnv = await readEnv(appInfo.urn);
      expect(boundEnv.get('APP_PUBLIC_URL')).toBe('https://comfy.acme.com');
      expect(boundEnv.get('APP_PUBLIC_HOSTNAME')).toBe('comfy.acme.com');
      expect(boundEnv.get('APP_BASE_URL')).toBe('https://comfy.acme.com');
      expect(await appsRepository.getAppByUrn(appInfo.urn).then((row) => row?.pendingRestart)).toBe(false);

      // Released in Companion Portal: the array is now empty, which is an instruction to unbind —
      // but only once a second sync, at least a minute later, says the same (R2-PORTALMISC-5).
      await syncReporting([]);
      expect((await appsRepository.getAppByUrn(appInfo.urn))?.customDomain).toBe('comfy.acme.com');

      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
      try {
        await syncReporting([]);
      } finally {
        clock.mockRestore();
      }
      expect((await appsRepository.getAppByUrn(appInfo.urn))?.customDomain).toBeNull();

      await restartExposed(appInfo.urn);

      const revertedEnv = await readEnv(appInfo.urn);
      expect(revertedEnv.get('APP_PUBLIC_URL')).toBe(`https://${platformHostname}`);
      expect(revertedEnv.get('APP_BASE_URL')).toBe(`https://${platformHostname}`);
    });

    it('leaves a running app alone when the delivery carries no request', async () => {
      /*
       * The behaviour every Portal that predates the request field depends on,
       * and the reason the flag may not default to "yes": a bind flags the app
       * and leaves the container running. Waited to quiescence deliberately —
       * asserting immediately would pass even if a restart had been queued,
       * because the container work happens after the sync resolves.
       */
      const appInfo = await installExposed('cdnoask');
      const platformHostname = 'cdnoask-test-core2-acme.ci.test';

      await runToQuiescence(appInfo.urn, () => syncReporting([{ id: 'cd_1', domain: 'noask.acme.com', targetHostname: platformHostname }]));

      const row = await appsRepository.getAppByUrn(appInfo.urn);
      expect(row?.customDomain).toBe('noask.acme.com');
      expect(row?.pendingRestart).toBe(true);
      expect((await readEnv(appInfo.urn)).get('APP_PUBLIC_URL')).toBe(`https://${platformHostname}`);
    });

    it('restarts on its own for an app set to, without anyone confirming', async () => {
      /*
       * The one way a connected domain restarts an app with nobody confirming it:
       * someone turned the setting on for this app. The delivery carries no
       * request — this is the app's own choice doing the work.
       */
      const appInfo = await installExposed('cdauto');
      const platformHostname = 'cdauto-test-core2-acme.ci.test';
      await appsRepository.updateAppById(await rowIdOf(appInfo.urn), { autoRestartOnDomainChange: true });

      await runToQuiescence(appInfo.urn, () => syncReporting([{ id: 'cd_1', domain: 'auto.acme.com', targetHostname: platformHostname }]));

      expect((await readEnv(appInfo.urn)).get('APP_PUBLIC_URL')).toBe('https://auto.acme.com');
    });

    it('saves the setting on its own without restarting the app', async () => {
      /*
       * Kept out of the stored config snapshot so flipping it never compares as a
       * config change — which would restart the app, the very thing a person
       * turning automatic restarts OFF is trying to avoid. That also means a save
       * changing only this setting takes the "no changes" early return, so the row
       * write has to happen before it, or the setting never saves at all.
       */
      const appInfo = await installExposed('cdsetting');

      await appLifecycleService.updateAppConfig({
        actor: TEST_ACTOR,
        appUrn: appInfo.urn,
        form: { ...exposedForm, autoRestartOnDomainChange: true },
      });

      const row = await appsRepository.getAppByUrn(appInfo.urn);
      expect(row?.autoRestartOnDomainChange).toBe(true);
      expect(row?.pendingRestart).toBe(false);
    });

    it('tells Companion Portal a stopped app will pick its domain up when it starts', async () => {
      /*
       * The publish payload leaves stopped apps out on purpose, so without a
       * separate report Portal cannot tell "stopped, nothing to confirm" from "no
       * news" — and would offer a restart the Hub refuses for a stopped app, leaving
       * "Restarting…" on screen forever.
       */
      const appInfo = await installExposed('cdstopped');
      const platformHostname = 'cdstopped-test-core2-acme.ci.test';
      await syncReporting([{ id: 'cd_1', domain: 'stopped.acme.com', targetHostname: platformHostname }]);

      await appsRepository.updateAppById(await rowIdOf(appInfo.urn), { status: 'stopped' });
      await syncReporting([{ id: 'cd_1', domain: 'stopped.acme.com', targetHostname: platformHostname }]);

      const report = cloudflareClientService.syncState.mock.calls.at(-1)?.[3];
      expect(report).toContainEqual({ domain: 'stopped.acme.com', state: 'pending-start', autoRestart: false });
    });

    it('reports a running app still on its platform hostname as waiting for a restart', async () => {
      await installExposed('cdwaiting');
      const platformHostname = 'cdwaiting-test-core2-acme.ci.test';
      await syncReporting([{ id: 'cd_1', domain: 'waiting.acme.com', targetHostname: platformHostname }]);
      // The binding lands during that sync, so it is the NEXT report that carries it.
      await syncReporting([{ id: 'cd_1', domain: 'waiting.acme.com', targetHostname: platformHostname }]);

      const report = cloudflareClientService.syncState.mock.calls.at(-1)?.[3];
      expect(report).toContainEqual({ domain: 'waiting.acme.com', state: 'pending-restart', autoRestart: false });
    });

    it('applies a binding the operator asked for, instead of waiting to be restarted by hand', async () => {
      /*
       * The whole point of the apply request: a first bind deliberately leaves a
       * running container alone, so the customer's domain stays dark until someone
       * restarts the app — and nothing tells them to. When the operator answered
       * "yes, start serving it" in the connect flow, Companion Portal carries that
       * answer here and the Hub finishes the job itself.
       */
      const appInfo = await installExposed('cdapply');
      const platformHostname = 'cdapply-test-core2-acme.ci.test';

      // A delivery with no request behaves exactly as it always has: bound, flagged,
      // container untouched. This is also the shape an older Portal sends.
      await syncReporting([{ id: 'cd_1', domain: 'apply.acme.com', targetHostname: platformHostname }]);

      const bound = await appsRepository.getAppByUrn(appInfo.urn);
      expect(bound?.customDomain).toBe('apply.acme.com');
      expect(bound?.pendingRestart).toBe(true);
      expect((await readEnv(appInfo.urn)).get('APP_PUBLIC_URL')).toBe(`https://${platformHostname}`);

      // Now the operator's answer arrives with the same binding.
      await runToQuiescence(appInfo.urn, () =>
        syncReporting([{ id: 'cd_1', domain: 'apply.acme.com', targetHostname: platformHostname, applyRequested: true }]),
      );

      // Applied without anyone touching the app: the env, and with it the public
      // identity every redirect is built from, is now the customer's hostname.
      const appliedEnv = await readEnv(appInfo.urn);
      expect(appliedEnv.get('APP_PUBLIC_URL')).toBe('https://apply.acme.com');
      expect(appliedEnv.get('APP_PUBLIC_HOSTNAME')).toBe('apply.acme.com');
      expect(await appsRepository.getAppByUrn(appInfo.urn).then((row) => row?.pendingRestart)).toBe(false);
    });

    it('does not restart again once the domain is already being served', async () => {
      /*
       * The request stays on Companion Portal's row until it clears, so it arrives
       * on every sync for as long as it is set. Acting on it each time would bounce
       * a working app every few minutes — the reason the trigger is the Hub's own
       * "not serving it yet" verdict rather than the request on its own.
       */
      const appInfo = await installExposed('cdsettled');
      const platformHostname = 'cdsettled-test-core2-acme.ci.test';
      const delivered = [{ id: 'cd_1', domain: 'settled.acme.com', targetHostname: platformHostname, applyRequested: true }];

      await runToQuiescence(appInfo.urn, () => syncReporting(delivered));
      expect((await readEnv(appInfo.urn)).get('APP_PUBLIC_URL')).toBe('https://settled.acme.com');

      await runToQuiescence(appInfo.urn, () => syncReporting(delivered));

      // Still serving, and still settled: a second recreation would have raised
      // `pendingRestart` again on its way through, so a clean row here is the
      // evidence that the standing request did not bounce a working app. Waited to
      // quiescence like the sibling case — a bare `await` returns before a queued
      // restart has touched the container, so it would pass either way.
      expect((await readEnv(appInfo.urn)).get('APP_PUBLIC_URL')).toBe('https://settled.acme.com');
      expect(await appsRepository.getAppByUrn(appInfo.urn).then((row) => row?.pendingRestart)).toBe(false);
    });

    it('does not let a standing request turn an unrelated settings save into a restart', async () => {
      /*
       * The request stays on Companion Portal's row, so it arrives on every sync
       * for as long as it is set. `pendingRestart` is raised by ANY settings save
       * (`updateAppConfig`), so a gate built on the raw flag would recreate a
       * container whose customer domain has been serving all along — for a change
       * that has nothing to do with the domain. The gate reads the env instead.
       */
      const appInfo = await installExposed('cdunrelated');
      const platformHostname = 'cdunrelated-test-core2-acme.ci.test';
      const domain = { id: 'cd_1', domain: 'unrelated.acme.com', targetHostname: platformHostname };

      /*
       * Applied BY HAND, not through a request. An automatic apply would spend the
       * shared restart cooldown, and the assertion below would then hold because the
       * cooldown refused the second restart rather than because the gate did — which
       * is how the sibling case came to pass with the gate removed.
       */
      await runToQuiescence(appInfo.urn, () => syncReporting([domain]));
      await restartExposed(appInfo.urn);
      expect((await readEnv(appInfo.urn)).get('APP_PUBLIC_URL')).toBe('https://unrelated.acme.com');
      expect(await appsRepository.getAppByUrn(appInfo.urn).then((r) => r?.pendingRestart)).toBe(false);

      // What an unrelated save leaves behind: the env is already on the domain, and
      // the flag says only "this app owes a restart for something".
      const row = await appsRepository.getAppByUrn(appInfo.urn);
      await appsRepository.updateAppById(row?.id as number, { pendingRestart: true });

      await runToQuiescence(appInfo.urn, () => syncReporting([{ ...domain, applyRequested: true }]));

      // Untouched: a recreation would have cleared `pendingRestart` on its way out.
      expect(await appsRepository.getAppByUrn(appInfo.urn).then((r) => r?.pendingRestart)).toBe(true);
      expect((await readEnv(appInfo.urn)).get('APP_PUBLIC_URL')).toBe('https://unrelated.acme.com');
    });

    it('carries an install-time choice through to a bind, and only then to the env', async () => {
      /*
       * The whole install-time path, seam by seam — and the only test that proves
       * `custom_domain_intent` exists after `migrate`.
       *
       * The choice cannot be honoured at install time: Companion Portal derives a
       * domain's routing target from an `application` row, and at that moment it
       * has never heard of this app. So it is recorded, asked for after the sync
       * that registers the app, and reaches the env only once Companion Portal reports
       * the hostname actually wired.
       */
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([
        {
          id: 'cd_1',
          domain: 'comfy.acme.com',
          state: 'parked',
          bindable: true,
          targetHostname: null,
          boundAppSlug: null,
          boundElsewhere: false,
        },
      ]);
      cloudflareClientService.bindCustomDomain.mockResolvedValue({ ok: true });

      const appInfo = await installExposed('cdomain-intent', { customDomain: 'comfy.acme.com' });

      const platformHostname = 'cdomain-intent-test-core2-acme.ci.test';
      const installed = await appsRepository.getAppByUrn(appInfo.urn);

      // Recorded as the choice — and NOT as the binding. The app is installed at
      // its platform address, because that is the only address anyone has
      // confirmed answers for it.
      expect(installed?.customDomainIntent).toBe('comfy.acme.com');
      expect(installed?.customDomain).toBeNull();
      expect((await readEnv(appInfo.urn)).get('APP_PUBLIC_URL')).toBe(`https://${platformHostname}`);

      // The sync registers the app with Companion Portal, and the bind pass then asks for
      // the domain — by the app's subdomain, never by a hostname.
      await syncReporting([]);

      // The SAME subdomain the tunnel-state payload carries — `cdomain-intent-test`,
      // not the app's name — because that is the string Companion Portal canonicalized
      // into the `application` row it will resolve the target from.
      expect(cloudflareClientService.bindCustomDomain).toHaveBeenCalledWith('cd_1', 'cdomain-intent-test', ORG.id);
      // Still nothing in the env: a bind is Companion Portal moving the alias, not proof
      // that the tunnel answers for it.
      expect((await appsRepository.getAppByUrn(appInfo.urn))?.customDomain).toBeNull();

      // The next sync reports it delivered, which is what binds the row.
      await syncReporting([{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: platformHostname }]);

      const bound = await appsRepository.getAppByUrn(appInfo.urn);
      expect(bound?.customDomain).toBe('comfy.acme.com');
      expect(bound?.pendingRestart).toBe(true);

      await restartExposed(appInfo.urn);

      expect((await readEnv(appInfo.urn)).get('APP_PUBLIC_URL')).toBe('https://comfy.acme.com');
    });

    it('takes a choice off the app that held it when another app claims it', async () => {
      /*
       * Against the real database, because the rule is enforced by a raw
       * `lower(...)` comparison a mocked repository would happily pretend to run.
       *
       * A domain serves ONE app. Two rows naming it makes every sync a tug of
       * war: whichever binds last takes it, the delivery reconcile unbinds the
       * loser, the loser becomes a candidate again, and both apps carry a restart
       * badge forever. The picker deliberately offers a domain that is already
       * serving something, so the exclusivity has to be enforced where the choice
       * is written.
       */
      /*
       * The listing has to contain the domain being chosen. It always does in
       * production — the picker is populated from this same endpoint — but the
       * mock carries over from the case above, and a successful listing that
       * omits a domain is (correctly) read as "the organization no longer holds
       * it", which clears the choice.
       */
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([
        {
          id: 'cd_shared',
          domain: 'shared.acme.com',
          state: 'parked',
          bindable: true,
          targetHostname: null,
          boundAppSlug: null,
          boundElsewhere: false,
        },
      ]);
      cloudflareClientService.bindCustomDomain.mockResolvedValue({ ok: true });

      const first = await installExposed('cdomain-first', { customDomain: 'shared.acme.com' });

      expect((await appsRepository.getAppByUrn(first.urn))?.customDomainIntent).toBe('shared.acme.com');

      // Mixed case on the way in: DNS is case-insensitive, so the rule cannot be
      // escaped by spelling the same name differently.
      const second = await installExposed('cdomain-second', { customDomain: 'Shared.Acme.Com' });

      // Normalized on the way in — DNS is case-insensitive, and every reader of
      // the column (the exclusivity check, the bind pass, the picker's options)
      // already is, so the row must be too.
      expect((await appsRepository.getAppByUrn(second.urn))?.customDomainIntent).toBe('shared.acme.com');
      expect((await appsRepository.getAppByUrn(first.urn))?.customDomainIntent).toBeNull();
    });

    it('counts re-recording a binding another app is waiting for as a custom-domain change', async () => {
      /*
       * Against the real database for the reason the case above gives: whether
       * another app is waiting for a domain is the same raw `lower(...)`
       * comparison, read instead of written (R2-HUBDOMAINS-1).
       */
      const holder = await installExposed('cdomain-holder');
      await syncReporting([{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: 'cdomain-holder-test-core2-acme.ci.test' }]);
      expect((await appsRepository.getAppByUrn(holder.urn))?.customDomain).toBe('comfy.acme.com');

      // The settings dialog re-submitting what CI-Cloud bound, with nobody else asking for it: no change.
      const authorize = vi.fn(async () => {});
      await appLifecycleService.authorizeCustomDomainChange(holder.urn, { customDomain: 'comfy.acme.com' }, authorize);
      expect(authorize).not.toHaveBeenCalled();

      // Another app now waits for it, spelled differently: the same save would cancel that move.
      //
      // Written straight to the column because the install form normalizes the case this
      // case is about. That makes the write racy against the install's own exposure sync,
      // which is why `installExposed` returns only once that pass is over — see
      // `runToQuiescence`. Without it this write lands in a row the bind pass then clears,
      // and `authorize` is never called.
      await installExposed('cdomain-waiting');
      await db.update(appTable).set({ customDomainIntent: 'Comfy.Acme.com' }).where(eq(appTable.appName, 'cdomain-waiting'));

      await appLifecycleService.authorizeCustomDomainChange(holder.urn, { customDomain: 'comfy.acme.com' }, authorize);
      expect(authorize).toHaveBeenCalledOnce();
    });

    it('leaves a bound app untouched when CI-Cloud predates custom domains', async () => {
      const appInfo = await installExposed('cdomain-old');
      const platformHostname = 'cdomain-old-test-core2-acme.ci.test';

      await syncReporting([{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: platformHostname }]);
      expect((await appsRepository.getAppByUrn(appInfo.urn))?.customDomain).toBe('comfy.acme.com');

      // An older Portal sends no `customDomains` key at all. Reading that as
      // "none" would take a live customer domain off the air.
      await syncReporting(undefined);

      expect((await appsRepository.getAppByUrn(appInfo.urn))?.customDomain).toBe('comfy.acme.com');
    });
  });
});
