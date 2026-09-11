import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import { AppLifecycleService } from '../app-lifecycle.service';
import { AppInstallValidator } from '../app-install-validator.service';
import { ExposureSyncService } from '../exposure-sync.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppEventsQueue } from '@/modules/queue/entities/app-events';
import { AppLifecycleCommandFactory } from '../app-lifecycle-command.factory';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { ConfigurationService } from '@/core/config/configuration.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { ImageSizeService } from '@/modules/marketplace/image-size.service';
import { AppsService } from '@/modules/apps/apps.service';
import { AppRuntimeMonitorService } from '@/modules/apps/app-runtime-monitor.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { SSEService } from '@/core/sse/sse.service';
import { BackupManager } from '@/modules/backups/backup.manager';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { ReposHelpers } from '@/modules/app-stores/repos.helpers';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { InstallPipelineTracker } from '@/modules/apps/install-pipeline.tracker';
import { AppOperationRegistry } from '../app-operation-registry';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import { DockerService } from '@/modules/docker/docker.service';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentNotifyService } from '@/modules/agent-notify/agent-notify.service';
import { ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import type { AppUrn } from '@ci-hub/common/types';
import { createAppUrn } from '@/common/helpers/app-helpers';
import * as registrationRecoveryState from '../registration-recovery-state';
import { parseComposeJson } from '@ci-hub/common/schemas';
import { MarketplaceEntitlementService } from '@/core/portal/marketplace-entitlement.service';
import { assertHostDevicesAvailable } from '../commands/host-device-preflight';
import { PortManagerService } from '@/modules/network/port-manager.service';
import { EnvUtils } from '@/modules/env/env.utils';

// buildInstallPlan's image listing goes through extractComposeImages -> parseComposeJson; the
// schema itself has its own coverage elsewhere, so keep this suite focused on plan orchestration.
vi.mock('@ci-hub/common/schemas', async (importOriginal) => ({
  ...((await importOriginal()) as any),
  parseComposeJson: vi.fn().mockReturnValue({ services: [], overrides: [] }),
}));

// assertHostDevicesAvailable has its own coverage in host-device-preflight's own tests; here it's
// just one of buildInstallPlan's four checks, so stub it rather than standing up its full compose
// + filesystem dependency chain.
vi.mock('../commands/host-device-preflight', () => ({
  assertHostDevicesAvailable: vi.fn().mockResolvedValue(undefined),
}));

/** Install mechanics, not authorization, are under test here — the gate itself is covered in its own block. */
const TEST_ACTOR: LifecycleActor = { kind: 'exempt', principal: 'cli' };

describe('AppLifecycleService', () => {
  let service: AppLifecycleService;
  let exposureSyncService: ExposureSyncService;
  let logger: MockProxy<LoggerService>;
  let appEventsQueue: MockProxy<AppEventsQueue>;
  let commandFactory: MockProxy<AppLifecycleCommandFactory>;
  let appsRepository: MockProxy<AppsRepository>;
  let configService: MockProxy<ConfigurationService>;
  let marketplaceService: MockProxy<MarketplaceService>;
  let imageSizeService: MockProxy<ImageSizeService>;
  let appsService: MockProxy<AppsService>;
  let appRuntimeMonitor: MockProxy<AppRuntimeMonitorService>;
  let dockerService: MockProxy<DockerService>;
  let appFilesManager: MockProxy<AppFilesManager>;
  let sseService: MockProxy<SSEService>;
  let backupManager: MockProxy<BackupManager>;
  let cloudflareClientService: MockProxy<CloudflareClientService>;
  let registrationService: MockProxy<RegistrationService>;
  let reposHelpers: MockProxy<ReposHelpers>;
  let appStoreService: MockProxy<AppStoreService>;
  let mutex: any;
  let installPipelineTracker: InstallPipelineTracker;
  let operationRegistry: AppOperationRegistry;
  let agentNotifyService: MockProxy<AgentNotifyService>;
  let errorReportingService: MockProxy<ErrorReportingService>;

  beforeEach(async () => {
    logger = mock<LoggerService>();
    appEventsQueue = mock<AppEventsQueue>();
    commandFactory = mock<AppLifecycleCommandFactory>();
    appsRepository = mock<AppsRepository>();
    // Completion handlers use a compare-and-set write; default to "applied" so
    // their SSE emissions fire unless a test exercises the takeover race.
    appsRepository.updateAppByIdIfStatus.mockResolvedValue(true);
    configService = mock<ConfigurationService>();
    configService.getInferencePreferences.mockReturnValue({
      preferredBackend: null,
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
    });
    marketplaceService = mock<MarketplaceService>();
    imageSizeService = mock<ImageSizeService>();
    appsService = mock<AppsService>();
    appRuntimeMonitor = mock<AppRuntimeMonitorService>();
    dockerService = mock<DockerService>();
    appFilesManager = mock<AppFilesManager>();
    sseService = mock<SSEService>();
    backupManager = mock<BackupManager>();
    cloudflareClientService = mock<CloudflareClientService>();
    registrationService = mock<RegistrationService>();
    reposHelpers = mock<ReposHelpers>();
    appStoreService = mock<AppStoreService>();

    const release = vi.fn();
    mutex = {
      acquire: vi.fn().mockResolvedValue(release),
    };
    installPipelineTracker = new InstallPipelineTracker();
    operationRegistry = new AppOperationRegistry(logger);
    agentNotifyService = mock<AgentNotifyService>();
    errorReportingService = mock<ErrorReportingService>();
    appsService.getInstallQueueState.mockResolvedValue({ active: null, queued: [] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppLifecycleService,
        ExposureSyncService,
        AppInstallValidator,
        { provide: LoggerService, useValue: logger },
        { provide: AppEventsQueue, useValue: appEventsQueue },
        { provide: AppLifecycleCommandFactory, useValue: commandFactory },
        { provide: AppsRepository, useValue: appsRepository },
        { provide: ConfigurationService, useValue: configService },
        { provide: MarketplaceService, useValue: marketplaceService },
        { provide: ImageSizeService, useValue: imageSizeService },
        { provide: AppsService, useValue: appsService },
        { provide: AppRuntimeMonitorService, useValue: appRuntimeMonitor },
        { provide: AppFilesManager, useValue: appFilesManager },
        { provide: DockerService, useValue: dockerService },
        { provide: DockerReadFacade, useValue: mock<DockerReadFacade>() },
        { provide: SSEService, useValue: sseService },
        { provide: BackupManager, useValue: backupManager },
        { provide: CloudflareClientService, useValue: cloudflareClientService },
        { provide: RegistrationService, useValue: registrationService },
        { provide: ReposHelpers, useValue: reposHelpers },
        { provide: AppStoreService, useValue: appStoreService },
        { provide: APP_ASYNC_MUTEX, useValue: mutex },
        { provide: InstallPipelineTracker, useValue: installPipelineTracker },
        { provide: AppOperationRegistry, useValue: operationRegistry },
        { provide: AgentNotifyService, useValue: agentNotifyService },
        { provide: ErrorReportingService, useValue: errorReportingService },
        { provide: ModuleRef, useValue: { get: vi.fn() } },
      ],
    }).compile();

    configService.getConfig.mockReturnValue({ isProduction: false, userSettings: { localDomain: 'lan' } } as any);
    appRuntimeMonitor.getAppRuntimeHealth.mockResolvedValue({
      appUrn: 'test-app',
      appName: 'test-app',
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

    service = module.get<AppLifecycleService>(AppLifecycleService);
    exposureSyncService = module.get<ExposureSyncService>(ExposureSyncService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should subscribe to queue on init', () => {
    expect(appEventsQueue.onEvent).toHaveBeenCalled();
  });

  describe('invokeCommand', () => {
    it('should execute command and sync cloudflare on success', async () => {
      const data = {
        appUrn: 'test-app',
        command: 'install',
        requestId: '00000000-0000-4000-8000-000000000001',
        form: {},
      } as any;
      const reply = vi.fn();
      const command = { execute: vi.fn().mockResolvedValue({ success: true, message: 'OK' }) };

      commandFactory.createCommand.mockReturnValue(command as any);

      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'org-slug',
        name: 'Org Label',
      } as any);
      appsRepository.getApps.mockResolvedValue([]);
      configService.getConfig.mockReturnValue({ userSettings: { localDomain: 'lan' } } as any);

      await service.invokeCommand(data, reply);

      expect(mutex.acquire).toHaveBeenCalledWith('__install-pipeline__');
      expect(mutex.acquire).toHaveBeenCalledWith('test-app');
      expect(command.execute).toHaveBeenCalledWith('test-app', expect.anything());
      expect(cloudflareClientService.syncState).toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith({ success: true, message: 'OK' });
    });

    it('should include Hub route as OS Hub in cloudflare sync payload', async () => {
      const data = { appUrn: 'test-app', action: 'install', form: {} } as any;
      const reply = vi.fn();
      const command = { execute: vi.fn().mockResolvedValue({ success: true, message: 'OK' }) };

      commandFactory.createCommand.mockReturnValue(command as any);

      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'myorg',
        name: 'My Org',
        hubSubdomain: 'mydevice-myorg',
      } as any);
      appsRepository.getApps.mockResolvedValue([]);
      configService.getConfig.mockReturnValue({
        userSettings: { domain: 'companionintelligence.com', localDomain: 'lan' },
        domain: 'companionintelligence.com',
      } as any);

      await service.invokeCommand(data, reply);

      expect(cloudflareClientService.syncState).toHaveBeenCalledWith(
        'org-id',
        expect.arrayContaining([
          expect.objectContaining({
            name: 'OS Hub',
            subdomain: 'mydevice',
            localPort: 80,
            hostname: 'traefik',
            originServerName: 'mydevice-myorg.companionintelligence.com',
            privilegedKind: 'hub',
          }),
        ]),
        'tunnel-id',
      );
    });

    it('should include Hub route alongside exposed apps', async () => {
      const data = { appUrn: 'test-app', action: 'install', form: {} } as any;
      const reply = vi.fn();
      const command = { execute: vi.fn().mockResolvedValue({ success: true, message: 'OK' }) };

      commandFactory.createCommand.mockReturnValue(command as any);

      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'acme',
        name: 'Acme Corp',
        hubSubdomain: 'hub1-acme',
      } as any);
      appsRepository.getApps.mockResolvedValue([
        {
          appName: 'n8n',
          exposedLocal: true,
          status: 'running',
          localSubdomain: 'n8n-abc',
          appStoreSlug: 'ci-marketplace',
        },
      ] as any);
      configService.getConfig.mockReturnValue({
        userSettings: { domain: 'companionintelligence.com', localDomain: 'lan' },
        domain: 'companionintelligence.com',
      } as any);

      await service.invokeCommand(data, reply);

      const syncCall = cloudflareClientService.syncState.mock.calls[0];
      const apps = syncCall?.[1] as any[];

      // Hub should be first with correct hostname
      expect(apps[0]).toMatchObject({
        name: 'OS Hub',
        subdomain: 'hub1',
        originServerName: 'hub1-acme.companionintelligence.com',
        privilegedKind: 'hub',
      });
      expect(apps[1]).toMatchObject({ name: 'n8n', subdomain: 'n8n-abc' });
    });

    it('should not include Hub route when hubSubdomain is not set', async () => {
      const data = { appUrn: 'test-app', action: 'install', form: {} } as any;
      const reply = vi.fn();
      const command = { execute: vi.fn().mockResolvedValue({ success: true, message: 'OK' }) };

      commandFactory.createCommand.mockReturnValue(command as any);

      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'myorg',
        name: 'My Org',
      } as any);
      appsRepository.getApps.mockResolvedValue([]);
      configService.getConfig.mockReturnValue({
        userSettings: { localDomain: 'lan' },
        domain: 'companionintelligence.com',
      } as any);

      await service.invokeCommand(data, reply);

      const syncCall = cloudflareClientService.syncState.mock.calls[0];
      const apps = syncCall?.[1] as any[];
      expect(apps).toHaveLength(0);
    });

    it('uses the selected non-default domain and surfaces a public DNS sync failure', async () => {
      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'cid',
        name: 'CID',
        hubSubdomain: 'hub-laptop-cid',
      } as any);
      appsRepository.getApps.mockResolvedValue([
        {
          appName: 'anything-llm',
          exposedLocal: true,
          status: 'running',
          localSubdomain: 'anything-llm',
          publicDomain: 'companionintel.com',
          appStoreSlug: 'ci-marketplace',
        },
      ] as any);
      configService.getConfig.mockReturnValue({
        userSettings: { domain: 'companionintelligence.com', localDomain: 'lan' },
        domain: 'companionintelligence.com',
      } as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: ['anything-llm'], failures: [], synced: 0 });

      await service.triggerCloudflareSync();

      // The selected (non-default) domain wins for public DNS, but the origin
      // Host header still targets Traefik on the local domain.
      const syncedApps = cloudflareClientService.syncState.mock.calls[0]?.[1] as any[];
      expect(syncedApps.some((app) => app.originServerName === 'anything-llm-laptop-cid.lan')).toBe(true);

      // The partial failure is surfaced, not swallowed.
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('anything-llm-laptop-cid.companionintel.com'));

      // And a per-app event is emitted so the frontend can raise a toast.
      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({ event: 'public_dns_error', appUrn: 'anything-llm:ci-marketplace' }),
        'anything-llm:ci-marketplace',
      );
    });

    it('surfaces the DNS failure class instead of always blaming zone provisioning', async () => {
      // A stale record Companion Portal refuses to overwrite is not a domain problem, and
      // saying so sent the CI-Portal#403 investigation down the wrong path.
      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'cid',
        name: 'CID',
        hubSubdomain: 'hub-laptop-cid',
      } as any);
      appsRepository.getApps.mockResolvedValue([
        {
          appName: 'anything-llm',
          exposedLocal: true,
          status: 'running',
          localSubdomain: 'anything-llm',
          appStoreSlug: 'ci-marketplace',
        },
      ] as any);
      configService.getConfig.mockReturnValue({
        userSettings: { domain: 'companionintelligence.com', localDomain: 'lan' },
        domain: 'companionintelligence.com',
      } as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: ['anything-llm'],
        failures: [
          {
            app: 'anything-llm',
            hostname: 'anything-llm-laptop-cid.companionintelligence.com',
            reason: 'conflict',
            message: 'already in use by another tunnel',
          },
        ],
        synced: 0,
      });

      await service.triggerCloudflareSync();

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('already claimed by another device or tunnel'));
      expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining("verify the selected domain's zone is provisioned"));

      // The class rides along on the SSE event so the toast can say what is wrong.
      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({ event: 'public_dns_error', appUrn: 'anything-llm:ci-marketplace', errorCode: 'conflict' }),
        'anything-llm:ci-marketplace',
      );
    });

    it('names every failed app in the log, including ones it cannot map to a hostname', async () => {
      // The log used to list only the apps it could rebuild a hostname for, while the
      // count came from result.failed — so a failed app with no DB row (or the
      // privileged Hub entry) vanished from the message entirely. That is the same
      // class of misleading operator error this PR exists to fix.
      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'cid',
        name: 'CID',
        hubSubdomain: 'hub-laptop-cid',
      } as any);
      appsRepository.getApps.mockResolvedValue([
        {
          appName: 'anything-llm',
          exposedLocal: true,
          status: 'running',
          localSubdomain: 'anything-llm',
          appStoreSlug: 'ci-marketplace',
        },
      ] as any);
      configService.getConfig.mockReturnValue({
        userSettings: { domain: 'companionintelligence.com', localDomain: 'lan' },
        domain: 'companionintelligence.com',
      } as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        // 'OS Hub' is the privileged entry: it has no DB row, so it maps to no toast
        // target and used to be dropped from the log.
        failed: ['anything-llm', 'OS Hub'],
        failures: [
          { app: 'anything-llm', reason: 'conflict', message: 'already in use by another tunnel' },
          { app: 'OS Hub', reason: 'api_error', message: 'rate limited' },
        ],
        synced: 0,
      });

      await service.triggerCloudflareSync();

      // Both apps are named: the one we could resolve, by hostname; the one we could
      // not, by the name Companion Portal sent.
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('anything-llm-laptop-cid.companionintelligence.com'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('OS Hub'));
      // The count and the list agree.
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('NOT created for 2 app(s)'));
    });

    it('excludes only the targeted app URN when releasing DNS for a routing change', async () => {
      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'cid',
        name: 'CID',
        hubSubdomain: 'hub-laptop-cid',
      } as any);
      appsRepository.getApps.mockResolvedValue([
        {
          appName: 'shared-name',
          appStoreSlug: 'ci-marketplace',
          exposedLocal: true,
          status: 'running',
          localSubdomain: 'shared-marketplace',
        },
        {
          appName: 'shared-name',
          appStoreSlug: 'other-store',
          exposedLocal: true,
          status: 'running',
          localSubdomain: 'shared-other',
        },
      ] as any);
      configService.getConfig.mockReturnValue({
        userSettings: { domain: 'example.com', localDomain: 'lan' },
        domain: 'example.com',
      } as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], synced: 2 });

      await service.triggerCloudflareSync({ excludeAppUrns: ['shared-name:ci-marketplace'] as any });

      const syncedApps = cloudflareClientService.syncState.mock.calls[0]?.[1] as any[];
      const syncedSubdomains = syncedApps.filter((app) => app.privilegedKind !== 'hub').map((app) => app.subdomain);
      expect(syncedSubdomains).toEqual(['shared-other']);
    });

    it('emits per-app public DNS error events when the entire sync fails', async () => {
      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'cid',
        name: 'CID',
        hubSubdomain: 'hub-laptop-cid',
      } as any);
      appsRepository.getApps.mockResolvedValue([
        {
          appName: 'anything-llm',
          exposedLocal: true,
          status: 'running',
          localSubdomain: 'anything-llm',
          publicDomain: 'companionintel.com',
          appStoreSlug: 'ci-marketplace',
        },
      ] as any);
      configService.getConfig.mockReturnValue({
        userSettings: { domain: 'companionintelligence.com', localDomain: 'lan' },
        domain: 'companionintelligence.com',
      } as any);
      // A full sync failure (e.g. Companion Portal unreachable / non-success response),
      // distinct from a partial per-app failure.
      cloudflareClientService.syncState.mockResolvedValue({ ok: false, failed: [], failures: [], synced: 0 });

      await service.triggerCloudflareSync();

      // The failure is logged, not swallowed.
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('did not complete'));

      // Every exposed app still gets a per-app toast event so a full failure is
      // not silent in the UI.
      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({ event: 'public_dns_error', appUrn: 'anything-llm:ci-marketplace' }),
        'anything-llm:ci-marketplace',
      );
    });

    it('does not acquire install pipeline mutex for non-install commands', async () => {
      const data = {
        appUrn: 'test-app',
        command: 'start',
        requestId: '00000000-0000-4000-8000-000000000002',
        form: {},
      } as any;
      const reply = vi.fn();
      const command = { execute: vi.fn().mockResolvedValue({ success: true, message: 'OK' }) };
      commandFactory.createCommand.mockReturnValue(command as any);
      registrationService.getDeviceRegistrationInfo.mockResolvedValue(null as any);
      appsRepository.getApps.mockResolvedValue([]);
      configService.getConfig.mockReturnValue({ userSettings: { localDomain: 'lan' } } as any);

      await service.invokeCommand(data, reply);

      expect(mutex.acquire).not.toHaveBeenCalledWith('__install-pipeline__');
      expect(mutex.acquire).toHaveBeenCalledWith('test-app');
    });

    it('should handle errors during execution', async () => {
      const data = { appUrn: 'test-app:ci-marketplace', command: 'install', requestId: '00000000-0000-4000-8000-000000000003', form: {} } as any;
      const reply = vi.fn();
      appsRepository.getAppByUrn.mockResolvedValue({ id: 99, status: 'installing' } as any);
      commandFactory.createCommand.mockImplementation(() => {
        throw new Error('Exec failed');
      });

      await service.invokeCommand(data, reply);
      expect(reply).toHaveBeenCalledWith({ success: false, message: 'Exec failed' });
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(99, expect.objectContaining({ status: 'install_failed' }));
    });
  });

  describe('buildInstallPlan', () => {
    const appUrn = 'testapp:ci-marketplace' as any;
    const baseAppInfo = {
      id: 'testapp',
      urn: 'urn:app:testapp',
      name: 'Test App',
      port: 8080,
      cihub_app_version: 1,
      exposable: true,
      supported_architectures: ['amd64'],
      form_fields: [],
    };
    let moduleRefGet: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      moduleRefGet = vi.mocked((service as any).moduleRef.get);
      moduleRefGet.mockReturnValue(undefined); // no MarketplaceEntitlementService wired — treated as ok
      configService.getConfig.mockReturnValue({ isProduction: false, architecture: 'amd64', userSettings: { localDomain: 'lan' } } as any);
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(baseAppInfo as any);
      marketplaceService.getDockerComposeJson.mockResolvedValue({ content: 'services: {}' } as any);
      imageSizeService.verifyAppArchitecture.mockResolvedValue(null); // registry unreachable — best-effort ok
      vi.mocked(assertHostDevicesAvailable).mockResolvedValue(undefined);
      vi.mocked(parseComposeJson).mockReturnValue({ services: [], overrides: [] } as any);
    });

    it('reports every check ok and lists no images when the compose is empty', async () => {
      const plan = await service.buildInstallPlan(appUrn, {});

      expect(plan.blocked).toBe(false);
      expect(plan.checks).toEqual({
        config: { ok: true },
        entitlement: { ok: true },
        hostDevices: { ok: true },
        architecture: { ok: true },
      });
      expect(plan.images).toEqual([]);
    });

    it('lists compose images with their local cache status, without pulling', async () => {
      vi.mocked(parseComposeJson).mockReturnValue({
        services: [
          { name: 'app', image: 'ghcr.io/ci/testapp:latest' },
          { name: 'db', image: 'postgres:16' },
        ],
        overrides: [],
      } as any);
      dockerService.imageExistsLocally.mockImplementation(async (image) => image === 'postgres:16');

      const plan = await service.buildInstallPlan(appUrn, {});

      expect(plan.images).toEqual([
        { image: 'ghcr.io/ci/testapp:latest', cachedLocally: false },
        { image: 'postgres:16', cachedLocally: true },
      ]);
      expect(dockerService.pullImages).not.toHaveBeenCalled();
      expect(dockerService.composeApp).not.toHaveBeenCalled();
    });

    it('blocks and surfaces the reason when the entitlement check fails', async () => {
      moduleRefGet.mockImplementation((token: unknown) =>
        token === MarketplaceEntitlementService ? { assertForInstall: vi.fn().mockRejectedValue(new Error('payment required')) } : undefined,
      );

      const plan = await service.buildInstallPlan(appUrn, {});

      expect(plan.blocked).toBe(true);
      expect(plan.checks.entitlement).toEqual({ ok: false, reason: 'payment required' });
      // The other checks still ran and are reported independently.
      expect(plan.checks.config).toEqual({ ok: true });
    });

    it('blocks and surfaces the reason when a required host device is unavailable', async () => {
      vi.mocked(assertHostDevicesAvailable).mockRejectedValue(new Error('/dev/kfd not available on this host'));

      const plan = await service.buildInstallPlan(appUrn, {});

      expect(plan.blocked).toBe(true);
      expect(plan.checks.hostDevices).toEqual({ ok: false, reason: '/dev/kfd not available on this host' });
    });

    it('blocks and surfaces the missing manifest when the image has no build for this architecture', async () => {
      imageSizeService.verifyAppArchitecture.mockResolvedValue({ ok: false, image: 'ghcr.io/ci/testapp:latest', available: ['arm64'] });

      const plan = await service.buildInstallPlan(appUrn, {});

      expect(plan.blocked).toBe(true);
      expect(plan.checks.architecture).toEqual({
        ok: false,
        reason: 'ghcr.io/ci/testapp:latest has no manifest for amd64 (available: arm64)',
      });
    });

    it('blocks and surfaces config validation errors from the shared validateAppConfig path', async () => {
      vi.spyOn(service, 'validateAppConfig').mockResolvedValue({
        valid: false,
        errors: [{ env_variable: 'domain', label: 'Domain', messageKey: 'APP_ERROR_DOMAIN_REQUIRED_IF_EXPOSE_APP' }],
      });

      const plan = await service.buildInstallPlan(appUrn, { exposed: true });

      expect(plan.blocked).toBe(true);
      expect(plan.checks.config).toEqual({ ok: false, reason: 'Domain' });
    });

    it('throws when the app does not exist in any store or install', async () => {
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(null as any);

      await expect(service.buildInstallPlan(appUrn, {})).rejects.toThrow();
    });

    it('reports port availability for the main port without allocating', async () => {
      const portManager = mock<PortManagerService>();
      portManager.isPortAvailable.mockResolvedValue(true);
      moduleRefGet.mockImplementation((token: unknown) => (token === PortManagerService ? portManager : undefined));

      const plan = await service.buildInstallPlan(appUrn, { port: 9090 });

      expect(plan.ports).toEqual([{ label: 'main', containerPort: 8080, protocol: 'tcp', preferredHostPort: 9090, available: true }]);
      expect(portManager.allocatePorts).not.toHaveBeenCalled();
    });

    it('reports the main port unavailable when something already holds it, falling back to the manifest port as preferred', async () => {
      const portManager = mock<PortManagerService>();
      portManager.isPortAvailable.mockResolvedValue(false);
      moduleRefGet.mockImplementation((token: unknown) => (token === PortManagerService ? portManager : undefined));

      const plan = await service.buildInstallPlan(appUrn, {});

      expect(plan.ports).toEqual([{ label: 'main', containerPort: 8080, protocol: 'tcp', preferredHostPort: 8080, available: false }]);
    });

    it('returns no ports when PortManagerService is not wired', async () => {
      // beforeEach's default moduleRefGet already returns undefined for every token.
      const plan = await service.buildInstallPlan(appUrn, {});
      expect(plan.ports).toEqual([]);
    });

    it('diffs the app-declared form fields against the currently persisted app.env', async () => {
      const appInfoWithFields = { ...baseAppInfo, form_fields: [{ env_variable: 'ADMIN_EMAIL', label: 'Admin email', type: 'text' }] };
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(appInfoWithFields as any);
      const envUtils = mock<EnvUtils>();
      envUtils.envStringToMap.mockReturnValue(new Map([['ADMIN_EMAIL', 'old@example.com']]));
      moduleRefGet.mockImplementation((token: unknown) => (token === EnvUtils ? envUtils : undefined));
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/x/app.env', content: 'ADMIN_EMAIL=old@example.com' } as any);

      const plan = await service.buildInstallPlan(appUrn, { ADMIN_EMAIL: 'new@example.com' });

      expect(plan.formFields).toEqual([
        { key: 'ADMIN_EMAIL', label: 'Admin email', currentValue: 'old@example.com', proposedValue: 'new@example.com', status: 'changed' },
      ]);
      // Only the read path — no env file written by a plan preview.
      expect(appFilesManager.writeAppEnv).not.toHaveBeenCalled();
    });

    it('returns no form fields when EnvUtils is not wired', async () => {
      const appInfoWithFields = { ...baseAppInfo, form_fields: [{ env_variable: 'ADMIN_EMAIL', label: 'Admin email', type: 'text' }] };
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(appInfoWithFields as any);

      const plan = await service.buildInstallPlan(appUrn, {});
      expect(plan.formFields).toEqual([]);
    });
  });

  describe('installApp', () => {
    const appUrn = 'testapp:ci-marketplace' as any;
    const baseAppInfo = {
      id: 'testapp',
      urn: 'urn:app:testapp',
      name: 'Test App',
      port: 8080,
      cihub_app_version: 1,
      exposable: true,
      supported_architectures: ['amd64'],
    };

    beforeEach(() => {
      configService.getConfig.mockReturnValue({
        isProduction: false,
        architecture: 'amd64',
        version: '1.0.0',
        userSettings: { localDomain: 'lan', guestDashboard: false },
      } as any);
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      appsRepository.getApps.mockResolvedValue([]);
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(baseAppInfo as any);
      appsRepository.getAppsByDomain.mockResolvedValue([]);
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
      appsRepository.getAppsByPort.mockResolvedValue([]);
      appsRepository.createApp.mockImplementation(async (data: any) => ({ id: 1, ...data }));
      appEventsQueue.publish.mockResolvedValue({ success: true, message: 'OK' } as any);
      appFilesManager.getAppEnvMap.mockReturnValue(new Map());
      reposHelpers.downloadAppFiles.mockResolvedValue({ files: {} } as any);
      // Default: registry inspection unavailable — install proceeds (best-effort).
      imageSizeService.verifyAppArchitecture.mockResolvedValue(null);
    });

    /*
     * The service is the gate now, not the HTTP controller (CI-Hub#1397): MCP and
     * rehydrate reached `installApp` / `updateAppConfig` with no check at all, and
     * the sweeps read "no operator id" and "WhoIs unavailable" as "allowed".
     */
    describe('the actor gate', () => {
      const whois = { has: vi.fn() };
      const OPERATOR: LifecycleActor = { kind: 'operator', userId: 7 };
      const whoisWired = (token: unknown) => (token === MarketplaceWhoIsService ? whois : undefined);

      beforeEach(() => {
        whois.has.mockReset();
        vi.mocked((service as any).moduleRef.get).mockImplementation(whoisWired);
      });

      it('refuses an operator without the install grant, before anything is written or queued', async () => {
        whois.has.mockResolvedValue(false);

        await expect(service.installApp({ actor: OPERATOR, appUrn, form: {} })).rejects.toThrow('APP_ACTION_GRANT_DENIED');
        expect(whois.has).toHaveBeenCalledWith(7, appUrn, 'install');
        expect(appsRepository.createApp).not.toHaveBeenCalled();
        expect(appEventsQueue.publish).not.toHaveBeenCalled();
      });

      it('installs for an operator holding the install grant', async () => {
        whois.has.mockResolvedValue(true);

        await service.installApp({ actor: OPERATOR, appUrn, form: {} });

        expect(appsRepository.createApp).toHaveBeenCalled();
      });

      it.each([
        ['cannot be resolved', () => undefined],
        [
          'throws on lookup',
          () => {
            throw new Error('no provider');
          },
        ],
      ])('refuses an operator when WhoIs %s — "could not tell" is not "allowed"', async (_label, get) => {
        vi.mocked((service as any).moduleRef.get).mockImplementation(get);

        await expect(service.installApp({ actor: OPERATOR, appUrn, form: {} })).rejects.toThrow('APP_ACTION_GRANT_DENIED');
        expect(appsRepository.createApp).not.toHaveBeenCalled();
      });

      it('refuses an operator without the configure grant, before the app is even read', async () => {
        whois.has.mockResolvedValue(false);

        // Past the gate this app would be "not found"; the refusal comes first.
        await expect(service.updateAppConfig({ actor: OPERATOR, appUrn, form: {} })).rejects.toThrow('APP_ACTION_GRANT_DENIED');
        expect(whois.has).toHaveBeenCalledWith(7, appUrn, 'configure');
      });

      it('lets an operator holding the configure grant through to the update', async () => {
        whois.has.mockResolvedValue(true);

        await expect(service.updateAppConfig({ actor: OPERATOR, appUrn, form: {} })).rejects.toThrow('APP_ERROR_APP_NOT_FOUND');
      });

      it("confines a managed app's MCP key to its own app", async () => {
        const neighbour: LifecycleActor = { kind: 'mcp', ownerAppUrn: 'importer:ci-marketplace' };

        await expect(service.installApp({ actor: neighbour, appUrn, form: {} })).rejects.toThrow('APP_ACTION_GRANT_DENIED');
        await expect(service.updateAppConfig({ actor: neighbour, appUrn, form: {} })).rejects.toThrow('APP_ACTION_GRANT_DENIED');
        expect(appsRepository.createApp).not.toHaveBeenCalled();
      });

      it.each([
        ['a managed key on its own app', { kind: 'mcp', ownerAppUrn: appUrn }],
        ['an unmanaged MCP key', { kind: 'mcp', ownerAppUrn: null }],
        ['a grant-exempt principal', { kind: 'exempt', principal: 'portal-device' }],
        ['the Hub itself', { kind: 'system', reason: 'debug-seed' }],
      ] as Array<[string, LifecycleActor]>)('installs for %s without consulting WhoIs', async (_label, actor) => {
        await service.installApp({ actor, appUrn, form: {} });

        expect(appsRepository.createApp).toHaveBeenCalled();
        expect(whois.has).not.toHaveBeenCalled();
      });

      /*
       * R2-HUBDOMAINS-1 at the one gate every transport reaches: which custom
       * domain an app serves is the organization's, so a form that changes it
       * also takes an owner or admin — on top of the per-app grant above.
       */
      describe('custom-domain changes', () => {
        const roles = { has: vi.fn(), hasManagingRole: vi.fn() };
        const serving = { id: 1, status: 'stopped', config: {}, customDomain: 'shop.acme.com', customDomainIntent: 'shop.acme.com' };
        /** What an update settles to once past both gates — anything but the role refusal. */
        const outcomeOf = (run: Promise<unknown>) =>
          run.then(
            () => 'done',
            (error: Error) => error.message,
          );

        beforeEach(() => {
          roles.has.mockReset().mockResolvedValue(true);
          roles.hasManagingRole.mockReset();
          vi.mocked((service as any).moduleRef.get).mockImplementation((token: unknown) => (token === MarketplaceWhoIsService ? roles : undefined));
        });

        it('refuses a member moving the domain, before anything is written or queued', async () => {
          appsRepository.getAppByUrn.mockResolvedValue(serving as any);
          roles.hasManagingRole.mockResolvedValue(false);

          await expect(service.updateAppConfig({ actor: OPERATOR, appUrn, form: { customDomain: 'other.acme.com' } })).rejects.toThrow(
            'CUSTOM_DOMAIN_ROLE_REQUIRED',
          );
          expect(roles.hasManagingRole).toHaveBeenCalledWith(7, appUrn);
          expect(appsRepository.updateAppById).not.toHaveBeenCalled();
          expect(appEventsQueue.publish).not.toHaveBeenCalled();
        });

        it('lets an owner or admin move it, all the way to the row', async () => {
          appsRepository.getAppByUrn.mockResolvedValue(serving as any);
          appFilesManager.getInstalledAppInfo.mockResolvedValue(baseAppInfo as any);
          roles.hasManagingRole.mockResolvedValue(true);

          await service.updateAppConfig({
            actor: OPERATOR,
            appUrn,
            form: { exposureMode: 'cloudflare', exposedLocal: true, openPort: false, customDomain: 'other.acme.com' },
          });

          expect(roles.hasManagingRole).toHaveBeenCalledWith(7, appUrn);
          expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ customDomainIntent: 'other.acme.com' }));
        });

        it('does not ask a member about a save that leaves the domain alone', async () => {
          appsRepository.getAppByUrn.mockResolvedValue(serving as any);

          const outcome = await outcomeOf(service.updateAppConfig({ actor: OPERATOR, appUrn, form: { customDomain: 'shop.acme.com' } }));

          expect(outcome).not.toBe('CUSTOM_DOMAIN_ROLE_REQUIRED');
          expect(roles.hasManagingRole).not.toHaveBeenCalled();
        });

        it.each([
          ['an unmanaged MCP key', { kind: 'mcp', ownerAppUrn: null }],
          ['a managed key on its own app', { kind: 'mcp', ownerAppUrn: appUrn }],
        ] as Array<[string, LifecycleActor]>)('refuses %s, whatever its capability — no person to ask', async (_label, actor) => {
          await expect(service.installApp({ actor, appUrn, form: { customDomain: 'shop.acme.com' } })).rejects.toThrow('CUSTOM_DOMAIN_ROLE_REQUIRED');
          expect(appsRepository.createApp).not.toHaveBeenCalled();
          expect(roles.hasManagingRole).not.toHaveBeenCalled();
        });

        it.each([
          ['a grant-exempt principal', { kind: 'exempt', principal: 'cli' }],
          ['the Hub itself', { kind: 'system', reason: 'debug-seed' }],
        ] as Array<[string, LifecycleActor]>)('admits %s by name', async (_label, actor) => {
          await service.installApp({ actor, appUrn, form: { customDomain: 'shop.acme.com' } });

          expect(appsRepository.createApp).toHaveBeenCalled();
          expect(roles.hasManagingRole).not.toHaveBeenCalled();
        });
      });

      describe('the sweeps', () => {
        const IMPORTER = 'importer:ci-marketplace';
        const importerKey: LifecycleActor = { kind: 'mcp', ownerAppUrn: IMPORTER };
        const row = (appName: string) => ({
          id: appName.length,
          appName,
          appStoreSlug: 'ci-marketplace',
          status: 'running',
          version: 1,
          ignoredVersion: null,
        });

        it("updates only a managed key's own app — the old gate swept every app for an MCP caller", async () => {
          appsService.getInstalledApps.mockResolvedValue(
            ['neighbour', 'importer'].map((name) => ({ app: row(name), metadata: { latestVersion: 2 } })) as any,
          );
          const update = vi.spyOn(service, 'updateApp').mockResolvedValue({ requestId: 'u' } as any);

          await service.updateAllApps(importerKey);

          expect(update).toHaveBeenCalledTimes(1);
          expect(update).toHaveBeenCalledWith(expect.objectContaining({ appUrn: IMPORTER }));
        });

        it('updates nothing for an operator when WhoIs cannot be resolved', async () => {
          vi.mocked((service as any).moduleRef.get).mockReturnValue(undefined);
          appsService.getInstalledApps.mockResolvedValue([{ app: row('importer'), metadata: { latestVersion: 2 } }] as any);
          const update = vi.spyOn(service, 'updateApp').mockResolvedValue({ requestId: 'u' } as any);

          await service.updateAllApps(OPERATOR);

          expect(update).not.toHaveBeenCalled();
        });

        it("stops only a managed key's own app", async () => {
          // The refused app comes first, so by the time the allowed stop is seen it was already weighed.
          appsRepository.getApps.mockResolvedValue([row('neighbour'), row('importer')] as any);
          const stop = vi.spyOn(service, 'stopApp').mockResolvedValue({ requestId: 's' } as any);

          await service.stopAllApps(importerKey);

          await vi.waitFor(() => expect(stop).toHaveBeenCalledWith(expect.objectContaining({ appUrn: IMPORTER })));
          expect(stop).toHaveBeenCalledTimes(1);
        });
      });
    });

    it('releases the domain when a reinstall clears the picker', async () => {
      /*
       * The settings dialog released; this path only cleared the intent. So a
       * reinstall of an app currently serving a domain reported success, dropped
       * the choice, and left CI-Cloud serving — after which the reconcile
       * re-adopted the domain and raised a restart badge, so the operator watched
       * the thing they gave up come back.
       */
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        status: 'stopped',
        config: { port: 8080 },
        customDomain: 'comfy.acme.com',
      } as any);
      const release = vi.spyOn(exposureSyncService, 'releaseCustomDomain').mockResolvedValue({ ok: true, portalRowId: 'cd_1' });

      await service.installApp({
        actor: TEST_ACTOR,
        appUrn,
        // The picker was shown this domain, and says so: the release is a
        // compare-and-swap (R2-HUBDOMAINS-3), not an order.
        form: {
          port: 8080,
          exposureMode: 'cloudflare',
          exposedLocal: true,
          openPort: false,
          customDomain: '',
          customDomainExpected: 'comfy.acme.com',
        },
      } as any);

      expect(release).toHaveBeenCalled();
      /*
       * The choice goes with the binding, in ONE write. A failure between the two
       * would otherwise leave an intent naming the domain that was just parked,
       * which the next bind pass would dutifully ask CI-Cloud to wire back.
       */
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, { customDomain: null, customDomainIntent: null, customDomainTakeover: false });
      // The operator's own release is a binding change too, and audited as one.
      expect(logger.info).toHaveBeenCalledWith(
        `custom_domain_audit app=${appUrn} previous=comfy.acme.com next=none previousPortalRowId=cd_1 nextPortalRowId=none cause=release`,
      );
    });

    it('writes no custom-domain intent a reinstall form smuggles in under its column name', async () => {
      /*
       * The form is `.passthrough()` and the reinstall patch spreads it, so a
       * `customDomainIntent` field would write the column directly — past the
       * owner/admin gate, which reads only `customDomain` (R2-HUBDOMAINS-1) —
       * and the bind pass would then wire any parked organization domain to it.
       */
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080 }, customDomain: null } as any);

      await service.installApp({
        actor: TEST_ACTOR,
        appUrn,
        form: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false, customDomainIntent: 'shop.acme.com' },
      } as any);

      expect(appsRepository.updateAppById).toHaveBeenCalled();
      for (const [, patch] of appsRepository.updateAppById.mock.calls) {
        expect(patch).not.toHaveProperty('customDomainIntent');
      }
    });

    it('refuses the reinstall before it parks anything when another app holds the subdomain', async () => {
      /*
       * The release reaches CI-Cloud and writes the row, so it has to run AFTER
       * every refusal. Placed before them, a reinstall rejected for a subdomain
       * or port collision had already given the operator's domain up — for a save
       * they were told had failed, and with no way to ask for it back.
       */
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        status: 'stopped',
        config: { port: 8080 },
        customDomain: 'comfy.acme.com',
      } as any);
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([{ id: 9, appName: 'grafana' }] as any);
      const release = vi.spyOn(exposureSyncService, 'releaseCustomDomain').mockResolvedValue({ ok: true });

      await expect(
        service.installApp({
          actor: TEST_ACTOR,
          appUrn,
          form: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false, localSubdomain: 'comfy', customDomain: '' },
        } as any),
      ).rejects.toThrow();

      expect(release).not.toHaveBeenCalled();
    });

    it('does not reach CI-Cloud on a fresh install, where nothing is bound', async () => {
      const release = vi.spyOn(exposureSyncService, 'releaseCustomDomain');

      await service.installApp({
        actor: TEST_ACTOR,
        appUrn,
        form: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false, customDomain: '' },
      } as any);

      expect(release).not.toHaveBeenCalled();
    });

    it('refuses the reinstall when the release fails, leaving the binding alone', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        status: 'stopped',
        config: { port: 8080 },
        customDomain: 'comfy.acme.com',
      } as any);
      vi.spyOn(exposureSyncService, 'releaseCustomDomain').mockResolvedValue({ ok: false, message: 'nope' });

      await expect(
        service.installApp({
          actor: TEST_ACTOR,
          appUrn,
          form: {
            port: 8080,
            exposureMode: 'cloudflare',
            exposedLocal: true,
            openPort: false,
            customDomain: '',
            customDomainExpected: 'comfy.acme.com',
          },
        } as any),
      ).rejects.toThrow();

      expect(appsRepository.updateAppById).not.toHaveBeenCalledWith(1, { customDomain: null });
    });

    it('refuses to release a domain the operator was never shown', async () => {
      /*
       * R2-HUBDOMAINS-3. The dialog opened while the app had no domain, so it
       * seeded `customDomain: ''` — and submits it on every save, whether or not
       * the picker was ever drawn. An admin then bound the domain in the Portal
       * and the Hub mirrored it. Every guard downstream passes precisely BECAUSE
       * the domain genuinely is this app's now, so the stale instruction released
       * a live customer hostname behind a success toast.
       */
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        status: 'stopped',
        config: { port: 8080 },
        customDomain: 'shop.acme.com',
      } as any);
      const release = vi.spyOn(exposureSyncService, 'releaseCustomDomain').mockResolvedValue({ ok: true });

      await expect(
        service.installApp({
          actor: TEST_ACTOR,
          appUrn,
          form: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false, customDomain: '', customDomainExpected: '' },
        } as any),
      ).rejects.toThrow();

      expect(release).not.toHaveBeenCalled();
      expect(appsRepository.updateAppById).not.toHaveBeenCalledWith(1, expect.objectContaining({ customDomain: null }));
    });

    it('refuses a release that cannot say what it was looking at', async () => {
      /*
       * The deliberate backward-compatibility answer (R2-HUBDOMAINS-3). The
       * compatibility case this codebase protects — an older client, or one
       * patching a single setting — sends no `customDomain` at all and never
       * reaches the release. What arrives here asked to take a live customer
       * hostname off the air, and a caller that knows enough to ask that can say
       * which hostname it means.
       */
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        status: 'stopped',
        config: { port: 8080 },
        customDomain: 'shop.acme.com',
      } as any);
      const release = vi.spyOn(exposureSyncService, 'releaseCustomDomain').mockResolvedValue({ ok: true });

      await expect(
        service.installApp({
          actor: TEST_ACTOR,
          appUrn,
          form: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false, customDomain: '' },
        } as any),
      ).rejects.toThrow();

      expect(release).not.toHaveBeenCalled();
    });

    it('stores the routing subdomain in the one spelling it will be served under', async () => {
      /*
       * R2-HUBDOMAINS-2. `My--App` composes the hostname `my-app`, so a row
       * holding the raw spelling disagrees with its own Traefik `Host()` rule,
       * with the slug CI-Cloud stores, and with the conflict check meant to keep
       * a second app off that hostname — which is how two apps came to share one.
       */
      await service.installApp({
        actor: TEST_ACTOR,
        appUrn,
        form: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false, localSubdomain: 'My--App' },
      } as any);

      expect(appsRepository.getAppsByLocalSubdomain).toHaveBeenCalledWith('my-app');
      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ localSubdomain: 'my-app' }));
    });

    it('refuses My-App when my-app is already taken', async () => {
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([{ id: 9, appName: 'comfyui' }] as any);

      await expect(
        service.installApp({
          actor: TEST_ACTOR,
          appUrn,
          form: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false, localSubdomain: 'My-App' },
        } as any),
      ).rejects.toThrow();

      // The refusal names the hostname label, not the spelling that was typed.
      expect(appsRepository.getAppsByLocalSubdomain).toHaveBeenCalledWith('my-app');
      expect(appsRepository.createApp).not.toHaveBeenCalled();
    });

    it('records a takeover confirmed at install time, not only at settings time', async () => {
      /*
       * The install dialog is where this picker primarily lives, and the
       * fresh-create branch wrote the intent alone — so the column defaulted
       * false, the bind pass read that as a refusal, and the move the person had
       * just agreed to was cleared on the next sync.
       */
      await service.installApp({
        actor: TEST_ACTOR,
        appUrn,
        form: {
          port: 8080,
          exposureMode: 'cloudflare',
          exposedLocal: true,
          openPort: false,
          customDomain: 'comfy.acme.com',
          customDomainTakeover: true,
        },
      } as any);

      expect(appsRepository.createApp).toHaveBeenCalledWith(
        expect.objectContaining({ customDomainIntent: 'comfy.acme.com', customDomainTakeover: true }),
      );
    });

    it('throws when image manifest does not include host architecture and amd64 is not supported', async () => {
      configService.getConfig.mockReturnValue({
        isProduction: false,
        architecture: 'arm64',
        version: '1.0.0',
        userSettings: { localDomain: 'lan', guestDashboard: false },
      } as any);
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue({
        ...baseAppInfo,
        supported_architectures: ['arm64'],
      } as any);
      imageSizeService.verifyAppArchitecture.mockResolvedValue({
        ok: false,
        image: 'ghcr.io/companionintelligence/ci-openclaw:2026.6.1',
        available: ['amd64'],
      });

      await expect(service.installApp({ actor: TEST_ACTOR, appUrn, form: {} })).rejects.toThrow('APP_ERROR_ARCHITECTURE_NOT_SUPPORTED');

      expect(imageSizeService.verifyAppArchitecture).toHaveBeenCalledWith(appUrn, 'arm64');
      expect(appsRepository.createApp).not.toHaveBeenCalled();
    });

    it('allows install on arm64 when amd64-only images are declared for amd64 emulation', async () => {
      configService.getConfig.mockReturnValue({
        isProduction: false,
        architecture: 'arm64',
        version: '1.0.0',
        userSettings: { localDomain: 'lan', guestDashboard: false },
      } as any);
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue({
        ...baseAppInfo,
        supported_architectures: ['arm64', 'amd64'],
      } as any);
      imageSizeService.verifyAppArchitecture.mockResolvedValue({
        ok: false,
        image: 'ghcr.io/companionintelligence/companion/gateway:2026.7.1',
        available: ['amd64'],
      });

      await service.installApp({ actor: TEST_ACTOR, appUrn, form: {} });

      expect(appsRepository.createApp).toHaveBeenCalled();
    });

    it('does not block install when manifest architecture inspection is unavailable', async () => {
      imageSizeService.verifyAppArchitecture.mockResolvedValue(null);

      await service.installApp({ actor: TEST_ACTOR, appUrn, form: {} });

      expect(imageSizeService.verifyAppArchitecture).toHaveBeenCalledWith(appUrn, 'amd64');
      expect(appsRepository.createApp).toHaveBeenCalled();
    });

    // ── production port fallback ──────────────────────────────────────────
    // `requirePortWhenExposedLocal` only bites when isProduction, which every other test in this
    // describe turns off — that is how a production-only install break went unnoticed.
    describe('production install with no port in the form', () => {
      const productionConfig = {
        isProduction: true,
        architecture: 'amd64',
        version: '1.0.0',
        userSettings: { localDomain: 'lan', guestDashboard: false },
      } as any;

      beforeEach(() => {
        configService.getConfig.mockReturnValue(productionConfig);
      });

      it('falls back to the manifest port instead of rejecting the install (the onboarding wizard sends no port)', async () => {
        await service.installApp({ actor: TEST_ACTOR, appUrn, form: { exposureMode: 'cloudflare', exposedLocal: true, localSubdomain: 'testapp' } });

        expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ port: 8080 }));
      });

      it('keeps an explicit form port over the manifest port', async () => {
        await service.installApp({
          actor: TEST_ACTOR,
          appUrn,
          form: { exposureMode: 'cloudflare', exposedLocal: true, localSubdomain: 'testapp', port: 9090 },
        });

        expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ port: 9090 }));
      });

      it('still reports the port as missing when the manifest declares none', async () => {
        marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue({ ...baseAppInfo, port: undefined } as any);

        await expect(
          service.installApp({ actor: TEST_ACTOR, appUrn, form: { exposureMode: 'cloudflare', exposedLocal: true, localSubdomain: 'testapp' } }),
        ).rejects.toThrow('APP_INSTALL_FORM_ERROR_INVALID');

        expect(appsRepository.createApp).not.toHaveBeenCalled();
      });

      it('reports valid from the shared validator used by the UI pre-check and the MCP install tool', async () => {
        const result = await service.validateAppConfig(appUrn, { exposureMode: 'cloudflare', exposedLocal: true, localSubdomain: 'testapp' });

        expect(result).toEqual({ valid: true, errors: [] });
      });

      it('does not leak the fallback into the queued form, so port allocation is unchanged', async () => {
        await service.installApp({ actor: TEST_ACTOR, appUrn, form: { exposureMode: 'cloudflare', exposedLocal: true, localSubdomain: 'testapp' } });

        // The fallback lands on validateAppConfig's own parse of the form, never on the object handed to
        // the worker. install-app-command still resolves `preferredHostPort: form.port ?? appInfo.port`,
        // so an install that already worked allocates exactly the port it allocated before.
        const published = appEventsQueue.publish.mock.calls[0]?.[0] as any;
        expect(published.form.port).toBeUndefined();
      });

      it('does not mutate the caller-supplied form', async () => {
        const form = { exposureMode: 'cloudflare' as const, exposedLocal: true, localSubdomain: 'testapp' };

        await service.validateAppConfig(appUrn, form);

        expect(form).not.toHaveProperty('port');
      });
    });

    it('MUST persist exposureMode=cloudflare when provided in form', async () => {
      await service.installApp({ actor: TEST_ACTOR, appUrn, form: { exposureMode: 'cloudflare', exposedLocal: true } });

      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ exposureMode: 'cloudflare' }));
    });

    it('MUST persist exposureMode=tailscale when provided in form', async () => {
      await service.installApp({ actor: TEST_ACTOR, appUrn, form: { exposureMode: 'tailscale', exposedLocal: true } });

      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ exposureMode: 'tailscale' }));
    });

    it('does not treat localSubdomain as a tailscale conflict key', async () => {
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([{ appName: 'taken' }] as any);
      await service.installApp({ actor: TEST_ACTOR, appUrn, form: { exposureMode: 'tailscale', exposedLocal: false, localSubdomain: 'mysvc' } });

      expect(appsRepository.getAppsByLocalSubdomain).not.toHaveBeenCalled();
    });

    it('MUST default exposureMode to local when not provided', async () => {
      await service.installApp({ actor: TEST_ACTOR, appUrn, form: {} });

      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ exposureMode: 'local' }));
    });

    it('MUST persist exposureMode=local explicitly when provided', async () => {
      await service.installApp({ actor: TEST_ACTOR, appUrn, form: { exposureMode: 'local' } });

      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ exposureMode: 'local' }));
    });

    // ── manifest edge-auth default (CI-Engineering#74) ────────────────────
    describe('manifest edge-auth default', () => {
      const edgeAuthApp = { ...baseAppInfo, hub_integration: { edge_auth: { default: true } } };

      it('defaults enableAuth ON for an undecided install when the manifest asks (the onboarding path sends no enableAuth)', async () => {
        marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(edgeAuthApp as any);
        await service.installApp({ actor: TEST_ACTOR, appUrn, form: {} });
        expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ enableAuth: true }));
      });

      it('an explicit operator false always wins over the manifest default', async () => {
        marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(edgeAuthApp as any);
        await service.installApp({ actor: TEST_ACTOR, appUrn, form: { enableAuth: false } });
        expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ enableAuth: false }));
      });

      it('a non-exposable app never gets auth defaulted on (the reset also strips the manifest ask)', async () => {
        marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue({ ...edgeAuthApp, exposable: false } as any);
        await service.installApp({ actor: TEST_ACTOR, appUrn, form: {} });
        expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ enableAuth: false }));
      });

      it('without the manifest field an undecided install stays auth-OFF (existing behavior)', async () => {
        await service.installApp({ actor: TEST_ACTOR, appUrn, form: {} });
        expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ enableAuth: false }));
      });
    });

    it('MUST normalize local exposure to openPort=true before duplicate-port checks', async () => {
      appsRepository.getAppsByPort.mockResolvedValue([{ appName: 'taken-port' }] as any);

      await expect(service.installApp({ actor: TEST_ACTOR, appUrn, form: { exposureMode: 'local', openPort: false, port: 8080 } })).rejects.toThrow(
        'APP_ERROR_PORT_ALREADY_IN_USE',
      );
    });

    it('MUST reject duplicate port for cloudflare exposedLocal when openPort is false', async () => {
      appsRepository.getAppsByPort.mockResolvedValue([{ appName: 'taken-port' }] as any);

      await expect(
        service.installApp({ actor: TEST_ACTOR, appUrn, form: { exposureMode: 'cloudflare', exposedLocal: true, openPort: false, port: 8080 } }),
      ).rejects.toThrow('APP_ERROR_PORT_ALREADY_IN_USE');
    });

    it('MUST skip duplicate-port checks when cloudflare apps do not publish a host port', async () => {
      appsRepository.getAppsByPort.mockResolvedValue([{ appName: 'taken-port' }] as any);

      await service.installApp({ actor: TEST_ACTOR, appUrn, form: { exposureMode: 'cloudflare', exposedLocal: false, openPort: false, port: 8080 } });

      expect(appsRepository.getAppsByPort).not.toHaveBeenCalled();
    });
  });

  describe('startApp', () => {
    it('should start existing app', async () => {
      const appUrn = 'test-app' as any;
      const app = { id: 1, name: 'test-app', status: 'stopped' };
      appsRepository.getAppByUrn.mockResolvedValue(app as any);
      appEventsQueue.publish.mockResolvedValue({ success: true, message: 'OK' } as any);

      await service.startApp({ appUrn });

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, { status: 'starting' });
      expect(sseService.emit).toHaveBeenCalledWith('app', expect.objectContaining({ event: 'status_change', appStatus: 'starting' }));
    });

    it('should throw if app not found', async () => {
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      await expect(service.startApp({ appUrn: 'missing' as any })).rejects.toThrow('APP_ERROR_APP_NOT_FOUND');
    });
  });

  describe('syncCloudflareState - device slug in hostname', () => {
    it('should include device slug in publicHostname when hubSubdomain has different device slug', async () => {
      // Setup: org with hubSubdomain hub-test1-myorg
      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-1',
        slug: 'myorg',
        hubSubdomain: 'hub-test1-myorg',
        tunnelId: 'tunnel-123',
        tunnelToken: 'token',
      } as any);
      configService.getConfig.mockReturnValue({
        userSettings: { domain: 'example.com', localDomain: 'ci.lan' },
        localDomain: 'ci.lan',
        domain: 'example.com',
      } as any);
      appsRepository.getApps.mockResolvedValue([
        {
          appName: 'element',
          appStoreSlug: 'store1',
          localSubdomain: 'element',
          exposedLocal: true,
          status: 'running',
          port: 80,
        },
      ] as any);

      await service.syncExposurePublic();

      expect(cloudflareClientService.syncState).toHaveBeenCalledWith(
        'org-1',
        expect.arrayContaining([
          expect.objectContaining({
            originServerName: 'element-test1-myorg.ci.lan',
          }),
        ]),
        'tunnel-123',
      );
    });

    it('should omit device slug when it equals org slug', async () => {
      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-1',
        slug: 'myorg',
        hubSubdomain: 'hub-myorg-myorg',
        tunnelId: 'tunnel-123',
        tunnelToken: 'token',
      } as any);
      configService.getConfig.mockReturnValue({
        userSettings: { domain: 'example.com', localDomain: 'ci.lan' },
        localDomain: 'ci.lan',
        domain: 'example.com',
      } as any);
      appsRepository.getApps.mockResolvedValue([
        {
          appName: 'element',
          appStoreSlug: 'store1',
          localSubdomain: 'element',
          exposedLocal: true,
          status: 'running',
          port: 80,
        },
      ] as any);

      await service.syncExposurePublic();

      expect(cloudflareClientService.syncState).toHaveBeenCalledWith(
        'org-1',
        expect.arrayContaining([
          expect.objectContaining({
            originServerName: 'element-myorg.ci.lan',
          }),
        ]),
        'tunnel-123',
      );
    });
  });

  describe('authorizeCustomDomainChange (R2-HUBDOMAINS-1)', () => {
    const APP_URN = 'comfyui:ci-marketplace' as AppUrn;
    const row = (overrides: Record<string, unknown> = {}) =>
      ({ id: 7, customDomainIntent: 'shop.acme.com', customDomain: 'shop.acme.com', customDomainTakeover: false, ...overrides }) as any;

    it('asks when a save moves the app to another domain', async () => {
      const authorize = vi.fn(async () => {});
      appsRepository.getAppByUrn.mockResolvedValue(row());

      await service.authorizeCustomDomainChange(APP_URN, { customDomain: 'other.acme.com' }, authorize);

      expect(authorize).toHaveBeenCalledOnce();
    });

    it('does not ask when the dialog re-submits what the row holds, takeover included', async () => {
      const authorize = vi.fn(async () => {});
      appsRepository.getAppByUrn.mockResolvedValue(row({ customDomain: 'old.acme.com', customDomainTakeover: true }));

      await service.authorizeCustomDomainChange(APP_URN, { customDomain: 'shop.acme.com', customDomainTakeover: true }, authorize);

      expect(authorize).not.toHaveBeenCalled();
    });

    it('reads nothing for a form that says nothing about custom domains', async () => {
      const authorize = vi.fn(async () => {});

      await service.authorizeCustomDomainChange(APP_URN, { customDomainTakeover: true }, authorize);

      expect(appsRepository.getAppByUrn).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
    });

    it('asks when re-recording a binding would cancel a move another app is waiting on', async () => {
      const authorize = vi.fn(async () => {});
      appsRepository.getAppByUrn.mockResolvedValue(row({ customDomainIntent: null }));
      appsRepository.hasCustomDomainIntentElsewhere.mockResolvedValue(true);

      await service.authorizeCustomDomainChange(APP_URN, { customDomain: 'shop.acme.com' }, authorize);

      expect(appsRepository.hasCustomDomainIntentElsewhere).toHaveBeenCalledWith(7, 'shop.acme.com');
      expect(authorize).toHaveBeenCalledOnce();
    });

    it('does not ask for that re-submission when no other app is waiting', async () => {
      const authorize = vi.fn(async () => {});
      appsRepository.getAppByUrn.mockResolvedValue(row({ customDomainIntent: null }));
      appsRepository.hasCustomDomainIntentElsewhere.mockResolvedValue(false);

      await service.authorizeCustomDomainChange(APP_URN, { customDomain: 'shop.acme.com' }, authorize);

      expect(authorize).not.toHaveBeenCalled();
    });

    it('looks for another app waiting only when the save would otherwise change nothing', async () => {
      appsRepository.getAppByUrn.mockResolvedValue(row());

      // A different domain is a change whatever else is true, so it costs no query.
      await service.authorizeCustomDomainChange(
        APP_URN,
        { customDomain: 'other.acme.com' },
        vi.fn(async () => {}),
      );
      expect(appsRepository.hasCustomDomainIntentElsewhere).not.toHaveBeenCalled();

      await service.authorizeCustomDomainChange(
        APP_URN,
        { customDomain: 'shop.acme.com' },
        vi.fn(async () => {}),
      );
      expect(appsRepository.hasCustomDomainIntentElsewhere).toHaveBeenCalledWith(7, 'shop.acme.com');
    });

    it('asks when re-saving its own choice would take it from another app holding the same one', async () => {
      // Two rows can hold one intent after a failed exclusivity write; the claim on this save would wipe the other.
      const authorize = vi.fn(async () => {});
      appsRepository.getAppByUrn.mockResolvedValue(row());
      appsRepository.hasCustomDomainIntentElsewhere.mockResolvedValue(true);

      await service.authorizeCustomDomainChange(APP_URN, { customDomain: 'shop.acme.com' }, authorize);

      expect(authorize).toHaveBeenCalledOnce();
    });

    it('refuses a release of a binding the dialog never showed before asking for any role', async () => {
      const authorize = vi.fn(async () => {});
      appsRepository.getAppByUrn.mockResolvedValue(row());

      await expect(service.authorizeCustomDomainChange(APP_URN, { customDomain: '', customDomainExpected: '' }, authorize)).rejects.toMatchObject({
        message: 'APP_ERROR_CUSTOM_DOMAIN_RELEASE_STALE',
        status: 409,
      });
      expect(authorize).not.toHaveBeenCalled();
    });

    it('asks for a release of the binding the dialog showed', async () => {
      const authorize = vi.fn(async () => {});
      appsRepository.getAppByUrn.mockResolvedValue(row());

      await service.authorizeCustomDomainChange(APP_URN, { customDomain: '', customDomainExpected: 'shop.acme.com' }, authorize);

      expect(authorize).toHaveBeenCalledOnce();
    });

    it('takes an app not installed yet to change something only by asking for a domain', async () => {
      const authorize = vi.fn(async () => {});
      appsRepository.getAppByUrn.mockResolvedValue(null as any);

      await service.authorizeCustomDomainChange(APP_URN, { customDomain: '' }, authorize);
      expect(authorize).not.toHaveBeenCalled();

      await service.authorizeCustomDomainChange(APP_URN, { customDomain: 'shop.acme.com' }, authorize);
      expect(authorize).toHaveBeenCalledOnce();
    });

    it('lets a refusal through to the caller', async () => {
      appsRepository.getAppByUrn.mockResolvedValue(row());
      const authorize = vi.fn(async () => {
        throw new Error('CUSTOM_DOMAIN_ROLE_REQUIRED');
      });

      await expect(service.authorizeCustomDomainChange(APP_URN, { customDomain: 'other.acme.com' }, authorize)).rejects.toThrow(
        'CUSTOM_DOMAIN_ROLE_REQUIRED',
      );
    });
  });

  describe('custom domain reconciliation', () => {
    const REGISTRATION = {
      id: 'org-1',
      slug: 'acme',
      hubSubdomain: 'core2-acme',
      tunnelId: 'tunnel-123',
      tunnelToken: 'token',
    };

    const CONFIG = {
      userSettings: { domain: 'companionintelligence.com', localDomain: 'ci.lan' },
      localDomain: 'ci.lan',
      domain: 'companionintelligence.com',
    };

    /** The platform hostname Companion Portal composes for the app below. */
    const TARGET = 'comfyui-core2-acme.companionintelligence.com';

    const runningComfy = (overrides: Record<string, unknown> = {}) => ({
      id: 7,
      appName: 'comfyui',
      appStoreSlug: 'ci-marketplace',
      localSubdomain: 'comfyui',
      exposedLocal: true,
      exposureMode: 'cloudflare',
      openPort: false,
      status: 'running',
      port: 80,
      customDomain: null,
      ...overrides,
    });

    beforeEach(() => {
      registrationService.getDeviceRegistrationInfo.mockResolvedValue(REGISTRATION as any);
      configService.getConfig.mockReturnValue(CONFIG as any);
    });

    /*
     * An empty answer while apps hold domains is believed only once it has held
     * for a minute across a second sync (R2-PORTALMISC-5). The tests that call
     * this are about what happens once it IS believed, so they start a minute
     * into that run; the confirmation itself has its own block below.
     */
    const emptyAnswerAlreadyConfirmed = () => {
      (exposureSyncService as any).emptyCustomDomainsSince = Date.now() - 61_000;
    };

    it('binds a delivered custom domain to the app it aliases and asks for a restart', async () => {
      appsRepository.getApps.mockResolvedValue([runningComfy()] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 1,
        customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: TARGET }],
      });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(7, 'running', { customDomain: 'comfy.acme.com', pendingRestart: true });
      // Flagged, never recreated: a background heartbeat must not take a running
      // app down under the user.
      // No third argument: that publishes to `app:<urn>`, a topic nothing
      // subscribes to, so the badge would never appear without a reload.
      expect(sseService.emit).toHaveBeenCalledWith('app', { event: 'custom_domain_changed', appUrn: 'comfyui:ci-marketplace' });
    });

    it('binds nothing when two apps answer on one platform hostname', async () => {
      /*
       * R2-HUBDOMAINS-2, the delivery half. `ComfyUI` and `comfyui` are two rows
       * that compose one hostname, and CI-Cloud attributes a delivered domain by
       * hostname rather than by app — so `byTarget.get(target)` matches both rows
       * and neither attribution is better than the other. The wrong half of that
       * guess writes the customer's `custom_domain` onto an app it was never
       * bound to, which then emits `APP_PUBLIC_URL=https://comfy.acme.com`,
       * receives it as `X-Forwarded-Host` and signs OAuth redirects for it.
       *
       * The conservative rule is the one the mirror-image case already uses (one
       * domain against two targets): bind none, and leave each app on whatever it
       * is already serving.
       */
      appsRepository.getApps.mockResolvedValue([runningComfy(), runningComfy({ id: 8, appName: 'dozzle', localSubdomain: 'ComfyUI' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 2,
        customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: TARGET }],
      });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    });

    it('holds a contested app on the hostname it is already serving rather than unbinding it', async () => {
      // Holding still means exactly that: the app that legitimately holds the
      // domain does not lose it because a second app appeared on its hostname.
      appsRepository.getApps.mockResolvedValue([
        runningComfy({ customDomain: 'comfy.acme.com' }),
        runningComfy({ id: 8, appName: 'dozzle', localSubdomain: 'ComfyUI' }),
      ] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 2, customDomains: [] });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    });

    it('names both hostnames, the CI-Cloud record and the cause in an audit line when it binds', async () => {
      appsRepository.getApps.mockResolvedValue([runningComfy()] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 1,
        customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: TARGET }],
      });

      await service.triggerCloudflareSync();

      expect(logger.info).toHaveBeenCalledWith(
        'custom_domain_audit app=comfyui:ci-marketplace previous=none next=comfy.acme.com previousPortalRowId=none nextPortalRowId=cd_1 cause=ci-cloud',
      );
    });

    it("audits a binding dropped by the app's own routing settings as such", async () => {
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com', openPort: true })] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 1, customDomains: [] });

      await service.triggerCloudflareSync();

      expect(logger.info).toHaveBeenCalledWith(
        'custom_domain_audit app=comfyui:ci-marketplace previous=comfy.acme.com next=none previousPortalRowId=unknown nextPortalRowId=none cause=settings',
      );
    });

    describe('an empty answer while apps still hold domains (R2-PORTALMISC-5)', () => {
      const emptyAnswer = { ok: true, failed: [], failures: [], synced: 1, customDomains: [] } as any;
      let now: number;

      beforeEach(() => {
        now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com' })] as any);
        cloudflareClientService.syncState.mockResolvedValue(emptyAnswer);
      });

      it('changes nothing on the first one', async () => {
        await service.triggerCloudflareSync();

        expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
      });

      it('still changes nothing when a second one follows within the minute', async () => {
        await service.triggerCloudflareSync();
        now += 30_000;
        await service.triggerCloudflareSync();

        expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
      });

      it('unbinds once a sync at least a minute later says the same', async () => {
        await service.triggerCloudflareSync();
        now += 61_000;
        await service.triggerCloudflareSync();

        expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(7, 'running', { customDomain: null, pendingRestart: true });
      });

      it('does not start the minute on answers that were not about the app holding the domain', async () => {
        // Stopped, so absent from the payload: an empty answer is exactly what CI-Cloud should say.
        const domainless = runningComfy({ id: 8, appName: 'immich', localSubdomain: 'immich' });
        appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com', status: 'stopped' }), domainless] as any);
        await service.triggerCloudflareSync();
        now += 61_000;

        // Running again: the first empty answer about it is only the first.
        appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com' }), domainless] as any);
        await service.triggerCloudflareSync();

        expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
      });

      it('starts counting again after an answer that delivers the domain', async () => {
        await service.triggerCloudflareSync();
        now += 30_000;
        cloudflareClientService.syncState.mockResolvedValueOnce({
          ...emptyAnswer,
          customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: TARGET }],
        });
        await service.triggerCloudflareSync();
        now += 31_000;
        await service.triggerCloudflareSync();

        expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
      });
    });

    it('is idempotent once the binding is already stored', async () => {
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 1,
        customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: TARGET }],
      });

      await service.triggerCloudflareSync();

      // Re-flagging on every heartbeat would leave the badge stuck on forever.
      expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    });

    it('unbinds an app CI-Cloud no longer reports as wired', async () => {
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 1, customDomains: [] });

      emptyAnswerAlreadyConfirmed();
      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(7, 'running', { customDomain: null, pendingRestart: true });
    });

    /**
     * Resolves the lifecycle service the reconcile reaches for through the
     * (mocked) ModuleRef so the revert path can be observed.
     */
    const stubLifecycleForRevert = () => {
      const restartApp = vi.fn().mockResolvedValue({ requestId: 'req-1' });
      vi.mocked((exposureSyncService as any).moduleRef.get).mockReturnValue({ restartApp });
      return restartApp;
    };

    it('restarts a running app whose custom domain was removed', async () => {
      // Clearing the row is not enough: the container's Traefik middleware still
      // injects the removed hostname as X-Forwarded-Host, so the app redirects
      // every visitor to a name that no longer resolves — including visitors who
      // arrived on its platform hostname. Only recreating it clears that label.
      const restartApp = stubLifecycleForRevert();
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 1, customDomains: [] });

      emptyAnswerAlreadyConfirmed();
      await service.triggerCloudflareSync();

      expect(restartApp).toHaveBeenCalledWith({ appUrn: 'comfyui:ci-marketplace', skipPull: true });
    });

    it('restarts a running app whose custom domain was re-pointed to another name', async () => {
      // A re-point is the same fault as a disconnect from the app's side: the
      // container is still forwarding the hostname that went away.
      const restartApp = stubLifecycleForRevert();
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'old.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 1,
        customDomains: [{ id: 'cd_1', domain: 'new.acme.com', targetHostname: TARGET }],
      });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(7, 'running', { customDomain: 'new.acme.com', pendingRestart: true });
      expect(restartApp).toHaveBeenCalledWith({ appUrn: 'comfyui:ci-marketplace', skipPull: true });
    });

    it('restarts an app at most once per cooldown when CI-Cloud keeps changing its mind', async () => {
      // The row is written before the restart, so a settled Portal never asks
      // twice. An unsettled one must not recreate the container on every tick of
      // the periodic sync.
      const restartApp = stubLifecycleForRevert();
      // The row keeps reading as bound, so every pass sees the same unbind to make.
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 1, customDomains: [] });

      emptyAnswerAlreadyConfirmed();
      await service.triggerCloudflareSync();
      await service.triggerCloudflareSync();

      expect(restartApp).toHaveBeenCalledTimes(1);
    });

    it('does not restart an app that stopped being publicly routed', async () => {
      // The binding falls away here because a settings save turned public
      // exposure off — and `updateAppConfig` awaits this sync before firing its
      // own restart. Restarting from here too would recreate the container twice
      // for one save.
      const restartApp = stubLifecycleForRevert();
      appsRepository.getApps.mockResolvedValue([runningComfy({ exposedLocal: false, exposureMode: 'local', customDomain: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 0, customDomains: [] });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(7, 'running', { customDomain: null, pendingRestart: true });
      expect(restartApp).not.toHaveBeenCalled();
    });

    it('leaves the restart to the caller when a config save drove the sync', async () => {
      // A subdomain rename moves the app's platform hostname out from under a
      // binding CI-Cloud still reports against the old target, so the reconcile
      // sees a lost hostname. `updateAppConfig` awaits this sync and then
      // restarts the app itself — recreating the container twice for one save.
      const restartApp = stubLifecycleForRevert();
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 1,
        customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: 'comfyui-old-acme.companionintelligence.com' }],
      });

      await exposureSyncService.syncExposureAfterRoutingChange('comfyui:ci-marketplace' as AppUrn, true);

      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(7, 'running', { customDomain: null, pendingRestart: true });
      expect(restartApp).not.toHaveBeenCalled();
    });

    it('does not restart when a custom domain is newly bound', async () => {
      // The bind direction is asymmetric: the app still works on its platform
      // hostname, so a background heartbeat must not take it down for it.
      const restartApp = stubLifecycleForRevert();
      appsRepository.getApps.mockResolvedValue([runningComfy()] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 1,
        customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: TARGET }],
      });

      await service.triggerCloudflareSync();

      expect(restartApp).not.toHaveBeenCalled();
    });

    it('does not restart an app that is not running when its binding is dropped', async () => {
      // Its next start regenerates the env, the Compose file and the Traefik
      // labels from the cleared row, so there is nothing to repair and nothing
      // to justify starting a container the user chose to stop.
      const restartApp = stubLifecycleForRevert();
      appsRepository.getApps.mockResolvedValue([
        runningComfy({ status: 'stopped', exposedLocal: false, exposureMode: 'local', customDomain: 'comfy.acme.com' }),
      ] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 0, customDomains: [] });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(7, 'stopped', { customDomain: null, pendingRestart: true });
      expect(restartApp).not.toHaveBeenCalled();
    });

    it('warns instead of throwing when the lifecycle service cannot be resolved', async () => {
      // `ModuleRef.get` throws for an unresolvable provider. A failed revert must
      // not unwind through the reconcile and relabel the whole sync as failed.
      vi.mocked((exposureSyncService as any).moduleRef.get).mockImplementation(() => {
        throw new Error('Nest could not find AppLifecycleService');
      });
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 1, customDomains: [] });

      emptyAnswerAlreadyConfirmed();
      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(7, 'running', { customDomain: null, pendingRestart: true });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cihub public-web repair'));
    });

    it('retries a revert whose restart could not be dispatched', async () => {
      // The row is settled before the restart is asked for, so once a dispatch
      // fails no later reconcile ever looks at the app again — it would sit
      // forwarding a hostname the Hub has stopped serving until someone ran
      // `cihub public-web repair`.
      const restartApp = stubLifecycleForRevert();
      restartApp.mockRejectedValueOnce(new Error('queue unavailable'));
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 1, customDomains: [] });

      emptyAnswerAlreadyConfirmed();
      await service.triggerCloudflareSync();
      expect(restartApp).toHaveBeenCalledTimes(1);

      // The row now reads as unbound, so this pass has no change of its own to make.
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: null })] as any);
      await service.triggerCloudflareSync();

      expect(restartApp).toHaveBeenCalledTimes(2);
      expect(restartApp).toHaveBeenLastCalledWith({ appUrn: 'comfyui:ci-marketplace', skipPull: true });
    });

    it('defers the revert while the Hub is still asking CI-Cloud for that hostname', async () => {
      // A domain unbound from the app in the Portal while it stays connected to
      // the organization: `bindCustomDomainIntents` runs straight after this
      // reconcile and asks for it back, so bouncing the container here would
      // recreate an app that is about to be served on that exact hostname again.
      const restartApp = stubLifecycleForRevert();
      // The bind pass re-reads the rows the reconcile just wrote.
      appsRepository.getApps
        .mockResolvedValueOnce([runningComfy({ customDomain: 'comfy.acme.com', customDomainIntent: 'comfy.acme.com' })] as any)
        .mockResolvedValue([runningComfy({ customDomain: null, customDomainIntent: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 1, customDomains: [] });
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([
        { id: 'cd_1', domain: 'comfy.acme.com', state: 'active', bindable: true, targetHostname: null },
      ] as any);
      cloudflareClientService.bindCustomDomain.mockResolvedValue({ ok: true } as any);

      emptyAnswerAlreadyConfirmed();
      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(7, 'running', { customDomain: null, pendingRestart: true });
      expect(cloudflareClientService.bindCustomDomain).toHaveBeenCalled();
      expect(restartApp).not.toHaveBeenCalled();
    });

    it('takes the deferred revert when it refuses the move, like every other terminal branch', async () => {
      /*
       * The reconcile held the revert back only because this Hub was still asking
       * CI-Cloud for the hostname the app had just lost. Refusing the move settles
       * that question — but the container is still injecting that hostname as
       * `X-Forwarded-Host`, so leaving it running strands the app on a name the
       * Hub has stopped serving (CI-Hub#1207). The missing-entry and
       * `DOMAIN_NOT_FOUND` branches both take the revert; this one has to as well.
       */
      const restartApp = stubLifecycleForRevert();
      appsRepository.getApps
        .mockResolvedValueOnce([runningComfy({ customDomain: 'comfy.acme.com', customDomainIntent: 'comfy.acme.com' })] as any)
        .mockResolvedValue([runningComfy({ customDomain: null, customDomainIntent: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 1, customDomains: [] });
      // The organization still holds it, but CI-Cloud now serves it from a sibling
      // Hub — a move, and nobody confirmed one.
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([
        {
          id: 'cd_1',
          domain: 'comfy.acme.com',
          state: 'live',
          bindable: true,
          targetHostname: 'comfy-core9-acme.example.com',
          boundAppSlug: null,
          boundElsewhere: true,
        },
      ] as any);

      emptyAnswerAlreadyConfirmed();
      await service.triggerCloudflareSync();

      expect(cloudflareClientService.bindCustomDomain).not.toHaveBeenCalled();
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(7, { customDomainIntent: null, customDomainTakeover: false });
      expect(restartApp).toHaveBeenCalledWith({ appUrn: 'comfyui:ci-marketplace', skipPull: true });
    });

    it('refuses an unconfirmed move even when CI-Cloud has not given the domain a target yet', async () => {
      /*
       * `targetHostname` is absent while a bind is still settling, and the parser
       * NULLS one it cannot read rather than dropping the row. Gating the
       * confirmation on it meant the one case the flag exists for — a hostname
       * live on a sibling Hub — slipped past unconfirmed on a payload hiccup.
       */
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: null, customDomainIntent: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 1, customDomains: [] });
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([
        { id: 'cd_1', domain: 'comfy.acme.com', state: 'live', bindable: true, targetHostname: null, boundAppSlug: null, boundElsewhere: true },
      ] as any);

      await service.triggerCloudflareSync();

      expect(cloudflareClientService.bindCustomDomain).not.toHaveBeenCalled();
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(7, { customDomainIntent: null, customDomainTakeover: false });
    });

    it('performs the deferred revert once the bind pass gives the domain up', async () => {
      // Same start, but the organization no longer holds the domain. The choice is
      // now provably nonviable, and the app is still forwarding it — so the revert
      // the reconcile held back has to happen here (CI-Hub#1207).
      const restartApp = stubLifecycleForRevert();
      appsRepository.getApps
        .mockResolvedValueOnce([runningComfy({ customDomain: 'comfy.acme.com', customDomainIntent: 'comfy.acme.com' })] as any)
        .mockResolvedValue([runningComfy({ customDomain: null, customDomainIntent: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 1, customDomains: [] });
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([] as any);

      emptyAnswerAlreadyConfirmed();
      await service.triggerCloudflareSync();

      // The confirmation goes with the choice: an answer about a domain the
      // organization no longer holds cannot authorize a later move.
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(7, { customDomainIntent: null, customDomainTakeover: false });
      expect(restartApp).toHaveBeenCalledWith({ appUrn: 'comfyui:ci-marketplace', skipPull: true });
    });

    it('does not recreate every public app when the Hub identity moves', async () => {
      // `toPublicHostname` is composed from the org slug, Hub subdomain and default
      // public domain. When one of those moves, every app on a custom domain misses
      // the join in the same pass. CI-Cloud still reports both domains — against the
      // hostnames this Hub no longer composes — which is what separates an identity
      // change from a disconnect. Recreating them all would be worse than the drift.
      const restartApp = stubLifecycleForRevert();
      appsRepository.getApps.mockResolvedValue([
        runningComfy({ customDomain: 'comfy.acme.com' }),
        runningComfy({ id: 8, appName: 'wordpress', localSubdomain: 'wordpress', customDomain: 'blog.acme.com' }),
      ] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 2,
        customDomains: [
          { id: 'cd_1', domain: 'comfy.acme.com', targetHostname: 'comfyui-oldhub-acme.companionintelligence.com' },
          { id: 'cd_2', domain: 'blog.acme.com', targetHostname: 'wordpress-oldhub-acme.companionintelligence.com' },
        ],
      });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(7, 'running', { customDomain: null, pendingRestart: true });
      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(8, 'running', { customDomain: null, pendingRestart: true });
      expect(restartApp).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('public identity changing'));
    });

    it('restarts every app when several domains are genuinely disconnected at once', async () => {
      // An empty payload is CI-Cloud saying "this device has none" — the unbind
      // instruction, once confirmed. Disconnecting two domains inside one five-minute poll is
      // ordinary, so a count threshold would be the wrong shape of guard here.
      const restartApp = stubLifecycleForRevert();
      appsRepository.getApps.mockResolvedValue([
        runningComfy({ customDomain: 'comfy.acme.com' }),
        runningComfy({ id: 8, appName: 'wordpress', localSubdomain: 'wordpress', customDomain: 'blog.acme.com' }),
      ] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 2, customDomains: [] });

      emptyAnswerAlreadyConfirmed();
      await service.triggerCloudflareSync();

      expect(restartApp).toHaveBeenCalledWith({ appUrn: 'comfyui:ci-marketplace', skipPull: true });
      expect(restartApp).toHaveBeenCalledWith({ appUrn: 'wordpress:ci-marketplace', skipPull: true });
    });

    it('restarts an app whose domain was re-pointed to a sibling app on this Hub', async () => {
      // The domain is still delivered, but against the sibling's target, which IS
      // matched — so this app really is stranded and must be recreated. Only a
      // domain delivered against a target no app here answers means the Hub's own
      // identity moved.
      const restartApp = stubLifecycleForRevert();
      appsRepository.getApps.mockResolvedValue([
        runningComfy({ customDomain: 'comfy.acme.com' }),
        runningComfy({ id: 8, appName: 'wordpress', localSubdomain: 'wordpress', customDomain: null }),
      ] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 2,
        customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: 'wordpress-core2-acme.companionintelligence.com' }],
      });

      await service.triggerCloudflareSync();

      expect(restartApp).toHaveBeenCalledWith({ appUrn: 'comfyui:ci-marketplace', skipPull: true });
    });

    it('changes nothing when CI-Cloud predates custom domains', async () => {
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com' })] as any);
      // No `customDomains` key at all — every Portal released before the feature.
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 1 });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    });

    it('leaves a stopped app bound rather than flapping it off and back on', async () => {
      // A stopped app is not in the sync payload, so Companion Portal produced no ingress
      // rule for it and cannot report its domain as delivered. Reading that as
      // "unbound" would unbind on stop, regenerate its env without the custom
      // hostname on start, and demand a second restart right after.
      appsRepository.getApps.mockResolvedValue([runningComfy({ status: 'stopped', customDomain: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 0, customDomains: [] });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    });

    it('drops the binding of an app that no longer publishes a public route', async () => {
      appsRepository.getApps.mockResolvedValue([
        runningComfy({ status: 'stopped', exposedLocal: false, exposureMode: 'local', customDomain: 'comfy.acme.com' }),
      ] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 0, customDomains: [] });

      await service.triggerCloudflareSync();

      // Durable configuration, not a transient absence from one payload. The write is
      // conditional on the status the reconcile saw, so a command that claims the app
      // mid-sync wins instead of having its env silently contradicted.
      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(7, 'stopped', { customDomain: null, pendingRestart: true });
    });

    it('does not unbind on a failed sync', async () => {
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: false,
        failed: [],
        failures: [],
        synced: 0,
        errorMessage: 'Portal unreachable',
      });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    });

    it('does not unbind a stopped app that merely shares an app name with a running one', async () => {
      // `app` is unique on (app_name, app_store_slug), so two stores can both
      // ship an app called `comfyui`. The sync payload carries only the NAME.
      appsRepository.getApps.mockResolvedValue([
        runningComfy({ id: 7, appStoreSlug: 'ci-marketplace', localSubdomain: 'comfyui' }),
        runningComfy({ id: 8, appStoreSlug: 'other-store', localSubdomain: 'comfyui-alt', status: 'stopped', customDomain: 'art.acme.com' }),
      ] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 1,
        customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: TARGET }],
      });

      await service.triggerCloudflareSync();

      // The running one binds...
      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(7, 'running', { customDomain: 'comfy.acme.com', pendingRestart: true });
      // ...and the stopped one, which was never in the payload, keeps its domain.
      expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalledWith(8, expect.anything(), expect.anything());
    });

    it('matches the target hostname case-insensitively', async () => {
      // The Hub composes its side of the join from slugs it stores VERBATIM, and
      // a rename can leave uppercase in them; Companion Portal's side is already
      // lowercased by the wire parser. Without normalization the two never match
      // and the whole feature is a silent no-op for that org.
      registrationService.getDeviceRegistrationInfo.mockResolvedValue({ ...REGISTRATION, slug: 'ACME', hubSubdomain: 'Core2-ACME' } as any);
      appsRepository.getApps.mockResolvedValue([runningComfy({ localSubdomain: 'ComfyUI' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 1,
        customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: TARGET }],
      });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(7, 'running', { customDomain: 'comfy.acme.com', pendingRestart: true });
    });

    it('leaves a bound app alone when the payload could not be parsed', async () => {
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com' })] as any);
      // Every row unusable — a Companion Portal whose wire shape drifted. Reading that as
      // "none delivered" would unbind every app on a custom hostname fleet-wide.
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 1, customDomains: undefined });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    });

    it('keeps the domain the app already serves on when a second alias appears', async () => {
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'zzz.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 1,
        customDomains: [
          { id: 'cd_1', domain: 'zzz.acme.com', targetHostname: TARGET },
          { id: 'cd_2', domain: 'aaa.acme.com', targetHostname: TARGET },
        ],
      });

      await service.triggerCloudflareSync();

      // Moving to the lexicographically first name would break every OAuth
      // redirect_uri registered against the one it is already serving.
      expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    });

    it('does not bind an app served on an open host port', async () => {
      // `publishesCloudflarePublicRoute` admits it, but `generateEnvFile` treats
      // openPort as "not exposed" and emits no public identity at all — binding
      // would raise a restart badge for a restart that changes nothing.
      appsRepository.getApps.mockResolvedValue([runningComfy({ openPort: true })] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 1,
        customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: TARGET }],
      });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    });

    it('defers the write while a lifecycle command is regenerating the env', async () => {
      // The sync runs from inside the restart command, which already wrote the
      // env. Binding now would be undone: settleCommandOutcome clears
      // pendingRestart when the command lands, leaving the row bound, the badge
      // clear and the env stale — and `next === current` never raises it again.
      appsRepository.getApps.mockResolvedValue([runningComfy({ status: 'restarting' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 1,
        customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: TARGET }],
      });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    });

    it('leaves the row alone when a command claimed the app during the CI-Cloud round trip', async () => {
      // The status the deferral above checks is a SNAPSHOT taken before syncState,
      // which retries with backoff and can take seconds. A restart begun inside that
      // window is still `running` in the array, so the guard cannot see it. The write
      // is conditional on the status not having moved, and when it has, the row must
      // be left exactly as it was for the next sync to re-derive — otherwise
      // settleCommandOutcome clears the badge and `next === current` never raises it
      // again.
      appsRepository.getApps.mockResolvedValue([runningComfy()] as any);
      appsRepository.updateAppByIdIfStatus.mockResolvedValue(false);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 1,
        customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: TARGET }],
      });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(7, 'running', { customDomain: 'comfy.acme.com', pendingRestart: true });
      // No badge event for a write that did not land.
      expect(sseService.emit).not.toHaveBeenCalledWith('app', expect.objectContaining({ event: 'custom_domain_changed' }));
    });

    it('holds a live binding when CI-Cloud reports the same domain against two apps', async () => {
      // A rebind caught in flight. The domain is dropped from both targets, which
      // makes this app look like one whose target was never delivered — but for an
      // app ALREADY serving on that hostname the two are not the same instruction.
      // Unbinding here takes a live customer hostname off the air because a sibling
      // app briefly claimed the same name.
      appsRepository.getApps.mockResolvedValue([runningComfy({ customDomain: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 1,
        customDomains: [
          { id: 'cd_1', domain: 'comfy.acme.com', targetHostname: TARGET },
          { id: 'cd_2', domain: 'comfy.acme.com', targetHostname: 'openwebui-core2-acme.companionintelligence.com' },
        ],
      });

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    });

    it('does not warn that a delivered domain matches no app when the app is merely stopped', async () => {
      // The warning means "Companion Portal wired a hostname no app on this Hub answers
      // for". An app that is here but absent from this payload — stopped, or
      // excluded for a release pass — is not that, and telling the operator to
      // check settings that are correct is how a working feature looks broken.
      logger.warn.mockClear();
      appsRepository.getApps.mockResolvedValue([runningComfy({ status: 'stopped', customDomain: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 0,
        customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: TARGET }],
      });

      await service.triggerCloudflareSync();

      expect(logger.warn.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain('match no app on this Hub');
    });
  });

  describe('custom domain install-time intents', () => {
    const REGISTRATION = {
      id: 'org-1',
      slug: 'acme',
      hubSubdomain: 'core2-acme',
      tunnelId: 'tunnel-123',
      tunnelToken: 'token',
    };

    const CONFIG = {
      userSettings: { domain: 'companionintelligence.com', localDomain: 'ci.lan' },
      localDomain: 'ci.lan',
      domain: 'companionintelligence.com',
    };

    const TARGET = 'comfyui-core2-acme.companionintelligence.com';

    const wantsComfy = (overrides: Record<string, unknown> = {}) => ({
      id: 7,
      appName: 'comfyui',
      appStoreSlug: 'ci-marketplace',
      localSubdomain: 'comfyui',
      exposedLocal: true,
      exposureMode: 'cloudflare',
      openPort: false,
      status: 'running',
      port: 80,
      customDomain: null,
      customDomainIntent: 'comfy.acme.com',
      ...overrides,
    });

    /** A connected, verified, unbound domain — what a parked row looks like. */
    const parked = (overrides: Record<string, unknown> = {}) => ({
      id: 'cd_1',
      domain: 'comfy.acme.com',
      state: 'parked' as const,
      bindable: true,
      targetHostname: null,
      boundAppSlug: null,
      boundElsewhere: false,
      ...overrides,
    });

    beforeEach(() => {
      registrationService.getDeviceRegistrationInfo.mockResolvedValue(REGISTRATION as any);
      configService.getConfig.mockReturnValue(CONFIG as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: true, failed: [], failures: [], synced: 1, customDomains: [] });
      cloudflareClientService.bindCustomDomain.mockResolvedValue({ ok: true } as any);
    });

    it('asks CI-Cloud to wire the chosen domain once the app has been registered', async () => {
      appsRepository.getApps.mockResolvedValue([wantsComfy()] as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([parked()] as any);

      await service.triggerCloudflareSync();

      // The domain's id and the app's SUBDOMAIN — never a hostname. Companion Portal
      // composes the target from rows it owns; a Hub that named one would be
      // asserting something it cannot know. The organization is named too: a
      // device can be registered to more than one, and Companion Portal refuses to guess.
      expect(cloudflareClientService.bindCustomDomain).toHaveBeenCalledWith('cd_1', 'comfyui', 'org-1');
      expect(cloudflareClientService.fetchOrganizationCustomDomains).toHaveBeenCalledWith('org-1');
    });

    it('never writes the binding itself — only a delivered sync may do that', async () => {
      /*
       * This is the safety property of the whole feature. A successful bind means
       * Companion Portal moved the alias; whether the tunnel answers for it is reported
       * by the NEXT sync. Writing `custom_domain` here would have the app emit
       * APP_PUBLIC_URL — and sign OAuth redirects — for a name that may not
       * resolve to this tunnel at all.
       */
      appsRepository.getApps.mockResolvedValue([wantsComfy()] as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([parked()] as any);

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
    });

    it('costs nothing once the choice has been delivered', async () => {
      appsRepository.getApps.mockResolvedValue([wantsComfy({ customDomain: 'comfy.acme.com' })] as any);
      cloudflareClientService.syncState.mockResolvedValue({
        ok: true,
        failed: [],
        failures: [],
        synced: 1,
        customDomains: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: TARGET }],
      });

      await service.triggerCloudflareSync();

      // Not even the listing: this is the steady state for the life of the app,
      // on every heartbeat.
      expect(cloudflareClientService.fetchOrganizationCustomDomains).not.toHaveBeenCalled();
      expect(cloudflareClientService.bindCustomDomain).not.toHaveBeenCalled();
    });

    it('does not ask again while CI-Cloud already points the domain here', async () => {
      // Bound but not yet reported delivered — the ingress clone lands on the
      // next sync. Asking again spends a Cloudflare call per heartbeat.
      appsRepository.getApps.mockResolvedValue([wantsComfy()] as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([parked({ state: 'live', targetHostname: TARGET })] as any);

      await service.triggerCloudflareSync();

      expect(cloudflareClientService.bindCustomDomain).not.toHaveBeenCalled();
    });

    it('waits, without complaining, while the domain is still verifying', async () => {
      appsRepository.getApps.mockResolvedValue([wantsComfy()] as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([parked({ state: 'pending', bindable: false })] as any);

      await service.triggerCloudflareSync();

      expect(cloudflareClientService.bindCustomDomain).not.toHaveBeenCalled();
      // The choice survives: verification is a person finishing a DNS change in
      // their own zone, and it becomes bindable without anyone touching the Hub.
      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
    });

    it('keeps the choice when CI-Cloud could not be asked at all', async () => {
      // An older Companion Portal, an unreachable one, or a payload that would not parse.
      // Clearing here would throw away a person's choice because a request failed.
      appsRepository.getApps.mockResolvedValue([wantsComfy()] as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue(undefined as any);

      await service.triggerCloudflareSync();

      expect(cloudflareClientService.bindCustomDomain).not.toHaveBeenCalled();
      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
    });

    it('clears a choice naming a domain the organization no longer holds', async () => {
      // The listing IS the org's full set, so absence is a fact rather than a
      // gap — and a choice that can only fail forever is worse than none.
      appsRepository.getApps.mockResolvedValue([wantsComfy()] as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([parked({ domain: 'other.acme.com' })] as any);

      await service.triggerCloudflareSync();

      // The confirmation goes with the choice: an answer about a domain the
      // organization no longer holds cannot authorize anything later.
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(7, { customDomainIntent: null, customDomainTakeover: false });
      expect(cloudflareClientService.bindCustomDomain).not.toHaveBeenCalled();
    });

    it('clears the choice when CI-Cloud refuses the domain as unknown', async () => {
      appsRepository.getApps.mockResolvedValue([wantsComfy()] as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([parked()] as any);
      cloudflareClientService.bindCustomDomain.mockResolvedValue({
        ok: false,
        status: 404,
        code: 'DOMAIN_NOT_FOUND',
        message: 'Domain not found',
      } as any);

      await service.triggerCloudflareSync();

      // The confirmation goes with the choice: an answer about a domain the
      // organization no longer holds cannot authorize anything later.
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(7, { customDomainIntent: null, customDomainTakeover: false });
    });

    it('retries a refusal that can clear itself rather than discarding the choice', async () => {
      // The app's first sync can land after this pass, so Companion Portal legitimately
      // does not know it yet. Next heartbeat it will.
      appsRepository.getApps.mockResolvedValue([wantsComfy()] as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([parked()] as any);
      cloudflareClientService.bindCustomDomain.mockResolvedValue({
        ok: false,
        status: 404,
        code: 'APPLICATION_NOT_FOUND',
        message: 'That application is not installed on this device yet',
      } as any);

      await service.triggerCloudflareSync();

      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
    });

    it('never lets two apps chase the same domain', async () => {
      /*
       * This rule prevents a synchronization flap.
       *
       * A domain can serve exactly one app. Two apps both naming it as their
       * choice makes every sync a tug of war: whichever binds last takes it, the
       * delivery reconcile unbinds the loser, the loser becomes a candidate
       * again, and both apps are asked to restart — forever, on every heartbeat.
       *
       * The invariant is enforced where the choice is WRITTEN, so this can only
       * be reached by rows that predate it or a hand-edited database. The pass
       * still refuses to act on both, because a flap is worse than a stale row.
       */
      appsRepository.getApps.mockResolvedValue([wantsComfy(), wantsComfy({ id: 8, appName: 'comfyui-alt', localSubdomain: 'comfyui-alt' })] as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([parked()] as any);

      await service.triggerCloudflareSync();

      expect(cloudflareClientService.bindCustomDomain).toHaveBeenCalledTimes(1);
      // Deterministic, not arbitrary: the same app wins every pass, so the
      // binding settles instead of oscillating between them.
      expect(cloudflareClientService.bindCustomDomain).toHaveBeenCalledWith('cd_1', 'comfyui', 'org-1');
    });

    it('does not ask for an app CI-Cloud was never told about', async () => {
      // Stopped, so it is not in this sync's payload — Companion Portal cannot wire a
      // domain to an app it was not asked about, and the choice waits.
      appsRepository.getApps.mockResolvedValue([wantsComfy({ status: 'stopped' })] as any);

      await service.triggerCloudflareSync();

      expect(cloudflareClientService.fetchOrganizationCustomDomains).not.toHaveBeenCalled();
      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
    });

    it('does not ask for an app that emits no public identity', async () => {
      appsRepository.getApps.mockResolvedValue([wantsComfy({ openPort: true })] as any);

      await service.triggerCloudflareSync();

      expect(cloudflareClientService.fetchOrganizationCustomDomains).not.toHaveBeenCalled();
    });

    it('does nothing at all when the sync itself failed', async () => {
      appsRepository.getApps.mockResolvedValue([wantsComfy()] as any);
      cloudflareClientService.syncState.mockResolvedValue({ ok: false, failed: [], failures: [], synced: 0 } as any);

      await service.triggerCloudflareSync();

      expect(cloudflareClientService.fetchOrganizationCustomDomains).not.toHaveBeenCalled();
    });

    /*
     * ── MOVING A DOMAIN OFF WHATEVER IS SERVING IT ─────────────────────────
     *
     * CI-Engineering#208, defects 3 and 4. The pass read `bindable` and
     * `targetHostname` and nothing else, so a domain live on a sibling Hub was
     * retargeted by a background heartbeat with no confirmation anywhere — and
     * an operator re-pointing a domain in the portal had it taken straight back
     * on the Hub's next sync, indefinitely.
     */
    const servingElsewhere = (overrides: Record<string, unknown> = {}) =>
      parked({
        state: 'live',
        targetHostname: 'grafana-core9-acme.companionintelligence.com',
        boundAppSlug: null,
        boundElsewhere: true,
        ...overrides,
      });

    it('refuses to move a domain that is serving another Hub, and clears the unconfirmed choice', async () => {
      appsRepository.getApps.mockResolvedValue([wantsComfy({ customDomainTakeover: false })] as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([servingElsewhere()] as any);

      await service.triggerCloudflareSync();

      expect(cloudflareClientService.bindCustomDomain).not.toHaveBeenCalled();
      // Cleared, not retained: retaining would re-ask on every heartbeat forever
      // for a move nothing a background pass can reach will ever authorize.
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(7, { customDomainIntent: null, customDomainTakeover: false });
    });

    it('leaves a portal re-point alone instead of taking the domain back every heartbeat', async () => {
      /*
       * Defect 3 exactly: the domain now points at a DIFFERENT app, because
       * somebody moved it in CI-Cloud. Nothing had cleared the intent that was
       * satisfied before the move, so the pass re-POSTed the original bind and
       * the portal's change was undone on the next sync, forever.
       */
      appsRepository.getApps.mockResolvedValue([wantsComfy({ customDomain: null, customDomainTakeover: false })] as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([
        servingElsewhere({ boundElsewhere: false, boundAppSlug: 'grafana' }),
      ] as any);

      await service.triggerCloudflareSync();

      expect(cloudflareClientService.bindCustomDomain).not.toHaveBeenCalled();
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(7, { customDomainIntent: null, customDomainTakeover: false });
    });

    it('moves the domain when the operator confirmed it, and spends the confirmation', async () => {
      appsRepository.getApps.mockResolvedValue([wantsComfy({ customDomainTakeover: true })] as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([servingElsewhere()] as any);

      await service.triggerCloudflareSync();

      expect(cloudflareClientService.bindCustomDomain).toHaveBeenCalledWith('cd_1', 'comfyui', 'org-1');
      /*
       * ⚠ SPENT, NOT LEFT STANDING. It authorized the one move the person was
       * shown; carried forward it would overrule a portal re-point weeks later
       * with an answer given to a different question.
       */
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(7, { customDomainTakeover: false });
    });

    it('does not treat an app renaming itself as a takeover', async () => {
      /*
       * ⚠ THE REGRESSION A `targetHostname`-ONLY GUARD CAUSES, and it fires on the
       * most ordinary operation there is.
       *
       * `toPublicHostname` is composed from the app's local subdomain, its public
       * domain, the hub subdomain and the org slug — so renaming ANY of them moves
       * the app's own target. For one sync CI-Cloud still reports the domain
       * against the OLD hostname, which a target comparison reads as "serving
       * something else": the intent would be cleared, the customer's domain
       * orphaned against a dead ingress, and the log line would accuse the app of
       * stealing from itself. On `dev` the pass simply re-pointed it and the
       * rename was self-healing.
       *
       * `boundAppSlug` is CI-Cloud's own answer to whose it is, so it survives a
       * rename that a hostname comparison cannot.
       */
      appsRepository.getApps.mockResolvedValue([wantsComfy({ customDomain: null, customDomainTakeover: false })] as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([
        parked({
          state: 'live',
          // The app's own previous hostname, before the subdomain was renamed.
          targetHostname: 'comfyui-old-core2-acme.companionintelligence.com',
          boundAppSlug: 'comfyui',
          boundElsewhere: false,
        }),
      ] as any);

      await service.triggerCloudflareSync();

      expect(cloudflareClientService.bindCustomDomain).toHaveBeenCalledWith('cd_1', 'comfyui', 'org-1');
      expect(appsRepository.updateAppById).not.toHaveBeenCalledWith(7, expect.objectContaining({ customDomainIntent: null }));
    });

    it('still binds a parked domain with no confirmation, because nothing is being moved', async () => {
      // The ordinary case must not be made to require an answer nobody was asked.
      appsRepository.getApps.mockResolvedValue([wantsComfy({ customDomainTakeover: false })] as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([parked()] as any);

      await service.triggerCloudflareSync();

      expect(cloudflareClientService.bindCustomDomain).toHaveBeenCalledWith('cd_1', 'comfyui', 'org-1');
    });
  });

  describe('releasing a custom domain', () => {
    const REGISTRATION = { id: 'org-1', slug: 'acme', hubSubdomain: 'core2-acme', tunnelId: 't', tunnelToken: 'k' };

    const servingApp = (overrides: Record<string, unknown> = {}) => ({
      id: 7,
      appName: 'comfyui',
      appStoreSlug: 'ci-marketplace',
      localSubdomain: 'comfyui',
      customDomain: 'comfy.acme.com',
      customDomainIntent: 'comfy.acme.com',
      ...overrides,
    });

    beforeEach(() => {
      registrationService.getDeviceRegistrationInfo.mockResolvedValue(REGISTRATION as any);
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([
        { id: 'cd_1', domain: 'comfy.acme.com', state: 'live', bindable: true, targetHostname: 'x', boundAppSlug: 'comfyui', boundElsewhere: false },
      ] as any);
      cloudflareClientService.unbindCustomDomain.mockResolvedValue({ ok: true } as any);
    });

    it("names the domain by CI-Cloud's row id and the app by its subdomain", async () => {
      const result = await exposureSyncService.releaseCustomDomain(servingApp() as any);

      // The row id travels back too, for the release's audit line.
      expect(result).toEqual({ ok: true, portalRowId: 'cd_1' });
      expect(cloudflareClientService.unbindCustomDomain).toHaveBeenCalledWith('cd_1', 'comfyui', 'org-1');
    });

    it('does nothing when the app is not serving a domain', async () => {
      // Clearing a picker that was never satisfied is the ordinary case, not an
      // error, and it must not spend a CI-Cloud call.
      const result = await exposureSyncService.releaseCustomDomain(servingApp({ customDomain: null }) as any);

      expect(result).toEqual({ ok: true });
      expect(cloudflareClientService.unbindCustomDomain).not.toHaveBeenCalled();
    });

    it('refuses rather than claiming success when CI-Cloud does not list the domain', async () => {
      /*
       * ⚠ THE TEMPTING READING IS THE UNSAFE ONE. "Not in the listing" looks like
       * "already gone, so we are done" — but the listing DROPS rows it cannot
       * parse, and `parseAvailableCustomDomains` requires a non-empty string
       * `id` for a field this codebase already records as arriving as a number
       * on a sibling endpoint. One malformed row among good ones is dropped
       * silently.
       *
       * Reporting success there clears the binding while CI-Cloud goes on
       * serving the domain, which is exactly what this method's contract
       * forbids — and it self-heals wrongly: the next reconcile re-adopts the
       * domain, so the operator watches the thing they released come back.
       *
       * The genuinely-gone case still resolves one sync later, safely, when
       * reconciliation clears `custom_domain` and there is nothing left to
       * release.
       */
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([] as any);

      const result = await exposureSyncService.releaseCustomDomain(servingApp() as any);

      expect(result.ok).toBe(false);
      expect(cloudflareClientService.unbindCustomDomain).not.toHaveBeenCalled();
    });

    it('refuses when CI-Cloud reports the domain serving a different app', async () => {
      /*
       * `custom_domain` is a mirror and mirrors go stale. An operator who moves
       * the domain to a sibling app and then opens THIS app's settings before the
       * next sync is still shown it as current — and clearing the picker would
       * fire an irreversible release naming a domain that now serves something
       * else. CI-Cloud would refuse, but the answer is already in the listing.
       */
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([
        { id: 'cd_1', domain: 'comfy.acme.com', state: 'live', bindable: true, targetHostname: 'x', boundAppSlug: 'grafana', boundElsewhere: false },
      ] as any);

      const result = await exposureSyncService.releaseCustomDomain(servingApp() as any);

      expect(result.ok).toBe(false);
      expect(cloudflareClientService.unbindCustomDomain).not.toHaveBeenCalled();
    });

    it('refuses when CI-Cloud reports the domain serving another Hub', async () => {
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue([
        { id: 'cd_1', domain: 'comfy.acme.com', state: 'live', bindable: true, targetHostname: 'x', boundAppSlug: null, boundElsewhere: true },
      ] as any);

      const result = await exposureSyncService.releaseCustomDomain(servingApp() as any);

      expect(result.ok).toBe(false);
      expect(cloudflareClientService.unbindCustomDomain).not.toHaveBeenCalled();
    });

    it('reports failure rather than throwing when CI-Cloud cannot be asked', async () => {
      // A release that did not happen must leave the binding alone, or the app
      // stops publishing a hostname CI-Cloud is still serving on its behalf.
      cloudflareClientService.fetchOrganizationCustomDomains.mockResolvedValue(undefined as any);

      const result = await exposureSyncService.releaseCustomDomain(servingApp() as any);

      expect(result.ok).toBe(false);
      expect(cloudflareClientService.unbindCustomDomain).not.toHaveBeenCalled();
    });

    it('says so plainly when CI-Cloud holds the domain against something else', async () => {
      cloudflareClientService.unbindCustomDomain.mockResolvedValue({
        ok: false,
        code: 'DOMAIN_NOT_BOUND_HERE',
        message: 'no',
      } as any);

      const result = await exposureSyncService.releaseCustomDomain(servingApp() as any);

      expect(result).toMatchObject({ ok: false, message: expect.stringContaining('not currently serving this app') });
    });
  });

  describe('triggerCloudflareSync during device restore', () => {
    it('skips sync while restore intent is active and rehydration is incomplete', async () => {
      vi.spyOn(registrationRecoveryState, 'hasRestoreIntent').mockResolvedValue(true);
      vi.spyOn(registrationRecoveryState, 'readRehydrationState').mockResolvedValue(null);

      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'myorg',
        hubSubdomain: 'hub-myorg',
      } as any);

      await service.triggerCloudflareSync();

      expect(cloudflareClientService.syncState).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Issue #498 — updateAppConfig auto-restart tests
  // ────────────────────────────────────────────────────────────────────────
  describe('updateAppConfig — auto-restart on settings save', () => {
    const appUrn = 'myapp:ci-marketplace' as any;
    const baseAppInfo = {
      id: 'myapp',
      port: 8080,
      cihub_app_version: 1,
      exposable: true,
      supported_architectures: ['amd64'],
    };

    beforeEach(() => {
      configService.getConfig.mockReturnValue({
        isProduction: false,
        userSettings: { localDomain: 'lan' },
      } as any);
      appFilesManager.getInstalledAppInfo.mockResolvedValue(baseAppInfo as any);
      appEventsQueue.publish.mockResolvedValue({ success: true, message: 'OK' } as any);
      appsRepository.getAppsByDomain.mockResolvedValue([]);
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
      appsRepository.getAppsByPort.mockResolvedValue([]);
      appsRepository.updateAppById.mockImplementation(async (_id, patch) => ({ id: 1, ...patch }) as any);
      registrationService.getDeviceRegistrationInfo.mockResolvedValue(null as any);
      appsRepository.getApps.mockResolvedValue([]);
    });

    it('takes a custom-domain choice off whatever app held it before', async () => {
      /*
       * This invariant is enforced where the choice is made. A domain serves one
       * app. The picker deliberately offers one that is already serving something
       * — naming that app beside it — because moving a domain is legitimate; this
       * is what makes it a move rather than two apps fighting over it on every
       * sync, each demanding a restart.
       */
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080 } } as any);

      // Publicly routed, which is the only shape the picker is ever offered for:
      // a domain is delivered by cloning this app's tunnel ingress rule, so an app
      // that publishes none has nothing for one to alias.
      await service.updateAppConfig({
        actor: TEST_ACTOR,
        appUrn,
        form: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false, customDomain: 'comfy.acme.com' },
      });

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ customDomainIntent: 'comfy.acme.com' }));
      expect(appsRepository.clearCustomDomainIntentElsewhere).toHaveBeenCalledWith(1, 'comfy.acme.com');
    });

    it('treats the confirmation itself as a change, so answering the question is not a no-op save', async () => {
      /*
       * `toStoredConfig` deliberately keeps `customDomainTakeover` out of the
       * snapshot, so `hasConfigChanged` cannot see it. Comparing only hostnames
       * meant a save whose ONLY new information was the operator answering the
       * takeover question — re-picking the domain already recorded as the intent
       * and confirming the move this time — matched on every term, short-circuited
       * at "no changes detected", and returned a success toast having written
       * nothing. The bind pass then read the unwritten `false` as a refusal and
       * cleared the choice.
       */
      const config = { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false, enableAuth: false };
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        status: 'stopped',
        config,
        customDomainIntent: 'comfy.acme.com',
        customDomainTakeover: false,
      } as any);

      await service.updateAppConfig({
        actor: TEST_ACTOR,
        appUrn,
        form: { ...config, customDomain: 'comfy.acme.com', customDomainTakeover: true },
      } as any);

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ customDomainIntent: 'comfy.acme.com', customDomainTakeover: true }),
      );
    });

    it('refuses a confirmation that arrives with no choice attached', async () => {
      /*
       * An answer with nothing to answer about is standing permission waiting for
       * a future choice. `buildInstallRowPatch` used to spread the form's row
       * fields wholesale, and this field's name happens to match its column — so
       * it wrote straight through and bypassed the rule.
       */
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080 } } as any);

      await service.updateAppConfig({
        actor: TEST_ACTOR,
        appUrn,
        form: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false, customDomainTakeover: true },
      });

      const patch = appsRepository.updateAppById.mock.calls.find(([, value]) => 'config' in (value ?? {}))?.[1] as any;

      // Absent `customDomain` says nothing about the choice, so neither column moves.
      expect(patch).not.toHaveProperty('customDomainTakeover');
      expect(patch).not.toHaveProperty('customDomainIntent');
    });

    it('clears the confirmation when the choice itself is cleared', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080 } } as any);

      await service.updateAppConfig({
        actor: TEST_ACTOR,
        appUrn,
        form: {
          port: 8080,
          exposureMode: 'cloudflare',
          exposedLocal: true,
          openPort: false,
          customDomain: '',
          customDomainTakeover: true,
        },
      });

      const patch = appsRepository.updateAppById.mock.calls.find(([, value]) => 'config' in (value ?? {}))?.[1] as any;

      expect(patch.customDomainIntent).toBeNull();
      expect(patch.customDomainTakeover).toBe(false);
    });

    it('keeps the takeover confirmation out of the stored form snapshot', async () => {
      /*
       * ⚠ THE LOOPHOLE THIS CLOSES, AND IT IS NOT COSMETIC.
       *
       * `config` is the form snapshot, and the settings dialog seeds itself from
       * it. The bind pass SPENDS the confirmation on use, so a copy surviving in
       * the snapshot re-supplies `true` on the next unrelated save and restores
       * it to the column — a one-time answer silently promoted to standing
       * permission, and with it the portal re-point defect all over again
       * (CI-Engineering#208, defect 3): an operator moving the domain in the
       * portal is overruled on the next sync by an answer given weeks earlier to
       * a different question.
       *
       * The column still records it. Only the snapshot must not.
       */
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080 } } as any);

      await service.updateAppConfig({
        actor: TEST_ACTOR,
        appUrn,
        form: {
          port: 8080,
          exposureMode: 'cloudflare',
          exposedLocal: true,
          openPort: false,
          customDomain: 'comfy.acme.com',
          customDomainTakeover: true,
        },
      });

      const patch = appsRepository.updateAppById.mock.calls.find(([, value]) => 'config' in (value ?? {}))?.[1] as any;

      expect(patch.customDomainTakeover).toBe(true);
      expect(patch.config).not.toHaveProperty('customDomainTakeover');
      // Stripped for the same reason, and already was — asserted so the two
      // cannot drift apart.
      expect(patch.config).not.toHaveProperty('customDomain');
    });

    it('ignores a choice on an app that could never be served on it', async () => {
      /*
       * An unmounted picker still submits its value. The field only renders under
       * Cloudflare exposure, but react-hook-form keeps an unmounted field's value —
       * so switching an app to Local after picking a domain sends the choice anyway.
       * Acting on it would take that domain off the app actually serving on it and
       * park it on one the bind pass skips forever.
       */
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080 } } as any);

      await service.updateAppConfig({
        actor: TEST_ACTOR,
        appUrn,
        form: { port: 8080, exposureMode: 'local', exposedLocal: false, openPort: true, customDomain: 'comfy.acme.com' },
      });

      const patch = appsRepository.updateAppById.mock.calls.at(-1)?.[1] ?? {};

      expect(patch).not.toHaveProperty('customDomainIntent');
      expect(appsRepository.clearCustomDomainIntentElsewhere).not.toHaveBeenCalled();
    });

    it('clears the choice when the platform address is chosen, and claims nothing', async () => {
      // An app that HOLDS a choice, so clearing it is a real change: the row is
      // what the save is compared against, not the stored form snapshot.
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        status: 'stopped',
        config: { port: 8080 },
        customDomainIntent: 'comfy.acme.com',
      } as any);

      // The platform address is honourable for ANY app, so this one needs no
      // public route to ask for it — unlike naming a domain.
      await service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: { port: 8080, customDomain: '' } });

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ customDomainIntent: null }));
      expect(appsRepository.clearCustomDomainIntentElsewhere).not.toHaveBeenCalled();
    });

    it('releases the domain the operator was shown', async () => {
      // The whole point of the compare-and-swap is that the ordinary save still
      // works: the picker saw `shop.acme.com`, said so, and the row agrees.
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        status: 'stopped',
        config: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false },
        customDomain: 'shop.acme.com',
      } as any);
      const release = vi.spyOn(exposureSyncService, 'releaseCustomDomain').mockResolvedValue({ ok: true });

      await service.updateAppConfig({
        actor: TEST_ACTOR,
        appUrn,
        form: {
          port: 8080,
          exposureMode: 'cloudflare',
          exposedLocal: true,
          openPort: false,
          customDomain: '',
          customDomainExpected: 'shop.acme.com',
        },
      } as any);

      expect(release).toHaveBeenCalled();
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, { customDomain: null, customDomainIntent: null, customDomainTakeover: false });
    });

    it('refuses the save when the row gained a domain while the dialog was open', async () => {
      /*
       * R2-HUBDOMAINS-3, through the settings dialog this time — the fail-unsafe
       * race itself. `''` was seeded from a snapshot taken when the dialog opened
       * on a domainless app; by the time the operator saved an unrelated env var,
       * an admin had bound `shop.acme.com` in the Portal and the Hub had mirrored
       * it. Refusing the whole save is the point: the operator reloads, sees the
       * domain that appeared, and decides again.
       */
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        status: 'stopped',
        config: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false },
        customDomain: 'shop.acme.com',
        customDomainIntent: null,
      } as any);
      const release = vi.spyOn(exposureSyncService, 'releaseCustomDomain').mockResolvedValue({ ok: true });

      await expect(
        service.updateAppConfig({
          actor: TEST_ACTOR,
          appUrn,
          form: {
            port: 8080,
            exposureMode: 'cloudflare',
            exposedLocal: true,
            openPort: false,
            customDomain: '',
            customDomainExpected: '',
          },
        } as any),
      ).rejects.toThrow();

      expect(release).not.toHaveBeenCalled();
      // Nothing is written at all: the release runs before the row write and
      // before `generate_env` is published.
      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
      expect(appEventsQueue.publish).not.toHaveBeenCalled();
    });

    it('refuses to release a DIFFERENT domain than the one the dialog named', async () => {
      // The domain moved between apps while the dialog sat open. The instruction
      // names a hostname this app is no longer on, so it acts on nothing.
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        status: 'stopped',
        config: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false },
        customDomain: 'shop.acme.com',
      } as any);
      const release = vi.spyOn(exposureSyncService, 'releaseCustomDomain').mockResolvedValue({ ok: true });

      await expect(
        service.updateAppConfig({
          actor: TEST_ACTOR,
          appUrn,
          form: {
            port: 8080,
            exposureMode: 'cloudflare',
            exposedLocal: true,
            openPort: false,
            customDomain: '',
            customDomainExpected: 'comfy.acme.com',
          },
        } as any),
      ).rejects.toThrow();

      expect(release).not.toHaveBeenCalled();
    });

    it('canonicalizes the routing subdomain on a settings save too', async () => {
      /*
       * R2-HUBDOMAINS-2. The two install paths disagreed —
       * `port-expose.service.ts` sanitized before the conflict check and this one
       * did not — so a custom app stored the canonical value, a marketplace app
       * stored the raw one, and they collided on one hostname.
       */
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        status: 'stopped',
        config: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false },
      } as any);

      await service.updateAppConfig({
        actor: TEST_ACTOR,
        appUrn,
        form: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false, localSubdomain: 'My-App' },
      } as any);

      expect(appsRepository.getAppsByLocalSubdomain).toHaveBeenCalledWith('my-app', 1);
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ localSubdomain: 'my-app' }));
    });

    it('re-records a choice the Hub cleared, even though the saved snapshot still names it', async () => {
      /*
       * The choice is compared against the row, not the snapshot. The Hub clears
       * `custom_domain_intent` on its own — when the organization disconnects the
       * domain, or when another app claims it — so a person re-picking it submits a
       * form identical to the one last saved. Compared against the snapshot alone
       * that reads as "no changes detected", and the choice is dropped on the floor
       * behind a success toast, every time and with no way to tell.
       */
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        status: 'stopped',
        config: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false },
        customDomainIntent: null,
      } as any);

      await service.updateAppConfig({
        actor: TEST_ACTOR,
        appUrn,
        form: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false, customDomain: 'comfy.acme.com' },
      });

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ customDomainIntent: 'comfy.acme.com' }));
    });

    it('does not store the choice in the config snapshot, so a version bump cannot resurrect it', async () => {
      /*
       * `updateApp` replays `app.config` verbatim through this method. A copy of
       * the choice there would rewrite an intent the Hub had deliberately given up
       * — and `claimCustomDomainIntent` would strip the domain off whichever app
       * legitimately holds it now, on an unrelated version bump.
       */
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080 } } as any);

      await service.updateAppConfig({
        actor: TEST_ACTOR,
        appUrn,
        form: { port: 8080, exposureMode: 'cloudflare', exposedLocal: true, openPort: false, customDomain: 'comfy.acme.com' },
      });

      const patch = appsRepository.updateAppById.mock.calls
        .map((call) => call[1] as { config?: Record<string, unknown> })
        .find((candidate) => candidate?.config !== undefined);

      expect(patch?.config).not.toHaveProperty('customDomain');
      expect(patch).toHaveProperty('customDomainIntent', 'comfy.acme.com');
    });

    it('leaves an existing choice alone when the form says nothing about it', async () => {
      /*
       * Absent does not mean "clear it". Every other field here is rewritten from the
       * form on every save because the dialog sends them all; `customDomain` is
       * sent only by a client that knows about custom domains, so an omitted
       * field must not unbind a domain the customer is being served on.
       */
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080 } } as any);

      await service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: { port: 8080 } });

      const patch = appsRepository.updateAppById.mock.calls.at(-1)?.[1] ?? {};

      expect(patch).not.toHaveProperty('customDomainIntent');
      expect(appsRepository.clearCustomDomainIntentElsewhere).not.toHaveBeenCalled();
    });

    it('applies the manifest edge-auth default when the stored config never decided it (version-bump self-heal, #74)', async () => {
      // updateApp re-submits app.config through updateAppConfig; onboarding-era installs
      // stored no enableAuth key, so the marketplace update that ships edge_auth flips them ON.
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...baseAppInfo, hub_integration: { edge_auth: { default: true } } } as any);
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080 } } as any);

      await service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: { port: 8080 } });

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ enableAuth: true }));
    });

    it('preserves an explicit stored enableAuth=false through the same path (operator choice wins)', async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...baseAppInfo, hub_integration: { edge_auth: { default: true } } } as any);
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080, enableAuth: false } } as any);

      // Another field changes so the update proceeds; the explicit false must survive it.
      await service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: { port: 9090, enableAuth: false } });

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ enableAuth: false }));
    });

    it('does not flip a stored explicit enableAuth=false when a partial update omits the field (#74)', async () => {
      // A PATCH that changes some other field WITHOUT resending enableAuth must inherit the app's
      // stored explicit false, not resolve to the manifest default — "operator choice wins" has to
      // hold for a partial update too, and this must not spuriously restart the app.
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...baseAppInfo, hub_integration: { edge_auth: { default: true } } } as any);
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080, enableAuth: false } } as any);

      await service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: { port: 9090 } }); // no enableAuth in the form

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ enableAuth: false }));
    });

    it('warns about the reset using the RESOLVED settings, not the ones the request arrived with', async () => {
      // The non-exposable reset runs after the edge-auth defaulting has already mutated the form,
      // so the warning must read the resolved values. Reading the destructured copies taken at the
      // top of the method would stay silent here — the request carried no enableAuth, yet an
      // enableAuth of true is exactly what is about to be reset away.
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...baseAppInfo, exposable: false } as any);
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080, enableAuth: true } } as any);

      await service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: { port: 9090 } }); // no exposed/exposedLocal/enableAuth

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not exposable, resetting proxy settings'));
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ enableAuth: false }));
    });

    it('persists the RESET exposure state, not what the request asked for', async () => {
      // The row has to agree with the `config` blob written in the same call. Reading the request
      // snapshot recorded exposed=true and kept the domain for an app the non-exposable reset had
      // just cleared, so the columns claimed a public exposure the app never got.
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...baseAppInfo, exposable: false } as any);
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080 } } as any);

      await service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: { port: 8080, exposed: true, domain: 'app.example.com' } });

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ exposed: false, domain: null }));
    });

    it('stays silent when a non-exposable app has nothing to reset', async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...baseAppInfo, exposable: false } as any);
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080 } } as any);

      await service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: { port: 9090 } });

      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('not exposable, resetting proxy settings'));
    });

    it('re-submitting an already-healed config is a no-op (the default converges, it does not churn)', async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...baseAppInfo, hub_integration: { edge_auth: { default: true } } } as any);
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'stopped', config: { port: 8080, enableAuth: true } } as any);

      await service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: { port: 8080, enableAuth: true } });

      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
    });

    it.each(['running', 'starting', 'restarting'] as const)('triggers restartApp({ skipPull: true }) when app status is "%s"', async (status) => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status, config: { port: 8080 } } as any);
      const restartSpy = vi.spyOn(service, 'restartApp').mockResolvedValue({ requestId: crypto.randomUUID() });

      await service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: { port: 9090 } });

      expect(restartSpy).toHaveBeenCalledWith({ appUrn, skipPull: true });
    });

    it.each([
      'running',
      'starting',
      'restarting',
    ] as const)('does NOT trigger restartApp when app status is "%s" but config is unchanged', async (status) => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status, config: { port: 8080 } } as any);
      const restartSpy = vi.spyOn(service, 'restartApp').mockResolvedValue({ requestId: crypto.randomUUID() });

      await service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: { port: 8080 } });

      expect(restartSpy).not.toHaveBeenCalled();
      expect(appEventsQueue.publish).not.toHaveBeenCalled();
    });

    it.each([
      'stopped',
      'stopping',
      'installing',
      'uninstalling',
      'resetting',
      'updating',
      'missing',
    ] as const)('does NOT trigger restartApp when app status is "%s"', async (status) => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status, config: {} } as any);
      const restartSpy = vi.spyOn(service, 'restartApp').mockResolvedValue({ requestId: crypto.randomUUID() });

      await service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: {} });

      expect(restartSpy).not.toHaveBeenCalled();
    });

    it('returns a requestId even when auto-restart fires', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'running', config: { port: 8080 } } as any);
      vi.spyOn(service, 'restartApp').mockResolvedValue({ requestId: crypto.randomUUID() });

      const result = await service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: { port: 9090 } });

      expect(result).toHaveProperty('requestId');
      expect(typeof result.requestId).toBe('string');
    });

    it('does not restart when app is not found (throws before restart logic)', async () => {
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      const restartSpy = vi.spyOn(service, 'restartApp').mockResolvedValue({ requestId: crypto.randomUUID() });

      await expect(service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: {} })).rejects.toThrow('APP_ERROR_APP_NOT_FOUND');
      expect(restartSpy).not.toHaveBeenCalled();
    });

    it('normalizes local exposure to openPort=true before persistence and generate_env', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        status: 'stopped',
        config: {},
        appName: 'myapp',
        appStoreSlug: 'ci-marketplace',
      } as any);

      await service.updateAppConfig({ actor: TEST_ACTOR, appUrn, form: { exposureMode: 'local', openPort: false, port: 8080 } });

      expect(appEventsQueue.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          form: expect.objectContaining({ exposureMode: 'local', openPort: true, port: 8080 }),
        }),
      );
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          exposureMode: 'local',
          openPort: true,
          port: 8080,
          config: expect.objectContaining({ exposureMode: 'local', openPort: true, port: 8080 }),
        }),
      );
    });

    it('releases previous public DNS before syncing a subdomain change', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        status: 'running',
        appName: 'myapp',
        appStoreSlug: 'ci-marketplace',
        config: { exposureMode: 'cloudflare', localSubdomain: 'old-sub', port: 8080 },
        exposureMode: 'cloudflare',
        exposedLocal: true,
        localSubdomain: 'old-sub',
        port: 8080,
      } as any);
      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'acme',
        hubSubdomain: 'hub1-acme',
      } as any);
      appsRepository.getApps.mockResolvedValue([
        {
          appName: 'myapp',
          appStoreSlug: 'ci-marketplace',
          status: 'running',
          exposureMode: 'cloudflare',
          exposedLocal: true,
          localSubdomain: 'new-sub',
          port: 8080,
        },
      ] as any);
      configService.getConfig.mockReturnValue({
        isProduction: false,
        userSettings: { domain: 'example.com', localDomain: 'ci.lan' },
        domain: 'example.com',
      } as any);
      vi.spyOn(service, 'restartApp').mockResolvedValue({ requestId: crypto.randomUUID() });
      const syncSpy = vi.spyOn(exposureSyncService, 'triggerCloudflareSync').mockResolvedValue(undefined);

      await service.updateAppConfig({
        actor: TEST_ACTOR,
        appUrn,
        form: { exposureMode: 'cloudflare', exposedLocal: true, localSubdomain: 'new-sub', port: 8080 },
      });

      expect(syncSpy).toHaveBeenCalledTimes(2);
      // Both passes claim the restart: `updateAppConfig` fires its own below, and
      // a rename reads inside the reconcile as a lost custom hostname.
      expect(syncSpy).toHaveBeenNthCalledWith(1, {
        excludeAppUrns: ['myapp:ci-marketplace'],
        skipAutoRestartAppUrns: ['myapp:ci-marketplace'],
      });
      expect(syncSpy).toHaveBeenNthCalledWith(2, { skipAutoRestartAppUrns: ['myapp:ci-marketplace'] });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Issue #390 — DB-before-SSE ordering tests
  // ────────────────────────────────────────────────────────────────────────
  describe('lifecycle state ordering (issue #390)', () => {
    const appUrn = 'myapp:ci-marketplace' as any;
    const fakeApp = {
      id: 42,
      appName: 'myapp',
      appStoreSlug: 'ci-marketplace',
      status: 'running' as const,
      config: {},
      exposedLocal: false,
    };
    let callOrder: string[];

    /**
     * Helper: flush the fire-and-forget `.then()` chain that lifecycle methods use.
     * Because publish is mocked to resolve immediately, a single microtask flush suffices.
     */
    const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

    const getUpdateIndexes = () =>
      callOrder.reduce<number[]>((acc, value, index) => {
        if (value === 'db_update') acc.push(index);
        return acc;
      }, []);

    const expectEventAfterNthUpdate = (event: string, updateIndex: number) => {
      const updates = getUpdateIndexes();
      const persistedIndex = updates[updateIndex];
      expect(persistedIndex).toBeDefined();
      expect(callOrder.indexOf(`sse:${event}`)).toBeGreaterThan(persistedIndex ?? -1);
    };

    const expectEventAfterLastUpdate = (event: string) => {
      const updates = getUpdateIndexes();
      const persistedIndex = updates.at(-1);
      expect(persistedIndex).toBeDefined();
      expect(callOrder.indexOf(`sse:${event}`)).toBeGreaterThan(persistedIndex ?? -1);
    };

    beforeEach(() => {
      callOrder = [];

      appsRepository.getAppByUrn.mockResolvedValue(fakeApp as any);
      appsRepository.updateAppById.mockImplementation(async () => {
        callOrder.push('db_update');
        return fakeApp as any;
      });
      // The completion handlers claim their outcome with a compare-and-set;
      // report it as applied so the SSE ordering under test still fires.
      appsRepository.updateAppByIdIfStatus.mockImplementation(async () => {
        callOrder.push('db_update');
        return true;
      });
      appsRepository.deleteAppById.mockImplementation(async () => {
        callOrder.push('db_delete');
      });
      appsRepository.createApp.mockImplementation(async (data: any) => {
        callOrder.push('db_create');
        return { id: 42, ...data } as any;
      });
      appsRepository.getAppById.mockImplementation(async (id: number) => ({ id, status: 'installing' }) as any);

      sseService.emit.mockImplementation((_channel: any, payload: any) => {
        callOrder.push(`sse:${payload.event}`);
      });

      // Default: commands succeed
      appEventsQueue.publish.mockResolvedValue({ success: true, message: 'OK' } as any);

      vi.spyOn(exposureSyncService, 'syncExposurePublic').mockImplementation(async () => {
        callOrder.push('sync_exposure');
      });

      // Default config for install
      configService.getConfig.mockReturnValue({
        isProduction: false,
        architecture: 'amd64',
        userSettings: { localDomain: 'lan' },
      } as any);

      registrationService.getDeviceRegistrationInfo.mockResolvedValue(null as any);
    });

    // ── startApp ──────────────────────────────────────────────────────────
    it('startApp success: DB committed before SSE', async () => {
      await service.startApp({ appUrn });
      await flushMicrotasks();

      const dbIdx = callOrder.indexOf('db_update');
      const sseIdx = callOrder.indexOf('sse:start_success');
      expect(dbIdx).toBeGreaterThanOrEqual(0);
      expect(sseIdx).toBeGreaterThan(dbIdx);
    });

    it('startApp error: DB committed before SSE', async () => {
      appEventsQueue.publish.mockResolvedValue({ success: false, message: 'fail' } as any);

      await service.startApp({ appUrn });
      await flushMicrotasks();

      expectEventAfterNthUpdate('start_error', 1);
    });

    // Reproduces production Sentry issue dfe2be44b8084d35b76c6d1d282c043d (comfyui,
    // failure_phase "start"): the command's errorCode/errorDetail/settingsPath must reach the
    // emitted SSE event, not just its message — otherwise the frontend's Settings deep-link and
    // errorCode-driven i18n (app-actions.tsx) never fire for a start failure.
    it('startApp error: errorCode/errorDetail/settingsPath reach the emitted SSE event', async () => {
      appEventsQueue.publish.mockResolvedValue({
        success: false,
        message: 'This app needs AMD ROCm. Set up ROCm in AI Settings, then retry.',
        errorCode: 'rocm_kfd_missing',
        errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
        settingsPath: '/settings?tab=ai&section=rocm',
      } as any);

      await service.startApp({ appUrn });
      await flushMicrotasks();

      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({
          event: 'start_error',
          errorCode: 'rocm_kfd_missing',
          errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
          settingsPath: '/settings?tab=ai&section=rocm',
        }),
      );
      // The Sentry classification path also needs errorCode — without it, classifyAppFailure
      // has nothing to key off since the friendly message contains no device path or regex hit.
      expect(errorReportingService.reportAppFailure).toHaveBeenCalledWith(expect.objectContaining({ phase: 'start', errorCode: 'rocm_kfd_missing' }));
    });

    it('startApp: transitional status_change emitted after DB commit', async () => {
      await service.startApp({ appUrn });

      const dbIdx = callOrder.indexOf('db_update');
      const sseIdx = callOrder.indexOf('sse:status_change');
      expect(dbIdx).toBeGreaterThanOrEqual(0);
      expect(sseIdx).toBeGreaterThan(dbIdx);
    });

    // ── stopApp ──────────────────────────────────────────────────────────
    it('stopApp success: DB committed before SSE', async () => {
      await service.stopApp({ appUrn });
      await flushMicrotasks();

      expectEventAfterNthUpdate('stop_success', 1);
    });

    it('stopApp error: DB committed before SSE', async () => {
      appEventsQueue.publish.mockResolvedValue({ success: false, message: 'fail' } as any);

      await service.stopApp({ appUrn });
      await flushMicrotasks();

      expectEventAfterNthUpdate('stop_error', 1);
    });

    it('stopApp error: errorCode/errorDetail/settingsPath reach the emitted SSE event', async () => {
      appEventsQueue.publish.mockResolvedValue({
        success: false,
        message: 'This app needs AMD ROCm. Set up ROCm in AI Settings, then retry.',
        errorCode: 'rocm_kfd_missing',
        errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
        settingsPath: '/settings?tab=ai&section=rocm',
      } as any);

      await service.stopApp({ appUrn });
      await flushMicrotasks();

      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({
          event: 'stop_error',
          errorCode: 'rocm_kfd_missing',
          errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
          settingsPath: '/settings?tab=ai&section=rocm',
        }),
      );
    });

    it('stopApp: transitional status_change emitted after DB commit', async () => {
      await service.stopApp({ appUrn });

      const dbIdx = callOrder.indexOf('db_update');
      const sseIdx = callOrder.indexOf('sse:status_change');
      expect(sseIdx).toBeGreaterThan(dbIdx);
    });

    it('forceStopApp error restores the previous app status', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ ...fakeApp, status: 'restarting' } as any);
      appRuntimeMonitor.getAppRuntimeHealth.mockResolvedValue({
        appUrn,
        appName: 'myapp',
        status: 'restarting',
        cpuPercent: 99,
        memoryUsageBytes: 0,
        memoryLimitBytes: 0,
        highCpu: true,
        sustainedHighCpu: true,
        responsive: false,
        degraded: true,
        forceStopEligible: true,
        reason: 'App unresponsive',
        cpuLimit: null,
        usesDefaultCpuLimit: false,
        sampledAt: new Date().toISOString(),
        containers: [],
      } as any);
      dockerService.forceStopApp.mockRejectedValue(new Error('boom'));

      await expect(service.forceStopApp({ appUrn })).rejects.toThrow();

      expect(appsRepository.updateAppById).toHaveBeenLastCalledWith(42, { status: 'restarting' });
      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({ event: 'stop_error', appUrn, appStatus: 'restarting', error: 'boom' }),
      );
    });

    it('forceStopApp acquires the app mutex before running docker operations', async () => {
      appRuntimeMonitor.getAppRuntimeHealth.mockResolvedValue({
        appUrn,
        appName: 'myapp',
        status: 'running',
        cpuPercent: 99,
        memoryUsageBytes: 0,
        memoryLimitBytes: 0,
        highCpu: true,
        sustainedHighCpu: true,
        responsive: false,
        degraded: true,
        forceStopEligible: true,
        reason: 'App unresponsive',
        cpuLimit: null,
        usesDefaultCpuLimit: false,
        sampledAt: new Date().toISOString(),
        containers: [],
      } as any);

      await service.forceStopApp({ appUrn });

      expect(mutex.acquire).toHaveBeenCalledWith(appUrn);
      expect(mutex.acquire).not.toHaveBeenCalledWith('__install-pipeline__');
    });

    // ── restartApp ───────────────────────────────────────────────────────
    it('restartApp success: DB committed before SSE', async () => {
      await service.restartApp({ appUrn });
      await flushMicrotasks();

      expectEventAfterNthUpdate('restart_success', 1);
    });

    it('restartApp error: DB committed before SSE', async () => {
      appEventsQueue.publish.mockResolvedValue({ success: false, message: 'fail' } as any);

      await service.restartApp({ appUrn });
      await flushMicrotasks();

      expectEventAfterNthUpdate('restart_error', 1);
    });

    // A device present at install time can be gone by a later restart (ROCm/KVM modules not
    // yet loaded at boot, host reconfigured) — the classification fields must reach the client
    // the same way they do for start.
    it('restartApp error: errorCode/errorDetail/settingsPath reach the emitted SSE event', async () => {
      appEventsQueue.publish.mockResolvedValue({
        success: false,
        message: 'This app needs AMD ROCm. Set up ROCm in AI Settings, then retry.',
        errorCode: 'rocm_kfd_missing',
        errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
        settingsPath: '/settings?tab=ai&section=rocm',
      } as any);

      await service.restartApp({ appUrn });
      await flushMicrotasks();

      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({
          event: 'restart_error',
          errorCode: 'rocm_kfd_missing',
          errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
          settingsPath: '/settings?tab=ai&section=rocm',
        }),
      );
    });

    it('restartApp: transitional status_change emitted after DB commit', async () => {
      await service.restartApp({ appUrn });

      const dbIdx = callOrder.indexOf('db_update');
      const sseIdx = callOrder.indexOf('sse:status_change');
      expect(sseIdx).toBeGreaterThan(dbIdx);
    });

    // ── startAppAndWait / restartAppAndWait ─────────────────────────────
    // These are separate await-based code paths from startApp/restartApp (used by callers like
    // post-update restart that must block on the outcome, not just publishing) with their own
    // destructure-and-cast of the queue result — worth covering independently of the .then()-based
    // variants above, since a mistake in one does not imply a mistake in the other.
    it('startAppAndWait error: errorCode/errorDetail/settingsPath reach the emitted SSE event', async () => {
      appEventsQueue.publish.mockResolvedValue({
        success: false,
        message: 'This app needs AMD ROCm. Set up ROCm in AI Settings, then retry.',
        errorCode: 'rocm_kfd_missing',
        errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
        settingsPath: '/settings?tab=ai&section=rocm',
      } as any);

      const result = await service.startAppAndWait({ appUrn });

      expect(result).toBe(false);
      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({
          event: 'start_error',
          errorCode: 'rocm_kfd_missing',
          errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
          settingsPath: '/settings?tab=ai&section=rocm',
        }),
      );
    });

    it('restartAppAndWait error: errorCode/errorDetail/settingsPath reach the emitted SSE event', async () => {
      appEventsQueue.publish.mockResolvedValue({
        success: false,
        message: 'This app needs AMD ROCm. Set up ROCm in AI Settings, then retry.',
        errorCode: 'rocm_kfd_missing',
        errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
        settingsPath: '/settings?tab=ai&section=rocm',
      } as any);

      const result = await service.restartAppAndWait({ appUrn });

      expect(result).toBe(false);
      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({
          event: 'restart_error',
          errorCode: 'rocm_kfd_missing',
          errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
          settingsPath: '/settings?tab=ai&section=rocm',
        }),
      );
    });

    // ── uninstallApp ─────────────────────────────────────────────────────
    it('uninstallApp success: syncs exposure before uninstall_success SSE', async () => {
      await service.uninstallApp({ appUrn, deleteAllData: true });
      await flushMicrotasks();

      const delIdx = callOrder.indexOf('db_delete');
      const syncIdx = callOrder.indexOf('sync_exposure');
      const sseIdx = callOrder.indexOf('sse:uninstall_success');
      expect(delIdx).toBeGreaterThanOrEqual(0);
      expect(syncIdx).toBeGreaterThan(delIdx);
      expect(sseIdx).toBeGreaterThan(syncIdx);
      expect(backupManager.deleteAppBackupsByUrn).toHaveBeenCalledWith(appUrn);
      expect(appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({ command: 'uninstall', appUrn, deleteAllData: true }));
    });

    it('uninstallApp error: DB committed before SSE', async () => {
      appEventsQueue.publish.mockResolvedValue({ success: false, message: 'fail' } as any);

      await service.uninstallApp({ appUrn, deleteAllData: false });
      await flushMicrotasks();

      expectEventAfterNthUpdate('uninstall_error', 1);
      // Backups follow the data choice: preserving app data/volumes preserves the backups too (#908).
      expect(backupManager.deleteAppBackupsByUrn).not.toHaveBeenCalled();
      expect(appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({ command: 'uninstall', appUrn, deleteAllData: false }));
    });

    it('uninstallApp error: errorCode/errorDetail/settingsPath reach the emitted SSE event', async () => {
      appEventsQueue.publish.mockResolvedValue({
        success: false,
        message: 'This app needs AMD ROCm. Set up ROCm in AI Settings, then retry.',
        errorCode: 'rocm_kfd_missing',
        errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
        settingsPath: '/settings?tab=ai&section=rocm',
      } as any);

      await service.uninstallApp({ appUrn, deleteAllData: false });
      await flushMicrotasks();

      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({
          event: 'uninstall_error',
          errorCode: 'rocm_kfd_missing',
          errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
          settingsPath: '/settings?tab=ai&section=rocm',
        }),
      );
    });

    // Each scenario is its own `it` so a regression in one reports independently —
    // packed into a single test, an early failure hides whether the later rules still hold.
    it('keeps backups when the user chose to keep the data (#908)', async () => {
      await service.uninstallApp({ appUrn, deleteAllData: false });
      await flushMicrotasks();

      expect(backupManager.deleteAppBackupsByUrn).not.toHaveBeenCalled();
    });

    it('keeps backups when the uninstall FAILED, even with deleteAllData (#908)', async () => {
      // The app and all of its live data survive a failed uninstall, so the safety net
      // has to survive with it. Deleting before the worker ran left the app installed
      // but unrecoverable.
      appEventsQueue.publish.mockResolvedValueOnce({ success: false, message: 'fail' } as any);

      await service.uninstallApp({ appUrn, deleteAllData: true });
      await flushMicrotasks();

      expect(backupManager.deleteAppBackupsByUrn).not.toHaveBeenCalled();
    });

    it('keeps backups when the data wipe was only partial (#908)', async () => {
      // A remnant means the app's data demonstrably survived on disk. Discarding its
      // backups here is the same inversion at the other end: data kept, safety net gone.
      appEventsQueue.publish.mockResolvedValueOnce({
        success: true,
        message: 'partial',
        warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT',
        warningDetail: '/srv/app-data/store/app',
      } as any);

      await service.uninstallApp({ appUrn, deleteAllData: true });
      await flushMicrotasks();

      expect(backupManager.deleteAppBackupsByUrn).not.toHaveBeenCalled();
    });

    it('discards backups on a clean delete-all-data uninstall (#908)', async () => {
      await service.uninstallApp({ appUrn, deleteAllData: true });
      await flushMicrotasks();

      expect(backupManager.deleteAppBackupsByUrn).toHaveBeenCalledWith(appUrn);
    });

    it('warns instead of claiming a clean removal when the backups could not be deleted (#908)', async () => {
      // The user asked for every trace of the app to go. If the archives survive, saying
      // "uninstalled successfully" is a lie — reuse the #907 remnant channel.
      backupManager.deleteAppBackupsByUrn.mockRejectedValueOnce(new Error('EACCES'));
      backupManager.getAppBackupsHostDir.mockReturnValueOnce('/srv/hub/backups/store/app');

      await service.uninstallApp({ appUrn, deleteAllData: true });
      await flushMicrotasks();

      // The detail must travel with the code: the client only renders an actionable
      // manual-cleanup command when a path is present, and falls back to a generic
      // "some files remain" toast without one. It must point at the BACKUP directory —
      // this arm fires only when the app-data wipe already succeeded.
      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({
          event: 'uninstall_success',
          warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT',
          warningDetail: '/srv/hub/backups/store/app',
        }),
      );
    });

    it('still warns when the backups host path cannot be resolved, just without a command (#908)', async () => {
      // A misconfigured (non-absolute) ROOT_FOLDER_HOST yields no path. Guidance is
      // best-effort: the warning must survive, degrading to the generic toast.
      backupManager.deleteAppBackupsByUrn.mockRejectedValueOnce(new Error('EACCES'));
      backupManager.getAppBackupsHostDir.mockReturnValueOnce(undefined);

      await service.uninstallApp({ appUrn, deleteAllData: true });
      await flushMicrotasks();

      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({ event: 'uninstall_success', warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT', warningDetail: undefined }),
      );
    });

    it('uninstallApp success: threads the command warningCode + warningDetail into the uninstall_success SSE (#907)', async () => {
      appEventsQueue.publish.mockResolvedValueOnce({
        success: true,
        message: 'partial',
        warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT',
        warningDetail: '/srv/app-data/store/app',
      } as any);

      await service.uninstallApp({ appUrn, deleteAllData: true });
      await flushMicrotasks();

      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({
          event: 'uninstall_success',
          appUrn,
          warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT',
          warningDetail: '/srv/app-data/store/app',
        }),
      );
    });

    // ── resetApp ─────────────────────────────────────────────────────────
    it('resetApp success: DB committed before SSE', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ ...fakeApp, status: 'stopped' } as any);

      await service.resetApp({ appUrn });
      await flushMicrotasks();

      expectEventAfterLastUpdate('reset_success');
    });

    it('resetApp error: DB committed before SSE', async () => {
      appEventsQueue.publish.mockResolvedValue({ success: false, message: 'fail' } as any);

      await service.resetApp({ appUrn });
      await flushMicrotasks();

      expectEventAfterNthUpdate('reset_error', 1);
    });

    it('resetApp error restores the previous status in the SSE payload', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ ...fakeApp, status: 'stopped' } as any);
      appEventsQueue.publish.mockResolvedValue({ success: false, message: 'fail' } as any);

      await service.resetApp({ appUrn });
      await flushMicrotasks();

      expect(sseService.emit).toHaveBeenCalledWith('app', expect.objectContaining({ event: 'reset_error', appStatus: 'stopped', error: 'fail' }));
    });

    it('resetApp error: errorCode/errorDetail/settingsPath reach the emitted SSE event', async () => {
      appEventsQueue.publish.mockResolvedValue({
        success: false,
        message: 'This app needs AMD ROCm. Set up ROCm in AI Settings, then retry.',
        errorCode: 'rocm_kfd_missing',
        errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
        settingsPath: '/settings?tab=ai&section=rocm',
      } as any);

      await service.resetApp({ appUrn });
      await flushMicrotasks();

      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({
          event: 'reset_error',
          errorCode: 'rocm_kfd_missing',
          errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
          settingsPath: '/settings?tab=ai&section=rocm',
        }),
      );
    });

    it('resetApp: transitional status_change emitted after DB commit', async () => {
      await service.resetApp({ appUrn });

      const dbIdx = callOrder.indexOf('db_update');
      const sseIdx = callOrder.indexOf('sse:status_change');
      expect(sseIdx).toBeGreaterThan(dbIdx);
    });

    // ── installApp ───────────────────────────────────────────────────────
    it('installApp success: DB committed before SSE', async () => {
      const baseAppInfo = { id: 'myapp', port: 8080, cihub_app_version: 1, exposable: true, supported_architectures: ['amd64'] };
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(baseAppInfo as any);
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      appsRepository.getAppsByDomain.mockResolvedValue([]);
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
      appsRepository.getAppsByPort.mockResolvedValue([]);
      appsRepository.getApps.mockResolvedValue([]);

      await service.installApp({ actor: TEST_ACTOR, appUrn, form: {} });
      await flushMicrotasks();

      const createIdx = callOrder.indexOf('db_create');
      const statusChangeIdx = callOrder.indexOf('sse:status_change');
      const updateIdx = callOrder.indexOf('db_update');
      const successIdx = callOrder.indexOf('sse:install_success');

      // status_change emitted after DB create
      expect(statusChangeIdx).toBeGreaterThan(createIdx);
      // DB update to 'running' before install_success SSE
      expect(successIdx).toBeGreaterThan(updateIdx);
    });

    it('installApp error: keeps app record as install_failed before SSE', async () => {
      const baseAppInfo = { id: 'myapp', port: 8080, cihub_app_version: 1, exposable: true, supported_architectures: ['amd64'] };
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(baseAppInfo as any);
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      appsRepository.getApps.mockResolvedValue([]);
      appsRepository.getAppsByDomain.mockResolvedValue([]);
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
      appsRepository.getAppsByPort.mockResolvedValue([]);
      appEventsQueue.publish.mockResolvedValue({ success: false, message: 'fail' } as any);

      await service.installApp({ actor: TEST_ACTOR, appUrn, form: {} });
      await flushMicrotasks();

      expect(callOrder).not.toContain('db_delete');
      const updateIdx = callOrder.indexOf('db_update');
      const sseIdx = callOrder.indexOf('sse:install_error');
      expect(updateIdx).toBeGreaterThanOrEqual(0);
      expect(sseIdx).toBeGreaterThan(updateIdx);
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(42, expect.objectContaining({ status: 'install_failed' }));
    });

    it('installApp error: still emits install_error when install_failed status write fails', async () => {
      const baseAppInfo = { id: 'myapp', port: 8080, cihub_app_version: 1, exposable: true, supported_architectures: ['amd64'] };
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(baseAppInfo as any);
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      appsRepository.getApps.mockResolvedValue([]);
      appsRepository.getAppsByDomain.mockResolvedValue([]);
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
      appsRepository.getAppsByPort.mockResolvedValue([]);
      appEventsQueue.publish.mockResolvedValue({ success: false, message: 'fail' } as any);
      appsRepository.updateAppById.mockImplementation(async (_id, patch) => {
        if (patch?.status === 'install_failed') {
          throw new Error('invalid input value for enum app_status: "install_failed"');
        }
        callOrder.push('db_update');
        return fakeApp as any;
      });

      await service.installApp({ actor: TEST_ACTOR, appUrn, form: {} });
      await flushMicrotasks();

      expect(callOrder).toContain('sse:install_error');
      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({ event: 'install_error', appUrn, appStatus: 'install_failed', error: 'fail' }),
      );
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Failed to persist 'install_failed' status"));
    });

    it('installApp retry: re-queues install when status is install_failed', async () => {
      const baseAppInfo = { id: 'myapp', port: 8080, cihub_app_version: 1, exposable: true, supported_architectures: ['amd64'] };
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(baseAppInfo as any);
      appsRepository.getAppByUrn.mockResolvedValue({ ...fakeApp, status: 'install_failed' } as any);
      appsRepository.getAppsByDomain.mockResolvedValue([]);
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
      appsRepository.getAppsByPort.mockResolvedValue([]);
      appsRepository.getApps.mockResolvedValue([{ ...fakeApp, status: 'install_failed' }] as any);

      await service.installApp({ actor: TEST_ACTOR, appUrn, form: {} });
      await flushMicrotasks();

      expect(appsRepository.createApp).not.toHaveBeenCalled();
      expect(appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({ command: 'install', appUrn }));
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(42, expect.objectContaining({ status: 'installing' }));
    });

    it('installApp retry: syncs exposure from submitted exposedLocal, not stale existing record', async () => {
      const baseAppInfo = { id: 'myapp', port: 8080, cihub_app_version: 1, exposable: true, supported_architectures: ['amd64'] };
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(baseAppInfo as any);
      appsRepository.getAppByUrn.mockResolvedValue({
        ...fakeApp,
        status: 'install_failed',
        exposedLocal: false,
      } as any);
      appsRepository.getAppsByDomain.mockResolvedValue([]);
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
      appsRepository.getAppsByPort.mockResolvedValue([]);
      appsRepository.getApps.mockResolvedValue([]);
      const syncSpy = vi.spyOn(exposureSyncService, 'syncExposurePublic').mockResolvedValue(undefined);

      await service.installApp({ actor: TEST_ACTOR, appUrn, form: { exposedLocal: true } });
      await flushMicrotasks();

      expect(syncSpy).toHaveBeenCalled();
    });

    it('installApp RPC timeout: keeps app record and does not emit install_error', async () => {
      const baseAppInfo = { id: 'myapp', port: 8080, cihub_app_version: 1, exposable: true, supported_architectures: ['amd64'] };
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(baseAppInfo as any);
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      appsRepository.getApps.mockResolvedValue([]);
      appsRepository.getAppsByDomain.mockResolvedValue([]);
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
      appsRepository.getAppsByPort.mockResolvedValue([]);
      appEventsQueue.publish.mockResolvedValue({ success: false, message: 'RPC response timed out' } as any);

      await service.installApp({ actor: TEST_ACTOR, appUrn, form: {} });
      await flushMicrotasks();

      expect(callOrder).not.toContain('db_delete');
      expect(callOrder).not.toContain('sse:install_error');
    });

    it('installApp: status_change emitted after DB create (not before)', async () => {
      const baseAppInfo = { id: 'myapp', port: 8080, cihub_app_version: 1, exposable: true, supported_architectures: ['amd64'] };
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(baseAppInfo as any);
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      appsRepository.getApps.mockResolvedValue([]);
      appsRepository.getAppsByDomain.mockResolvedValue([]);
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
      appsRepository.getAppsByPort.mockResolvedValue([]);

      await service.installApp({ actor: TEST_ACTOR, appUrn, form: {} });

      const createIdx = callOrder.indexOf('db_create');
      const sseIdx = callOrder.indexOf('sse:status_change');
      expect(createIdx).toBeGreaterThanOrEqual(0);
      expect(sseIdx).toBeGreaterThan(createIdx);
    });

    // ── updateApp ────────────────────────────────────────────────────────
    it('updateApp error: DB committed before SSE', async () => {
      appEventsQueue.publish.mockResolvedValue({ success: false, message: 'fail' } as any);

      await service.updateApp({ appUrn, performBackup: false });
      await flushMicrotasks();

      expectEventAfterNthUpdate('update_error', 1);
    });

    it('updateApp error: errorCode/errorDetail/settingsPath reach the emitted SSE event', async () => {
      appEventsQueue.publish.mockResolvedValue({
        success: false,
        message: 'This app needs AMD ROCm. Set up ROCm in AI Settings, then retry.',
        errorCode: 'rocm_kfd_missing',
        errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
        settingsPath: '/settings?tab=ai&section=rocm',
      } as any);

      await service.updateApp({ appUrn, performBackup: false });
      await flushMicrotasks();

      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({
          event: 'update_error',
          errorCode: 'rocm_kfd_missing',
          errorDetail: 'The ROCm compute device (/dev/kfd) was not found on this machine.',
          settingsPath: '/settings?tab=ai&section=rocm',
        }),
      );
    });

    it('updateApp success restores stopped state before emitting update_success', async () => {
      vi.spyOn(service, 'updateAppConfig').mockResolvedValue({ requestId: crypto.randomUUID() });
      vi.spyOn(service, 'startApp').mockResolvedValue({ requestId: crypto.randomUUID() });
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ cihub_app_version: 2 } as any);

      await service.updateApp({ appUrn, performBackup: false });
      await flushMicrotasks();

      expectEventAfterNthUpdate('update_success', 1);
      expect(sseService.emit).toHaveBeenCalledWith('app', expect.objectContaining({ event: 'update_success', appStatus: 'stopped' }));
    });

    it('updateApp downloads fresh app files for ci_cloud_api stores before queueing (#915)', async () => {
      vi.spyOn(service, 'updateAppConfig').mockResolvedValue({ requestId: crypto.randomUUID() });
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ cihub_app_version: 2 } as any);
      appStoreService.getAppStoreBySlug.mockResolvedValue({ slug: 'ci-marketplace', url: 'http://portal/api', type: 'ci_cloud_api' } as any);
      reposHelpers.downloadAppFiles.mockResolvedValue({ success: true, message: 'App files downloaded' } as any);

      await service.updateApp({ appUrn, performBackup: false });
      await flushMicrotasks();

      expect(reposHelpers.downloadAppFiles).toHaveBeenCalledWith('http://portal/api', 'ci-marketplace', 'myapp');
      expect(appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({ command: 'update', appUrn }));
    });

    it('updateApp fails fast when the ci_cloud_api file download fails', async () => {
      appStoreService.getAppStoreBySlug.mockResolvedValue({ slug: 'ci-marketplace', url: 'http://portal/api', type: 'ci_cloud_api' } as any);
      reposHelpers.downloadAppFiles.mockResolvedValue({ success: false, message: 'boom' } as any);

      await expect(service.updateApp({ appUrn, performBackup: false })).rejects.toThrow();
      expect(appEventsQueue.publish).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'update' }));
    });

    // ── exposure sync uses committed state ───────────────────────────────
    it('installApp success: syncExposure reads committed running state (no sleep)', async () => {
      const baseAppInfo = { id: 'myapp', port: 8080, cihub_app_version: 1, exposable: true, supported_architectures: ['amd64'] };
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(baseAppInfo as any);
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      appsRepository.getAppsByDomain.mockResolvedValue([]);
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
      appsRepository.getAppsByPort.mockResolvedValue([]);
      appsRepository.getApps.mockResolvedValue([]);
      registrationService.getDeviceRegistrationInfo.mockResolvedValue(null as any);

      await service.installApp({ actor: TEST_ACTOR, appUrn, form: { exposedLocal: true } });
      await flushMicrotasks();

      // syncExposure was called (via getApps inside triggerCloudflareSync)
      // and DB was updated to 'running' BEFORE sync was triggered
      const updateIdx = callOrder.indexOf('db_update');
      const successIdx = callOrder.indexOf('sse:install_success');
      expect(updateIdx).toBeGreaterThanOrEqual(0);
      expect(successIdx).toBeGreaterThan(updateIdx);
    });
  });

  describe('memory provider uninstall/reset guard', () => {
    const providerUrn = 'ci-memory:ci-marketplace' as any;
    const nonProviderUrn = 'myapp:ci-marketplace' as any;
    const providerApp = { id: 7, appName: 'ci-memory', appStoreSlug: 'ci-marketplace', status: 'running' as const, config: {}, exposedLocal: false };

    let memoryConnect: { listConnectedConsumers: ReturnType<typeof vi.fn>; handleUninstall: ReturnType<typeof vi.fn> };
    let moduleRefGet: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      memoryConnect = { listConnectedConsumers: vi.fn().mockResolvedValue([]), handleUninstall: vi.fn().mockResolvedValue(undefined) };
      // The guard lazily resolves MemoryConnectService via the (mocked) ModuleRef.
      moduleRefGet = vi.mocked((service as any).moduleRef.get);
      moduleRefGet.mockReturnValue(memoryConnect);
      appsRepository.getAppByUrn.mockResolvedValue(providerApp as any);
      appEventsQueue.publish.mockResolvedValue({ success: true, message: 'OK' } as any);
    });

    it('blocks uninstall of the provider while consumers are connected (409, no side effects)', async () => {
      memoryConnect.listConnectedConsumers.mockResolvedValue([
        { appUrn: 'ci-hermes:ci-marketplace', name: 'Hermes' },
        { appUrn: 'ci-openclaw:ci-marketplace', name: 'OpenClaw' },
      ]);

      await expect(service.uninstallApp({ appUrn: providerUrn, deleteAllData: true })).rejects.toMatchObject({
        response: { message: 'APP_ERROR_MEMORY_PROVIDER_IN_USE', intlParams: { count: '2', apps: 'Hermes, OpenClaw' } },
        status: 409,
      });

      expect(backupManager.deleteAppBackupsByUrn).not.toHaveBeenCalled();
      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
      expect(sseService.emit).not.toHaveBeenCalled();
      expect(appEventsQueue.publish).not.toHaveBeenCalled();
    });

    it('allows a forced uninstall of the provider despite connected consumers', async () => {
      memoryConnect.listConnectedConsumers.mockResolvedValue([{ appUrn: 'ci-hermes:ci-marketplace', name: 'Hermes' }]);

      await expect(service.uninstallApp({ appUrn: providerUrn, deleteAllData: true, force: true })).resolves.toMatchObject({
        requestId: expect.any(String),
      });

      expect(memoryConnect.listConnectedConsumers).not.toHaveBeenCalled();
      expect(appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({ command: 'uninstall', appUrn: providerUrn }));
    });

    it('allows uninstall of the provider when no consumers remain', async () => {
      memoryConnect.listConnectedConsumers.mockResolvedValue([]);

      await expect(service.uninstallApp({ appUrn: providerUrn, deleteAllData: true })).resolves.toMatchObject({ requestId: expect.any(String) });
      expect(appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({ command: 'uninstall', appUrn: providerUrn }));
    });

    it('dispatches the memory-connect cleanup off the response path — a slow sweep never blocks uninstall (#906)', async () => {
      memoryConnect.listConnectedConsumers.mockResolvedValue([]); // guard passes (provider, 0 consumers)
      // Provider teardown re-arms every consumer by restarting containers; that sweep
      // must not hold the HTTP response. A handleUninstall that never settles must
      // still let uninstallApp resolve with a requestId (it would hang if awaited).
      memoryConnect.handleUninstall.mockReturnValue(new Promise<void>(() => {}));

      await expect(service.uninstallApp({ appUrn: providerUrn, deleteAllData: true })).resolves.toMatchObject({
        requestId: expect.any(String),
      });

      // ...but the cleanup IS dispatched (just not awaited) — guard against a
      // regression that silently drops the sweep from the uninstall path.
      await vi.waitFor(() => expect(memoryConnect.handleUninstall).toHaveBeenCalledWith(providerUrn));
    });

    it('does not consult consumers when uninstalling a non-provider app', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ ...providerApp, appName: 'myapp' } as any);

      await service.uninstallApp({ appUrn: nonProviderUrn, deleteAllData: true });

      expect(memoryConnect.listConnectedConsumers).not.toHaveBeenCalled();
    });

    it('fails closed when the memory module cannot be resolved', async () => {
      moduleRefGet.mockReturnValue(undefined);

      await expect(service.uninstallApp({ appUrn: providerUrn, deleteAllData: true })).rejects.toMatchObject({
        response: { message: 'APP_ERROR_MEMORY_PROVIDER_UNVERIFIABLE' },
        status: 409,
      });
      expect(appEventsQueue.publish).not.toHaveBeenCalled();
    });

    it('blocks reset of the provider while consumers are connected (409, no side effects)', async () => {
      memoryConnect.listConnectedConsumers.mockResolvedValue([{ appUrn: 'ci-hermes:ci-marketplace', name: 'Hermes' }]);

      await expect(service.resetApp({ appUrn: providerUrn })).rejects.toMatchObject({
        response: { message: 'APP_ERROR_MEMORY_PROVIDER_IN_USE', intlParams: { count: '1', apps: 'Hermes' } },
        status: 409,
      });

      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
      expect(appEventsQueue.publish).not.toHaveBeenCalled();
    });

    it('allows a forced reset of the provider despite connected consumers', async () => {
      memoryConnect.listConnectedConsumers.mockResolvedValue([{ appUrn: 'ci-hermes:ci-marketplace', name: 'Hermes' }]);

      await expect(service.resetApp({ appUrn: providerUrn, force: true })).resolves.toMatchObject({ requestId: expect.any(String) });
      expect(memoryConnect.listConnectedConsumers).not.toHaveBeenCalled();
      expect(appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({ command: 'reset', appUrn: providerUrn }));
    });
  });

  describe('cancelOperation', () => {
    const appUrn = 'cancelme:ci-marketplace' as any;
    const requestId = '00000000-0000-4000-8000-000000000abc';

    it('returns not_found when no operation is active', async () => {
      const res = await service.cancelOperation(appUrn);
      expect(res.outcome).toBe('not_found');
    });

    it('returns cancelled_queued and aborts when the op is still queued', async () => {
      operationRegistry.register(appUrn, { requestId, command: 'install', tier: 'safe' });
      const abortSpy = vi.spyOn(operationRegistry, 'abort');

      const res = await service.cancelOperation(appUrn);

      expect(res.outcome).toBe('cancelled_queued');
      expect(abortSpy).toHaveBeenCalledWith(appUrn, undefined);
      expect(operationRegistry.get(appUrn)?.abortController.signal.aborted).toBe(true);
    });

    it('returns cancelling and aborts when the op is in flight', async () => {
      const entry = operationRegistry.register(appUrn, { requestId, command: 'install', tier: 'safe' });
      operationRegistry.markPhase(appUrn, 'pulling');

      const res = await service.cancelOperation(appUrn);

      expect(res.outcome).toBe('cancelling');
      expect(entry.abortController.signal.aborted).toBe(true);
    });

    it('refuses once a safe op reaches the finalizing (post-PONR) phase', async () => {
      operationRegistry.register(appUrn, { requestId, command: 'install', tier: 'safe' });
      operationRegistry.markPhase(appUrn, 'finalizing');
      const abortSpy = vi.spyOn(operationRegistry, 'abort');

      const res = await service.cancelOperation(appUrn);

      expect(res.outcome).toBe('refused');
      expect(abortSpy).not.toHaveBeenCalled();
    });

    it('returns not_found and does not abort when the requestId does not match', async () => {
      operationRegistry.register(appUrn, { requestId, command: 'install', tier: 'safe' });
      const abortSpy = vi.spyOn(operationRegistry, 'abort');

      const res = await service.cancelOperation(appUrn, '11111111-1111-4111-8111-111111111111');

      expect(res.outcome).toBe('not_found');
      expect(abortSpy).not.toHaveBeenCalled();
    });
  });

  describe('invokeCommand — cancellation finalization', () => {
    const appUrn = 'cancelme:ci-marketplace' as any;
    const requestId = '00000000-0000-4000-8000-000000000abc';
    const data = { appUrn, command: 'install', requestId, form: {} } as any;

    beforeEach(() => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 7, status: 'installing' } as any);
      appsRepository.deleteAppById.mockResolvedValue(undefined as any);
      appsService.getInstallQueueState.mockResolvedValue({ active: null, queued: [] });
    });

    it('skips execution and finalizes when cancelled while queued (tier-A)', async () => {
      operationRegistry.register(appUrn, { requestId, command: 'install', tier: 'safe' });
      operationRegistry.abort(appUrn); // cancelled before the worker dequeued it
      const execute = vi.fn();
      commandFactory.createCommand.mockReturnValue({ execute } as any);
      const reply = vi.fn();

      await service.invokeCommand(data, reply);

      expect(execute).not.toHaveBeenCalled();
      expect(appsRepository.deleteAppById).toHaveBeenCalledWith(7);
      expect(sseService.emit).toHaveBeenCalledWith('app', expect.objectContaining({ event: 'install_cancelled', appUrn }));
      expect(reply).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }));
      expect(operationRegistry.get(appUrn)).toBeUndefined(); // cleared after worker-side cancel finalization
    });

    it('finalizes a cancelled result returned by the command (in-flight abort)', async () => {
      operationRegistry.register(appUrn, { requestId, command: 'install', tier: 'safe' });
      const execute = vi.fn().mockResolvedValue({ success: false, cancelled: true, message: 'cancelled and cleaned up' });
      commandFactory.createCommand.mockReturnValue({ execute } as any);
      const reply = vi.fn();

      await service.invokeCommand(data, reply);

      expect(execute).toHaveBeenCalled();
      expect(appsRepository.deleteAppById).toHaveBeenCalledWith(7);
      expect(sseService.emit).toHaveBeenCalledWith('app', expect.objectContaining({ event: 'install_cancelled', appStatus: 'missing' }));
      // A cancellation must not be reported as a failure or a success.
      expect(sseService.emit).not.toHaveBeenCalledWith('app', expect.objectContaining({ event: 'install_error' }));
      expect(sseService.emit).not.toHaveBeenCalledWith('app', expect.objectContaining({ event: 'install_success' }));
    });

    it('finalizes a FAILED install worker-side so a post-RPC-timeout failure is not stranded in installing', async () => {
      operationRegistry.register(appUrn, { requestId, command: 'install', tier: 'safe' });
      const execute = vi.fn().mockResolvedValue({ success: false, message: 'pull failed', errorCode: 'x' });
      commandFactory.createCommand.mockReturnValue({ execute } as any);
      const reply = vi.fn();
      const queueSpy = vi.spyOn(service as any, 'emitInstallQueueUpdate');

      await service.invokeCommand(data, reply);

      // Worker writes the terminal status + emits install_error, independent of the RPC reply.
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'install_failed' }));
      expect(sseService.emit).toHaveBeenCalledWith('app', expect.objectContaining({ event: 'install_error', appStatus: 'install_failed' }));
      // A failure must not be treated as a cancellation (record kept, not deleted).
      expect(appsRepository.deleteAppById).not.toHaveBeenCalled();
      // invokeCommand emits the install-queue update exactly twice — when it marks the pipeline active
      // (start) and in its finally after clearing it. finalizeFailedInstall must NOT add a third,
      // stale one (which would briefly show the just-failed app as the active install).
      expect(queueSpy).toHaveBeenCalledTimes(2);
    });

    it('does not double-finalize a failure once the app has left installing', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 7, status: 'install_failed' } as any);
      operationRegistry.register(appUrn, { requestId, command: 'install', tier: 'safe' });
      const execute = vi.fn().mockResolvedValue({ success: false, message: 'pull failed' });
      commandFactory.createCommand.mockReturnValue({ execute } as any);

      await service.invokeCommand(data, vi.fn());

      // Status guard: already install_failed → no second status write / SSE.
      expect(appsRepository.updateAppById).not.toHaveBeenCalledWith(7, expect.objectContaining({ status: 'install_failed' }));
      expect(sseService.emit).not.toHaveBeenCalledWith('app', expect.objectContaining({ event: 'install_error' }));
    });

    it('finalizes a thrown install error worker-side (catch path, not just result.success=false)', async () => {
      operationRegistry.register(appUrn, { requestId, command: 'install', tier: 'safe' });
      const execute = vi.fn().mockRejectedValue(new Error('daemon wedged'));
      commandFactory.createCommand.mockReturnValue({ execute } as any);
      const reply = vi.fn();

      await service.invokeCommand(data, reply);

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'install_failed' }));
      expect(sseService.emit).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({ event: 'install_error', appStatus: 'install_failed', error: 'daemon wedged' }),
      );
      expect(reply).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: 'daemon wedged' }));
      expect(operationRegistry.get(appUrn)).toBeUndefined();
    });
  });

  describe('recoverStuckInstallsOnStartup', () => {
    it('marks orphaned installing rows as install_failed and emits the queue update once', async () => {
      appsRepository.getAppsByStatus.mockResolvedValue([
        { id: 11, appName: 'flatnotes', appStoreSlug: 'ci-marketplace', status: 'installing' },
        { id: 12, appName: 'fizzy', appStoreSlug: 'ci-marketplace', status: 'installing' },
      ] as any);
      appsService.getInstallQueueState.mockResolvedValue({ active: null, queued: [] });
      const queueSpy = vi.spyOn(service as any, 'emitInstallQueueUpdate');

      const recovered = await service.recoverStuckInstallsOnStartup();

      expect(recovered).toBe(2);
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(11, expect.objectContaining({ status: 'install_failed' }));
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(12, expect.objectContaining({ status: 'install_failed' }));
      expect(sseService.emit).toHaveBeenCalledWith('app', expect.objectContaining({ event: 'install_error', appUrn: 'flatnotes:ci-marketplace' }));
      expect(queueSpy).toHaveBeenCalledTimes(1);
    });

    it('skips an installing row that already has a live registry entry', async () => {
      const appUrn = 'live:ci-marketplace' as AppUrn;
      appsRepository.getAppsByStatus.mockResolvedValue([{ id: 13, appName: 'live', appStoreSlug: 'ci-marketplace', status: 'installing' }] as any);
      operationRegistry.register(appUrn, { requestId: 'r1', command: 'install', tier: 'safe' });

      const recovered = await service.recoverStuckInstallsOnStartup();

      expect(recovered).toBe(0);
      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
    });
  });

  describe('command-identity completion claims (#903)', () => {
    const appUrn = 'myapp:ci-marketplace' as AppUrn;
    const fakeApp = {
      id: 42,
      appName: 'myapp',
      appStoreSlug: 'ci-marketplace',
      status: 'running',
      config: {},
      exposedLocal: false,
      exposureMode: 'local',
    };

    const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

    /** Resolve publish callbacks only after every command in the test has registered. */
    function deferPublishResults(...results: Array<{ success: boolean; message: string }>) {
      const resolvers: Array<(value: { success: boolean; message: string }) => void> = [];
      appEventsQueue.publish.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          }),
      );
      return () => {
        for (const [index, result] of results.entries()) {
          resolvers[index]?.(result);
        }
      };
    }

    beforeEach(() => {
      appsRepository.getAppByUrn.mockResolvedValue(fakeApp as any);
      appsRepository.updateAppById.mockResolvedValue(fakeApp as any);
      appEventsQueue.publish.mockReset();
      appEventsQueue.publish.mockResolvedValue({ success: true, message: 'OK' } as any);
    });

    it('overlapping restarts: the first success does not win when a second restart superseded it', async () => {
      const resolvePublish = deferPublishResults({ success: true, message: 'OK' }, { success: false, message: 'compose failed' });

      await service.restartApp({ appUrn });
      await service.restartApp({ appUrn });
      resolvePublish();
      await flushMicrotasks();

      expect(sseService.emit).not.toHaveBeenCalledWith('app', expect.objectContaining({ event: 'restart_success' }));
      expect(sseService.emit).toHaveBeenCalledWith('app', expect.objectContaining({ event: 'restart_error', appUrn, appStatus: 'stopped' }));
    });

    it('stop-then-restart interleave: the surviving restart outcome wins over a superseded stop', async () => {
      const resolvePublish = deferPublishResults({ success: true, message: 'OK' }, { success: true, message: 'OK' });

      await service.stopApp({ appUrn });
      await service.restartApp({ appUrn });
      resolvePublish();
      await flushMicrotasks();

      expect(sseService.emit).not.toHaveBeenCalledWith('app', expect.objectContaining({ event: 'stop_success' }));
      expect(sseService.emit).toHaveBeenCalledWith('app', expect.objectContaining({ event: 'restart_success', appUrn, appStatus: 'running' }));
    });

    it('superseded restart failure does not fire phantom failure alerts', async () => {
      const resolvePublish = deferPublishResults({ success: false, message: 'compose interrupted' }, { success: true, message: 'OK' });

      await service.restartApp({ appUrn });
      await service.stopApp({ appUrn });
      resolvePublish();
      await flushMicrotasks();

      expect(agentNotifyService.notify).not.toHaveBeenCalledWith('restart_error', expect.anything(), expect.anything());
      expect(errorReportingService.reportAppFailure).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'restart' }));
      expect(sseService.emit).toHaveBeenCalledWith('app', expect.objectContaining({ event: 'stop_success', appUrn, appStatus: 'stopped' }));
    });
  });

  describe('restartAiApps', () => {
    it('restarts running apps that opt into hub_integration.inference even without ai category', async () => {
      const financeAppUrn = createAppUrn('securo', 'ci-marketplace');
      appsRepository.getApps.mockResolvedValue([{ id: 1, appName: 'securo', appStoreSlug: 'ci-marketplace', status: 'running' }] as any);
      marketplaceService.getAppInfoFromAppStore.mockResolvedValue({
        categories: ['finance'],
        hub_integration: { inference: { llm_base_url: 'AGENTS_OPENAI_COMPAT_BASE_URL' } },
      } as any);
      const restartSpy = vi.spyOn(service, 'restartApp').mockResolvedValue({ requestId: crypto.randomUUID() });

      await service.restartAiApps();

      expect(restartSpy).toHaveBeenCalledWith({ appUrn: financeAppUrn });
    });

    it('skips running apps without ai category or inference integration', async () => {
      appsRepository.getApps.mockResolvedValue([{ id: 1, appName: 'mealie', appStoreSlug: 'ci-marketplace', status: 'running' }] as any);
      marketplaceService.getAppInfoFromAppStore.mockResolvedValue({
        categories: ['utilities'],
        hub_integration: {},
      } as any);
      const restartSpy = vi.spyOn(service, 'restartApp').mockResolvedValue({ requestId: crypto.randomUUID() });

      await service.restartAiApps();

      expect(restartSpy).not.toHaveBeenCalled();
    });
  });
});
