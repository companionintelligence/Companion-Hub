import { DATABASE } from '@/core/database/database.module';
import { CacheService } from '@/core/cache/cache.service';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DOCKERODE } from '@/modules/docker/constants';
import { Test } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { FactoryResetService } from '../factory-reset.service';
import { RegistrationService } from '@/modules/registration/registration.service';

const uninstallExecute = vi.fn().mockResolvedValue({ success: true, message: 'ok' });

vi.mock('@/modules/app-lifecycle/commands/uninstall-app-command', () => ({
  UninstallAppCommand: class {
    execute = uninstallExecute;
  },
}));

describe('FactoryResetService', () => {
  let service: FactoryResetService;
  let db: { execute: ReturnType<typeof vi.fn>; query: { app: { findMany: ReturnType<typeof vi.fn> } } };
  let filesystem: MockProxy<FilesystemService>;
  let cache: MockProxy<CacheService>;
  let sessionUserCache: SessionUserCache;
  let registrationService: MockProxy<RegistrationService>;

  beforeEach(async () => {
    uninstallExecute.mockClear();
    db = {
      execute: vi.fn().mockResolvedValue(undefined),
      query: { app: { findMany: vi.fn().mockResolvedValue([]) } },
    };
    filesystem = mock<FilesystemService>();
    cache = mock<CacheService>();
    registrationService = mock<RegistrationService>();
    registrationService.resetRegistration.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        FactoryResetService,
        { provide: DATABASE, useValue: db },
        { provide: DOCKERODE, useValue: {} },
        { provide: ModuleRef, useValue: mock<ModuleRef>() },
        { provide: FilesystemService, useValue: filesystem },
        {
          provide: ConfigurationService,
          useValue: {
            get: vi.fn().mockReturnValue({ dataDir: '/data' }),
          },
        },
        { provide: CacheService, useValue: cache },
        // Real instance: the point of the assertion below is that the wipe empties this map.
        SessionUserCache,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: RegistrationService, useValue: registrationService },
      ],
    }).compile();

    service = moduleRef.get(FactoryResetService);
    sessionUserCache = moduleRef.get(SessionUserCache);
    filesystem.pathExists.mockResolvedValue(true);
    filesystem.removeDirectory.mockResolvedValue(true);
    filesystem.createDirectory.mockResolvedValue(true);
  });

  it('wipes the database and clears sessions', async () => {
    const result = await service.execute();

    expect(result.success).toBe(true);
    expect(db.execute).toHaveBeenCalled();
    expect(registrationService.resetRegistration).toHaveBeenCalledWith({ reason: 'manual' });
    expect(cache.clear).toHaveBeenCalled();
  });

  // The TRUNCATE goes around UserRepository, so nothing else drops these entries: a surviving
  // DTO keeps a wiped Hub answering AuthGuard as an operator, and `RESTART IDENTITY` means the
  // next account created can be handed the same id the stale entry describes.
  it('MUST drop cached session users when the user table is truncated', async () => {
    sessionUserCache.set(1, { id: 1, username: 'previous-operator' } as never);
    expect(sessionUserCache.get(1)).toBeDefined();

    await service.wipeDatabase();

    expect(sessionUserCache.get(1)).toBeUndefined();
  });

  /**
   * Sessions live in CacheService and outlive the rows they name. `execute()` only clears them
   * after three more awaits, so a reset that failed partway used to leave a live `ci-hub-sid`
   * behind — and `RESTART IDENTITY` hands the next account the very id that cookie resolves to,
   * which would admit the old browser tab as the new operator.
   */
  it('MUST clear sessions in the same step that truncates the user rows they point at', async () => {
    await service.wipeDatabase();

    expect(cache.clear).toHaveBeenCalled();
  });

  it('MUST drop cached session users even when the TRUNCATE rejects on the way back', async () => {
    sessionUserCache.set(1, { id: 1, username: 'previous-operator' } as never);
    db.execute.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(service.wipeDatabase()).rejects.toThrow('ECONNRESET');

    expect(sessionUserCache.get(1)).toBeUndefined();
    expect(cache.clear).toHaveBeenCalled();
  });

  it('tears down installed apps before wiping data mounts', async () => {
    db.query.app.findMany.mockResolvedValue([
      {
        appName: 'demo',
        appStoreSlug: 'ci-store',
      } as any,
    ]);

    await service.execute();

    expect(db.query.app.findMany).toHaveBeenCalled();
    expect(uninstallExecute).toHaveBeenCalled();
    expect(filesystem.removeDirectory).toHaveBeenCalled();
  });
});
