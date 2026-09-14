import { Test, TestingModule } from '@nestjs/testing';
import { BackupsService } from '../backups.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppEventsQueue } from '@/modules/queue/entities/app-events';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppOperationRegistry } from '@/modules/app-lifecycle/app-operation-registry';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { BackupManager } from '../backup.manager';
import { SSEService } from '@/core/sse/sse.service';
import type { HubAction } from '@/core/portal/hub-actions';
import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import { GRANTED_ACTOR, REFUSED_ACTORS, lifecycleActorGate } from '@/tests/utils/lifecycle-actor-gate';
import type { AppUrn } from '@ci-hub/common/types';
import { mock, MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('BackupsService', () => {
  let service: BackupsService;
  let appsRepository: MockProxy<AppsRepository>;
  let logger: MockProxy<LoggerService>;
  let configService: MockProxy<ConfigurationService>;
  let appEventsQueue: MockProxy<AppEventsQueue>;
  let appLifecycle: MockProxy<AppLifecycleService>;
  let appFilesManager: MockProxy<AppFilesManager>;
  let backupManager: MockProxy<BackupManager>;
  let sseService: MockProxy<SSEService>;
  let operationRegistry: MockProxy<AppOperationRegistry>;

  beforeEach(async () => {
    appsRepository = mock<AppsRepository>();
    logger = mock<LoggerService>();
    configService = mock<ConfigurationService>();
    appEventsQueue = mock<AppEventsQueue>();
    appLifecycle = mock<AppLifecycleService>();
    appFilesManager = mock<AppFilesManager>();
    backupManager = mock<BackupManager>();
    sseService = mock<SSEService>();
    operationRegistry = mock<AppOperationRegistry>();
    operationRegistry.claimCompletion.mockReturnValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupsService,
        { provide: AppsRepository, useValue: appsRepository },
        { provide: LoggerService, useValue: logger },
        { provide: ConfigurationService, useValue: configService },
        { provide: AppEventsQueue, useValue: appEventsQueue },
        { provide: AppLifecycleService, useValue: appLifecycle },
        { provide: AppFilesManager, useValue: appFilesManager },
        { provide: BackupManager, useValue: backupManager },
        { provide: SSEService, useValue: sseService },
        { provide: AppOperationRegistry, useValue: operationRegistry },
      ],
    }).compile();

    service = module.get<BackupsService>(BackupsService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('backupApp', () => {
    it('should backup app successfully', async () => {
      const appUrn = 'test-app' as any;
      const app = { id: 1, name: 'test-app', status: 'running', config: {} };
      appsRepository.getAppByUrn.mockResolvedValue(app as any);
      appEventsQueue.publish.mockResolvedValue({ success: true, message: 'OK' } as any);
      configService.get.mockReturnValue(false); // No demo mode

      await service.backupApp({ appUrn, actor: GRANTED_ACTOR });

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'backing_up' }));
      expect(appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({ command: 'backup', appUrn }));

      // Since it's fire-and-forget promise chain, we wait a bit or trust it runs if no error?
      // With mockResolvedValue, the .then() runs immediately effectively in microtasks.
      // But let's check expectations.
      // It should call startApp if it was running.
      // Wait, we need to ensure the promise chain executes.
      // In JS, promises resolve in next microtask.

      await new Promise(process.nextTick);

      // As the Hub, not as whoever asked: bringing the app back is part of the backup they were allowed.
      expect(appLifecycle.startApp).toHaveBeenCalledWith({ appUrn, actor: { kind: 'system', reason: 'resume-after-backup' } });
    });

    it('should throw if demo mode', async () => {
      configService.get.mockReturnValue(true);
      await expect(service.backupApp({ appUrn: 'test' as any, actor: GRANTED_ACTOR })).rejects.toThrow('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    });
  });

  describe('restoreApp', () => {
    it('should restore app successfully', async () => {
      const appUrn = 'test-app' as any;
      const app = { id: 1, name: 'test-app', status: 'stopped', config: {} };
      appsRepository.getAppByUrn.mockResolvedValue(app as any);
      appEventsQueue.publish.mockResolvedValue({ success: true, message: 'OK' } as any);

      await service.restoreApp({ appUrn, filename: 'backup.tar.gz', actor: GRANTED_ACTOR });

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'restoring' }));

      await new Promise(process.nextTick);

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'stopped' }));
    });

    it('starts an app that was running again as the Hub, not as whoever asked', async () => {
      const appUrn = 'test-app' as any;
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, name: 'test-app', status: 'running', config: {} } as any);
      appEventsQueue.publish.mockResolvedValue({ success: true, message: 'OK' } as any);

      await service.restoreApp({ appUrn, filename: 'backup.tar.gz', actor: GRANTED_ACTOR });
      await vi.waitFor(() => expect(appLifecycle.startApp).toHaveBeenCalled());

      expect(appLifecycle.startApp).toHaveBeenCalledWith({ appUrn, actor: { kind: 'system', reason: 'resume-after-restore' } });
    });
  });

  /*
   * Each call on one app's backups asks the lifecycle's own actor gate before it touches anything. The
   * MCP backup tools reached every one of these with no grant check (CI-Hub#1397). The gate here is the
   * real decision, so a refusal below is the one the Hub gives.
   */
  describe('the actor gate', () => {
    const appUrn = 'immich:ci-marketplace' as AppUrn;
    const filename = 'immich-2026-09-14.tar.gz';

    /** Each call, the verb it takes — the one its HTTP route asserts — and the side effect it exists for. */
    const calls: Array<[string, HubAction, (actor: LifecycleActor) => Promise<unknown>, () => void]> = [
      [
        'backupApp',
        'backup',
        (actor) => service.backupApp({ appUrn, actor }),
        () => expect(appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({ command: 'backup', appUrn })),
      ],
      [
        'restoreApp',
        'restore',
        (actor) => service.restoreApp({ appUrn, filename, actor }),
        () => expect(appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({ command: 'restore', appUrn, filename })),
      ],
      [
        'getAppBackups',
        'view',
        (actor) => service.getAppBackups({ appUrn, page: 1, pageSize: 10, actor }),
        () => expect(backupManager.listBackupsByAppId).toHaveBeenCalledWith(appUrn),
      ],
      [
        'deleteAppBackup',
        'backup',
        (actor) => service.deleteAppBackup({ appUrn, filename, actor }),
        () => expect(backupManager.deleteBackup).toHaveBeenCalledWith(appUrn, filename),
      ],
    ];

    beforeEach(() => {
      appLifecycle.assertActorMay.mockImplementation(lifecycleActorGate());
      configService.get.mockReturnValue(false);
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1, name: 'immich', status: 'stopped', config: {} } as any);
      appEventsQueue.publish.mockResolvedValue({ success: true, message: 'OK' } as any);
      backupManager.listBackupsByAppId.mockResolvedValue([]);
    });

    describe.each(calls)('%s', (_name, action, call, sideEffect) => {
      it.each(REFUSED_ACTORS)('refuses %s before it reads, writes or queues anything', async (_label, actor) => {
        await expect(call(actor)).rejects.toThrow('APP_ACTION_GRANT_DENIED');

        expect(appLifecycle.assertActorMay).toHaveBeenCalledWith(actor, appUrn, action);
        expect(appsRepository.getAppByUrn).not.toHaveBeenCalled();
        expect(appsRepository.updateAppById).not.toHaveBeenCalled();
        expect(appEventsQueue.publish).not.toHaveBeenCalled();
        expect(backupManager.listBackupsByAppId).not.toHaveBeenCalled();
        expect(backupManager.deleteBackup).not.toHaveBeenCalled();
      });

      it(`goes ahead for a person holding the ${action} grant`, async () => {
        await call(GRANTED_ACTOR);

        expect(appLifecycle.assertActorMay).toHaveBeenCalledWith(GRANTED_ACTOR, appUrn, action);
        sideEffect();
      });
    });
  });
});
