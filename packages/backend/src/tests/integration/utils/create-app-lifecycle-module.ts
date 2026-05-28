/**
 * Shared NestJS test-module factory for app-lifecycle integration tests.
 *
 * Extracted from app-lifecycle.test.ts so siblings (e.g.
 * bootstrap-install.test.ts) can reuse the heavy provider graph without
 * duplicating it. Each test module gets its own fresh mocks, but the
 * shape stays consistent.
 */
import { DATABASE } from '@/core/database/database.module';
import { DatabaseService } from '@/core/database/database.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { BackupManager } from '@/modules/backups/backup.manager';
import { SSEService } from '@/core/sse/sse.service';
import { ReposHelpers } from '@/modules/app-stores/repos.helpers';
import { AppLifecycleCommandFactory } from '@/modules/app-lifecycle/app-lifecycle-command.factory';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppStoreRepository } from '@/modules/app-stores/app-store.repository';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AppsService } from '@/modules/apps/apps.service';
import { PortAllocationRepository } from '@/modules/network/port-allocation.repository';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { DockerService } from '@/modules/docker/docker.service';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import { AppEventsQueue, appEventSchema } from '@/modules/queue/entities/app-events';
import { RepoEventsQueue } from '@/modules/queue/entities/repo-events';
import { QueueFactory } from '@/modules/queue/queue.factory';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Test, type TestingModule } from '@nestjs/testing';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi } from 'vitest';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import type { TestDatabase } from '../../utils/create-test-database';

export interface AppLifecycleTestEnv {
  moduleRef: TestingModule;
  appLifecycleService: AppLifecycleService;
  marketplaceService: MarketplaceService;
  appsRepository: AppsRepository;
  databaseService: DatabaseService;
  // Mocked deps exposed for assertion / further configuration.
  mocks: {
    configurationService: MockProxy<ConfigurationService>;
    dockerService: MockProxy<DockerService>;
    loggerService: MockProxy<LoggerService>;
    reposHelpers: MockProxy<ReposHelpers>;
    repoEventsQueue: MockProxy<RepoEventsQueue>;
    sseService: MockProxy<SSEService>;
    backupManager: MockProxy<BackupManager>;
    cloudflareClientService: MockProxy<CloudflareClientService>;
    traefikConfigService: MockProxy<TraefikConfigService>;
    registrationService: MockProxy<RegistrationService>;
  };
}

export interface CreateAppLifecycleModuleOptions {
  db: TestDatabase;
  appEventsQueue: AppEventsQueue;
  /**
   * Optional partial config returned from configurationService.getConfig().
   * Defaults to the local-dev shape used by app-lifecycle.test.ts.
   */
  config?: Record<string, unknown>;
}

/**
 * Build the standard provider graph for an app-lifecycle integration test.
 * Each call yields a fresh module and fresh mocks; callers don't share state.
 */
export async function createAppLifecycleModule(opts: CreateAppLifecycleModuleOptions): Promise<AppLifecycleTestEnv> {
  const { db, appEventsQueue } = opts;

  const configurationService = mock<ConfigurationService>();
  const databaseService = mock<DatabaseService>();
  const dockerService = mock<DockerService>();
  const loggerService = mock<LoggerService>();
  const reposHelpers = mock<ReposHelpers>();
  const repoEventsQueue = mock<RepoEventsQueue>();
  const sseService = mock<SSEService>();
  const backupManager = mock<BackupManager>();
  const cloudflareClientService = mock<CloudflareClientService>();
  const traefikConfigService = mock<TraefikConfigService>();
  const registrationService = mock<RegistrationService>();

  configurationService.get.calledWith('queue').mockReturnValue({
    host: 'localhost',
    password: 'guest',
    username: 'guest',
    port: Number(process.env.RABBITMQ_PORT) || 5672,
  });
  dockerService.composeApp.mockResolvedValue({ success: true, stdout: '', stderr: '' });

  const appStoreRepository = new AppStoreRepository(databaseService, reposHelpers);

  const moduleRef = await Test.createTestingModule({
    providers: [
      AppLifecycleService,
      MarketplaceService,
      AppStoreService,
      { provide: AppStoreRepository, useValue: appStoreRepository },
      FilesystemService,
      QueueFactory,
      AppLifecycleCommandFactory,
      AppFilesManager,
      AppsRepository,
      PortAllocationRepository,
      EnvUtils,
      AppHelpers,
      AppsService,
      SubnetManagerService,
      { provide: ReposHelpers, useValue: reposHelpers },
      { provide: RepoEventsQueue, useValue: repoEventsQueue },
      { provide: SSEService, useValue: sseService },
      { provide: BackupManager, useValue: backupManager },
      { provide: CloudflareClientService, useValue: cloudflareClientService },
      { provide: TraefikConfigService, useValue: traefikConfigService },
      { provide: RegistrationService, useValue: registrationService },
      { provide: DeviceRegistrationRepository, useClass: DeviceRegistrationRepository },
      { provide: APP_ASYNC_MUTEX, useValue: new AsyncMutex() },
      { provide: DockerService, useValue: dockerService },
      { provide: DatabaseService, useValue: databaseService },
      { provide: DATABASE, useValue: db },
      {
        provide: DOCKERODE,
        useValue: {
          pruneContainers: vi.fn().mockRejectedValue(null),
          pruneNetworks: vi.fn().mockRejectedValue(null),
          listNetworks: vi.fn().mockResolvedValue([]),
        },
      },
      { provide: AppEventsQueue, useValue: appEventsQueue },
      { provide: ConfigurationService, useValue: configurationService },
      { provide: LoggerService, useValue: loggerService },
    ],
  }).compile();

  const appLifecycleService = moduleRef.get(AppLifecycleService);
  const marketplaceService = moduleRef.get(MarketplaceService);
  const appsRepository = moduleRef.get(AppsRepository);
  const dbService = moduleRef.get<DatabaseService>(DatabaseService);
  dbService.db = db;

  return {
    moduleRef,
    appLifecycleService,
    marketplaceService,
    appsRepository,
    databaseService: dbService,
    mocks: {
      configurationService,
      dockerService,
      loggerService,
      reposHelpers,
      repoEventsQueue,
      sseService,
      backupManager,
      cloudflareClientService,
      traefikConfigService,
      registrationService,
    },
  };
}

/**
 * Helper to build a per-test-file AppEventsQueue. Each caller must pass a
 * unique queueName so concurrent integration tests don't share queue state
 * on the local RabbitMQ instance.
 */
export async function createSharedAppEventsQueue(queueName: string): Promise<{ queue: AppEventsQueue; queueFactory: QueueFactory }> {
  const loggerService = mock<LoggerService>();
  const configurationService = mock<ConfigurationService>();
  configurationService.get.calledWith('queue').mockReturnValue({
    host: 'localhost',
    password: 'guest',
    username: 'guest',
    port: Number(process.env.RABBITMQ_PORT) || 5672,
  });
  const queueFactory = new QueueFactory(loggerService, configurationService);
  const queue = await queueFactory.createQueue({ queueName, workers: 1, eventSchema: appEventSchema });
  return { queue, queueFactory };
}
