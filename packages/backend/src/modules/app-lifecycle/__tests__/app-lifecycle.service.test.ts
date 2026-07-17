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
import { DockerService } from '@/modules/docker/docker.service';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as registrationRecoveryState from '../registration-recovery-state';

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

  beforeEach(async () => {
    logger = mock<LoggerService>();
    appEventsQueue = mock<AppEventsQueue>();
    commandFactory = mock<AppLifecycleCommandFactory>();
    appsRepository = mock<AppsRepository>();
    configService = mock<ConfigurationService>();
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
        { provide: SSEService, useValue: sseService },
        { provide: BackupManager, useValue: backupManager },
        { provide: CloudflareClientService, useValue: cloudflareClientService },
        { provide: RegistrationService, useValue: registrationService },
        { provide: ReposHelpers, useValue: reposHelpers },
        { provide: AppStoreService, useValue: appStoreService },
        { provide: APP_ASYNC_MUTEX, useValue: mutex },
        { provide: InstallPipelineTracker, useValue: installPipelineTracker },
        { provide: AppOperationRegistry, useValue: operationRegistry },
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
      // A stale record CI-Cloud refuses to overwrite is not a domain problem, and
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
      // not, by the name CI-Cloud sent.
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
      // A full sync failure (e.g. CI-Cloud unreachable / non-success response),
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
      const data = { appUrn: 'test-app', command: 'install', requestId: '00000000-0000-4000-8000-000000000003', form: {} } as any;
      const reply = vi.fn();
      commandFactory.createCommand.mockImplementation(() => {
        throw new Error('Exec failed');
      });

      await service.invokeCommand(data, reply);
      expect(reply).toHaveBeenCalledWith({ success: false, message: 'Exec failed' });
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

      await expect(service.installApp({ appUrn, form: {} })).rejects.toThrow('APP_ERROR_ARCHITECTURE_NOT_SUPPORTED');

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

      await service.installApp({ appUrn, form: {} });

      expect(appsRepository.createApp).toHaveBeenCalled();
    });

    it('does not block install when manifest architecture inspection is unavailable', async () => {
      imageSizeService.verifyAppArchitecture.mockResolvedValue(null);

      await service.installApp({ appUrn, form: {} });

      expect(imageSizeService.verifyAppArchitecture).toHaveBeenCalledWith(appUrn, 'amd64');
      expect(appsRepository.createApp).toHaveBeenCalled();
    });

    it('MUST persist exposureMode=cloudflare when provided in form', async () => {
      await service.installApp({ appUrn, form: { exposureMode: 'cloudflare', exposedLocal: true } });

      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ exposureMode: 'cloudflare' }));
    });

    it('MUST persist exposureMode=tailscale when provided in form', async () => {
      await service.installApp({ appUrn, form: { exposureMode: 'tailscale', exposedLocal: true } });

      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ exposureMode: 'tailscale' }));
    });

    it('does not treat localSubdomain as a tailscale conflict key', async () => {
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([{ appName: 'taken' }] as any);
      await service.installApp({
        appUrn,
        form: { exposureMode: 'tailscale', exposedLocal: false, localSubdomain: 'mysvc' },
      });

      expect(appsRepository.getAppsByLocalSubdomain).not.toHaveBeenCalled();
    });

    it('MUST default exposureMode to local when not provided', async () => {
      await service.installApp({ appUrn, form: {} });

      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ exposureMode: 'local' }));
    });

    it('MUST persist exposureMode=local explicitly when provided', async () => {
      await service.installApp({ appUrn, form: { exposureMode: 'local' } });

      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ exposureMode: 'local' }));
    });

    it('MUST normalize local exposure to openPort=true before duplicate-port checks', async () => {
      appsRepository.getAppsByPort.mockResolvedValue([{ appName: 'taken-port' }] as any);

      await expect(
        service.installApp({
          appUrn,
          form: { exposureMode: 'local', openPort: false, port: 8080 },
        }),
      ).rejects.toThrow('APP_ERROR_PORT_ALREADY_IN_USE');
    });

    it('MUST reject duplicate port for cloudflare exposedLocal when openPort is false', async () => {
      appsRepository.getAppsByPort.mockResolvedValue([{ appName: 'taken-port' }] as any);

      await expect(
        service.installApp({
          appUrn,
          form: { exposureMode: 'cloudflare', exposedLocal: true, openPort: false, port: 8080 },
        }),
      ).rejects.toThrow('APP_ERROR_PORT_ALREADY_IN_USE');
    });

    it('MUST skip duplicate-port checks when cloudflare apps do not publish a host port', async () => {
      appsRepository.getAppsByPort.mockResolvedValue([{ appName: 'taken-port' }] as any);

      await service.installApp({
        appUrn,
        form: { exposureMode: 'cloudflare', exposedLocal: false, openPort: false, port: 8080 },
      });

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

    it.each(['running', 'starting', 'restarting'] as const)('triggers restartApp({ skipPull: true }) when app status is "%s"', async (status) => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status, config: { port: 8080 } } as any);
      const restartSpy = vi.spyOn(service, 'restartApp').mockResolvedValue({ requestId: crypto.randomUUID() });

      await service.updateAppConfig({ appUrn, form: { port: 9090 } });

      expect(restartSpy).toHaveBeenCalledWith({ appUrn, skipPull: true });
    });

    it.each([
      'running',
      'starting',
      'restarting',
    ] as const)('does NOT trigger restartApp when app status is "%s" but config is unchanged', async (status) => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status, config: { port: 8080 } } as any);
      const restartSpy = vi.spyOn(service, 'restartApp').mockResolvedValue({ requestId: crypto.randomUUID() });

      await service.updateAppConfig({ appUrn, form: { port: 8080 } });

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

      await service.updateAppConfig({ appUrn, form: {} });

      expect(restartSpy).not.toHaveBeenCalled();
    });

    it('returns a requestId even when auto-restart fires', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, status: 'running', config: { port: 8080 } } as any);
      vi.spyOn(service, 'restartApp').mockResolvedValue({ requestId: crypto.randomUUID() });

      const result = await service.updateAppConfig({ appUrn, form: { port: 9090 } });

      expect(result).toHaveProperty('requestId');
      expect(typeof result.requestId).toBe('string');
    });

    it('does not restart when app is not found (throws before restart logic)', async () => {
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      const restartSpy = vi.spyOn(service, 'restartApp').mockResolvedValue({ requestId: crypto.randomUUID() });

      await expect(service.updateAppConfig({ appUrn, form: {} })).rejects.toThrow('APP_ERROR_APP_NOT_FOUND');
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

      await service.updateAppConfig({
        appUrn,
        form: { exposureMode: 'local', openPort: false, port: 8080 },
      });

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
        appUrn,
        form: { exposureMode: 'cloudflare', exposedLocal: true, localSubdomain: 'new-sub', port: 8080 },
      });

      expect(syncSpy).toHaveBeenCalledTimes(2);
      expect(syncSpy).toHaveBeenNthCalledWith(1, { excludeAppUrns: ['myapp:ci-marketplace'] });
      expect(syncSpy).toHaveBeenNthCalledWith(2, undefined);
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

    it('restartApp: transitional status_change emitted after DB commit', async () => {
      await service.restartApp({ appUrn });

      const dbIdx = callOrder.indexOf('db_update');
      const sseIdx = callOrder.indexOf('sse:status_change');
      expect(sseIdx).toBeGreaterThan(dbIdx);
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
      // Backups are always removed on uninstall, even when app data/volumes are preserved.
      expect(backupManager.deleteAppBackupsByUrn).toHaveBeenCalledWith(appUrn);
      expect(appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({ command: 'uninstall', appUrn, deleteAllData: false }));
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

      await service.installApp({ appUrn, form: {} });
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

      await service.installApp({ appUrn, form: {} });
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

      await service.installApp({ appUrn, form: {} });
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

      await service.installApp({ appUrn, form: {} });
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

      await service.installApp({ appUrn, form: { exposedLocal: true } });
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

      await service.installApp({ appUrn, form: {} });
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

      await service.installApp({ appUrn, form: {} });

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

    it('updateApp success restores stopped state before emitting update_success', async () => {
      vi.spyOn(service, 'updateAppConfig').mockResolvedValue({ requestId: crypto.randomUUID() });
      vi.spyOn(service, 'startApp').mockResolvedValue({ requestId: crypto.randomUUID() });
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ cihub_app_version: 2 } as any);

      await service.updateApp({ appUrn, performBackup: false });
      await flushMicrotasks();

      expectEventAfterNthUpdate('update_success', 1);
      expect(sseService.emit).toHaveBeenCalledWith('app', expect.objectContaining({ event: 'update_success', appStatus: 'stopped' }));
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

      await service.installApp({ appUrn, form: { exposedLocal: true } });
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
      expect(operationRegistry.get(appUrn)).toBeUndefined(); // cleared in finally
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
  });
});
