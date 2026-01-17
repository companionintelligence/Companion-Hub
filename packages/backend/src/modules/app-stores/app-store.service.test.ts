import { AppStoreService } from './app-store.service';
import { AppStoreRepository } from './app-store.repository';
import { ReposHelpers } from './repos.helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import { fromPartial } from '@total-typescript/shoehorn';

describe('AppStoreService', () => {
  let service: AppStoreService;
  let appStoreRepository: ReturnType<typeof mock<AppStoreRepository>>;
  let repoHelpers: ReturnType<typeof mock<ReposHelpers>>;
  let configService: ReturnType<typeof mock<ConfigurationService>>;
  let logger: ReturnType<typeof mockDeep<LoggerService>>;
  // biome-ignore lint/suspicious/noExplicitAny: Mocking queue
  let repoQueue: any;

  beforeEach(async () => {
    appStoreRepository = mock<AppStoreRepository>();
    repoHelpers = mock<ReposHelpers>();
    configService = mock<ConfigurationService>();
    logger = mockDeep<LoggerService>();

    repoQueue = {
      onEvent: vi.fn(),
      publish: vi.fn(),
      publishRepeatable: vi.fn(),
    };

    service = new AppStoreService(logger, repoQueue, repoHelpers, configService, appStoreRepository);
  });

  describe('registerCloudAppStore', () => {
    it('should skip if no URL configured', async () => {
      configService.getConfig.mockReturnValue(fromPartial({ ciCloudAppStoreUrl: undefined }));

      await service.registerCloudAppStore();

      expect(appStoreRepository.getAppStoreBySlug).not.toHaveBeenCalled();
    });

    it('should create new store if not exists', async () => {
      const url = 'https://example.com/store.zip';
      configService.getConfig.mockReturnValue(fromPartial({ ciCloudAppStoreUrl: url }));
      // biome-ignore lint/suspicious/noExplicitAny: Mocking null return
      appStoreRepository.getAppStoreBySlug.mockResolvedValue(null as any);

      await service.registerCloudAppStore();

      expect(appStoreRepository.createAppStore).toHaveBeenCalledWith({
        name: 'CI Cloud',
        url,
        slug: 'ci-cloud',
        enabled: true,
        type: 'http_zip',
      });
    });

    it('should update existing store if URL changed', async () => {
      const url = 'https://example.com/store.zip';
      const oldUrl = 'https://old.com/store.zip';
      configService.getConfig.mockReturnValue(fromPartial({ ciCloudAppStoreUrl: url }));
      appStoreRepository.getAppStoreBySlug.mockResolvedValue(fromPartial({ slug: 'ci-cloud', url: oldUrl }));
      repoHelpers.getRepoHash.mockReturnValue('new-hash');

      await service.registerCloudAppStore();

      expect(appStoreRepository.updateAppStoreHashAndUrl).toHaveBeenCalledWith('ci-cloud', {
        url,
        hash: 'new-hash',
      });
    });

    it('should do nothing if existing store has same URL', async () => {
      const url = 'https://example.com/store.zip';
      configService.getConfig.mockReturnValue(fromPartial({ ciCloudAppStoreUrl: url }));
      appStoreRepository.getAppStoreBySlug.mockResolvedValue(fromPartial({ slug: 'ci-cloud', url, type: 'http_zip' }));

      await service.registerCloudAppStore();

      expect(appStoreRepository.updateAppStoreHashAndUrl).not.toHaveBeenCalled();
      expect(appStoreRepository.createAppStore).not.toHaveBeenCalled();
    });
  });
});
