import { Test, TestingModule } from '@nestjs/testing';
import { DebugService } from '../debug.service';
import { DATABASE } from '@/core/database/database.module';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { BackupsService } from '@/modules/backups/backups.service';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockDb = {
  select: vi.fn(),
};

describe('DebugService', () => {
  let service: DebugService;
  let appLifecycleService: MockProxy<AppLifecycleService>;
  let backupsService: MockProxy<BackupsService>;
  let appStoreService: MockProxy<AppStoreService>;
  let marketplaceService: MockProxy<MarketplaceService>;

  beforeEach(async () => {
    appLifecycleService = mock<AppLifecycleService>();
    backupsService = mock<BackupsService>();
    appStoreService = mock<AppStoreService>();
    marketplaceService = mock<MarketplaceService>();

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DebugService,
        { provide: DATABASE, useValue: mockDb },
        { provide: AppLifecycleService, useValue: appLifecycleService },
        { provide: BackupsService, useValue: backupsService },
        { provide: AppStoreService, useValue: appStoreService },
        { provide: MarketplaceService, useValue: marketplaceService },
      ],
    }).compile();

    service = module.get<DebugService>(DebugService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('seedDatabase', () => {
    it('should clean up and seed', async () => {
      // Setup mock to simulate finding existing apps then none
      const queryBuilder = {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      };
      mockDb.select.mockReturnValue(queryBuilder);

      await service.seedDatabase();

      expect(appStoreService.createAppStore).toHaveBeenCalledWith(expect.objectContaining({ name: 'seed' }));
      expect(marketplaceService.initialize).toHaveBeenCalled();
    });
  });

  /*
   * Every call on one app takes an actor now (CI-Hub#1397). The debug routes act on apps nobody chose,
   * so each names the Hub for its own reason; borrowing a person would be refused on any app that
   * person holds no grant on.
   */
  describe('the actor each debug route names', () => {
    const row = { id: 1, appName: 'app-1', appStoreSlug: 'seed', version: 1 };

    it('uninstalls every app as the Hub, for debug-uninstall-all', async () => {
      mockDb.select.mockReturnValue({ from: vi.fn().mockResolvedValue([row]) });

      await service.uninstallAllApps();

      expect(appLifecycleService.uninstallApp).toHaveBeenCalledWith({
        appUrn: 'app-1:seed',
        deleteAllData: true,
        force: true,
        actor: { kind: 'system', reason: 'debug-uninstall-all' },
      });
    });

    it('clears the previous seed apps as the Hub, for debug-seed', async () => {
      // The first query finds one seed app left over; every later one finds nothing.
      mockDb.select.mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValueOnce([row]).mockResolvedValue([]) }) });

      await service.seedDatabase();

      expect(appLifecycleService.uninstallApp).toHaveBeenCalledWith({
        appUrn: 'app-1:seed',
        deleteAllData: true,
        force: true,
        actor: { kind: 'system', reason: 'debug-seed' },
      });
    });

    it('starts and backs up every app as the Hub, each for its own reason', async () => {
      await service.startAllApps();
      await service.backupAllApps();

      expect(appLifecycleService.startAllApps).toHaveBeenCalledWith({ kind: 'system', reason: 'debug-start-all' });
      expect(backupsService.backupAllApps).toHaveBeenCalledWith({ kind: 'system', reason: 'debug-backup-all' });
    });
  });
});
