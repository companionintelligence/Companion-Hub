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
});
