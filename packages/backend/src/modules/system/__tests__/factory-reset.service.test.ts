import { DATABASE } from '@/core/database/database.module';
import { CacheService } from '@/core/cache/cache.service';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DOCKERODE } from '@/modules/docker/constants';
import { Test } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { FactoryResetService } from '../factory-reset.service';

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

  beforeEach(async () => {
    uninstallExecute.mockClear();
    db = {
      execute: vi.fn().mockResolvedValue(undefined),
      query: { app: { findMany: vi.fn().mockResolvedValue([]) } },
    };
    filesystem = mock<FilesystemService>();
    cache = mock<CacheService>();

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
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    service = moduleRef.get(FactoryResetService);
    filesystem.pathExists.mockResolvedValue(true);
    filesystem.removeDirectory.mockResolvedValue(true);
    filesystem.createDirectory.mockResolvedValue(true);
  });

  it('wipes the database and clears sessions', async () => {
    const result = await service.execute();

    expect(result.success).toBe(true);
    expect(db.execute).toHaveBeenCalled();
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
