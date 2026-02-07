import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AppsService } from '../apps.service';
import { AppFilesManager } from '../app-files-manager';
import { AppsRepository } from '../apps.repository';
import { MarketplaceService } from '../../marketplace/marketplace.service';
import { RegistrationService } from '../../registration/registration.service';
import type { AppUrn } from '@runtipi/common/types';

describe('AppsService', () => {
  let service: AppsService;
  let appsRepository: MockProxy<AppsRepository>;
  let appFilesManager: MockProxy<AppFilesManager>;
  let _logger: MockProxy<LoggerService>;
  let marketplaceService: MockProxy<MarketplaceService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppsService,
        { provide: AppsRepository, useValue: mock<AppsRepository>() },
        { provide: AppFilesManager, useValue: mock<AppFilesManager>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: MarketplaceService, useValue: mock<MarketplaceService>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
        { provide: RegistrationService, useValue: mock<RegistrationService>() },
      ],
    }).compile();

    service = module.get<AppsService>(AppsService);
    appsRepository = module.get(AppsRepository);
    appFilesManager = module.get(AppFilesManager);
    _logger = module.get(LoggerService);
    marketplaceService = module.get(MarketplaceService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getInstalledApps', () => {
    it('should return populated app info for installed apps', async () => {
      // Arrange
      const mockApp = {
        id: 1,
        appName: 'test-app',
        appStoreSlug: 'test-store',
        localSubdomain: 'test',
        port: 8080,
      };

      const mockApps = [mockApp];
      appsRepository.getApps.mockResolvedValue(mockApps as any);

      const mockAppInfo = {
        id: 'test-store/test-app',
        version: '1.0.0',
        name: 'Test App',
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(mockAppInfo as any);

      const mockUpdateInfo = { latestVersion: '1.1.0', latestDockerVersion: '1.1.0' };
      marketplaceService.getAppUpdateInfo.mockResolvedValue(mockUpdateInfo as any);

      appFilesManager.getDockerComposeJson.mockResolvedValue({ content: 'version: "3"' } as any);

      // Act
      const result = await service.getInstalledApps();

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]?.app).toEqual(mockApp);
      expect(result[0]?.info).toEqual(mockAppInfo);
      expect(result[0]?.metadata).toMatchObject({
        latestVersion: '1.1.0',
        localSubdomain: 'test',
      });
    });
  });

  describe('getApp', () => {
    it('should return details for a specific app', async () => {
      // Arrange
      const appUrn = 'test-store/test-app' as AppUrn;
      const mockApp = {
        id: 1,
        appName: 'test-app',
        appStoreSlug: 'test-store',
      };
      appsRepository.getAppByUrn.mockResolvedValue(mockApp as any);

      marketplaceService.getAppUpdateInfo.mockResolvedValue({ latestVersion: 0, latestDockerVersion: '0.0.0' } as any);

      const mockAppInfo = {
        id: appUrn,
        description: 'Test Description',
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(mockAppInfo as any);
      appFilesManager.getUserComposeFile.mockResolvedValue({ content: '' } as any);
      appFilesManager.getUserEnv.mockResolvedValue({ content: '' } as any);

      // Act
      const result = await service.getApp(appUrn);

      // Assert
      expect(result.info).toEqual(mockAppInfo);
      expect(result.app).toEqual(mockApp);
    });
  });
});
