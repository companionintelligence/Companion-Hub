import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { StackCompositionService } from '../stack-composition.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { AppLifecycleService } from '../app-lifecycle.service';
import { AppsService } from '@/modules/apps/apps.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('StackCompositionService', () => {
  let service: StackCompositionService;
  let marketplaceService: MockProxy<MarketplaceService>;
  let appLifecycleService: MockProxy<AppLifecycleService>;
  let appsService: MockProxy<AppsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StackCompositionService,
        { provide: MarketplaceService, useValue: mock<MarketplaceService>() },
        { provide: AppLifecycleService, useValue: mock<AppLifecycleService>() },
        { provide: AppsService, useValue: mock<AppsService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    service = module.get(StackCompositionService);
    marketplaceService = module.get(MarketplaceService);
    appLifecycleService = module.get(AppLifecycleService);
    appsService = module.get(AppsService);

    marketplaceService.getConfigJson.mockResolvedValue({ content: {} } as any);
    marketplaceService.getDockerComposeJson.mockResolvedValue({ content: { services: [] } } as any);
    marketplaceService.getAppInfoFromAppStore.mockResolvedValue({} as any);
    marketplaceService.getAvailableApps.mockResolvedValue([]);
  });

  it('builds recipe plan from natural language request', async () => {
    marketplaceService.getAvailableApps.mockResolvedValue([
      { urn: 'jellyfin:ci-marketplace' },
      { urn: 'sonarr:ci-marketplace' },
      { urn: 'radarr:ci-marketplace' },
      { urn: 'prowlarr:ci-marketplace' },
      { urn: 'qbittorrent:ci-marketplace' },
    ] as any);

    const result = await service.composeStack({
      request: 'set up a media server for my family',
      includeOptionalApps: false,
    });

    expect(result).toEqual(
      expect.objectContaining({
        recipe: expect.objectContaining({ id: 'media-server' }),
        requiresApproval: true,
        plan: expect.objectContaining({
          apps: [expect.objectContaining({ urn: 'jellyfin:ci-marketplace', required: true })],
          sharedNetworks: ['media-net'],
        }),
      }),
    );
  });

  it('executes install after approval', async () => {
    marketplaceService.searchApps.mockResolvedValue({
      data: [
        { urn: 'immich:ci-marketplace', port: 2283 },
        { urn: 'redis:ci-marketplace', port: 6379 },
      ],
    } as any);
    appLifecycleService.installApp.mockResolvedValue({ requestId: 'req-1' } as any);
    appsService.checkAppAvailability.mockResolvedValue({ available: true, appUrl: 'http://localhost' } as any);

    const result = await service.composeStack({
      request: 'observability monitor bundle',
      approved: true,
    });

    expect(appLifecycleService.installApp).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        execution: expect.objectContaining({
          requested: true,
        }),
      }),
    );
  });
});
