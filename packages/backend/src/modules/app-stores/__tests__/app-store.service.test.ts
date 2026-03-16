import { Test, TestingModule } from '@nestjs/testing';
import { AppStoreService } from '../app-store.service';
import { LoggerService } from '@/core/logger/logger.service';
import { RepoEventsQueue } from '@/modules/queue/entities/repo-events';
import { AppStoreRepository } from '../app-store.repository';
import { ReposHelpers } from '../repos.helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('AppStoreService', () => {
  let service: AppStoreService;
  let logger: MockProxy<LoggerService>;
  let repoQueue: MockProxy<RepoEventsQueue>;
  let repoHelpers: MockProxy<ReposHelpers>;
  let configService: MockProxy<ConfigurationService>;
  let appStoreRepository: MockProxy<AppStoreRepository>;
  let capturedQueueCallback: any;

  beforeEach(async () => {
    logger = mock<LoggerService>();
    repoQueue = mock<RepoEventsQueue>();
    repoHelpers = mock<ReposHelpers>();
    configService = mock<ConfigurationService>();
    appStoreRepository = mock<AppStoreRepository>();

    repoQueue.onEvent.mockImplementation((cb) => {
      capturedQueueCallback = cb;
      return vi.fn() as any;
    });

    configService.getConfig.mockReturnValue({ ciCloudAppStoreUrl: 'cloud-url' } as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppStoreService,
        { provide: LoggerService, useValue: logger },
        { provide: RepoEventsQueue, useValue: repoQueue },
        { provide: ReposHelpers, useValue: repoHelpers },
        { provide: ConfigurationService, useValue: configService },
        { provide: AppStoreRepository, useValue: appStoreRepository },
      ],
    }).compile();

    service = module.get<AppStoreService>(AppStoreService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should pull repositories', async () => {
    appStoreRepository.getEnabledAppStores.mockResolvedValue([{ id: 1, name: 'Main', url: 'http://test', slug: 'main', enabled: true } as any]);
    await service.pullRepositories();
    expect(repoHelpers.pullRepo).toHaveBeenCalledWith('http://test', 'main', 'git');
  });

  it('should register cloud app store if configured', async () => {
    appStoreRepository.getAppStoreBySlug.mockResolvedValue(null as any);
    appStoreRepository.getAllAppStores.mockResolvedValue([] as any); // Mock getAllAppStores
    await service.registerCloudAppStore();
    expect(appStoreRepository.createAppStore).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'ci-marketplace',
        url: 'cloud-url',
      }),
    );
  });

  it('should prevent deleting last app store', async () => {
    appStoreRepository.getAllAppStores.mockResolvedValue([{ slug: 'only-one' } as any]);
    await expect(service.deleteAppStore('only-one')).rejects.toThrow('APP_STORE_DELETE_ERROR_LAST_STORE');
  });

  it('should handle update_all queue event', async () => {
    const reply = vi.fn();
    appStoreRepository.getEnabledAppStores.mockResolvedValue([{ id: 1, url: 'http://test', slug: 'main', enabled: true, type: 'git' } as any]);
    repoHelpers.pullRepo.mockResolvedValue({ success: true, message: '' });

    await capturedQueueCallback({ command: 'update_all' }, reply);

    expect(repoHelpers.pullRepo).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ success: true, message: 'All repos updated' });
  });
});
