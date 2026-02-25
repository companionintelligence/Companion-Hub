// Mock modules to break circular dependency chain:
// AppsService → RegistrationService → CloudflareClientService → DockerService → AppsService
vi.mock('../../docker/docker.service', () => ({
  DockerService: vi.fn().mockImplementation(() => ({})),
}));

const mockAxiosGet = vi.fn();
vi.mock('axios', () => ({
  default: { get: (...args: any[]) => mockAxiosGet(...args) },
}));

import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { AppUrn } from '@runtipi/common/types';
import { AppsService } from '../apps.service';
import { AppFilesManager } from '../app-files-manager';
import { AppsRepository } from '../apps.repository';
import { MarketplaceService } from '../../marketplace/marketplace.service';
import { RegistrationService } from '../../registration/registration.service';
import { PortAllocationRepository } from '../../network/port-allocation.repository';
import { ModuleRef } from '@nestjs/core';

describe('AppsService', () => {
  let service: AppsService;
  let appsRepository: MockProxy<AppsRepository>;
  let appFilesManager: MockProxy<AppFilesManager>;
  let _logger: MockProxy<LoggerService>;
  let marketplaceService: MockProxy<MarketplaceService>;
  let configService: MockProxy<ConfigurationService>;
  let registrationService: MockProxy<RegistrationService>;
  let moduleRef: MockProxy<ModuleRef>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppsService,
        { provide: AppsRepository, useValue: mock<AppsRepository>() },
        { provide: AppFilesManager, useValue: mock<AppFilesManager>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: MarketplaceService, useValue: mock<MarketplaceService>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
        { provide: PortAllocationRepository, useValue: mock<PortAllocationRepository>() },
        { provide: RegistrationService, useValue: mock<RegistrationService>() },
        { provide: ModuleRef, useValue: mock<ModuleRef>() },
      ],
    }).compile();

    service = module.get<AppsService>(AppsService);
    appsRepository = module.get(AppsRepository);
    appFilesManager = module.get(AppFilesManager);
    _logger = module.get(LoggerService);
    marketplaceService = module.get(MarketplaceService);
    configService = module.get(ConfigurationService);
    registrationService = module.get(RegistrationService);
    moduleRef = module.get(ModuleRef);
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

  describe('checkAppAvailability', () => {
    const appUrn = 'test-store/test-app' as AppUrn;

    function setupApp(overrides: Record<string, any> = {}) {
      const app = {
        id: 1,
        appName: 'test-app',
        appStoreSlug: 'test-store',
        status: 'running',
        localSubdomain: 'myapp',
        port: 8080,
        exposureMode: 'local',
        ...overrides,
      };
      appsRepository.getAppByUrn.mockResolvedValue(app as any);
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: appUrn, url_suffix: '' } as any);
      marketplaceService.getAppUpdateInfo.mockResolvedValue({ latestVersion: 0, latestDockerVersion: '0.0.0' } as any);
      appFilesManager.getUserComposeFile.mockResolvedValue({ content: '' } as any);
      appFilesManager.getUserEnv.mockResolvedValue({ content: '' } as any);
      configService.getConfig.mockReturnValue({
        userSettings: { internalIp: '192.168.1.100', sslPort: 443, domain: 'example.com' },
      } as any);
      registrationService.getDeviceRegistrationInfo.mockResolvedValue({ slug: 'myorg' } as any);
      return app;
    }

    it('MUST return {available: false} when app is not running', async () => {
      setupApp({ status: 'stopped' });
      const result = await service.checkAppAvailability(appUrn);
      expect(result.available).toBe(false);
    });

    it('MUST construct local URL (http://internalIp:port) when exposureMode is local', async () => {
      setupApp({ exposureMode: 'local', port: 8080 });
      mockAxiosGet.mockResolvedValue({ status: 200, data: 'OK' });
      const result = await service.checkAppAvailability(appUrn);
      expect(result.available).toBe(true);
      expect(result.appUrl).toBe('http://192.168.1.100:8080');
    });

    it('MUST construct public URL (https://subdomain-org.domain) when exposureMode is cloudflare', async () => {
      setupApp({ exposureMode: 'cloudflare' });
      mockAxiosGet.mockResolvedValue({ status: 200, data: 'OK' });
      const result = await service.checkAppAvailability(appUrn);
      expect(result.available).toBe(true);
      expect(result.appUrl).toBe('https://myapp-myorg.example.com');
    });

    it('MUST return appUrl in response when available', async () => {
      setupApp({ exposureMode: 'local' });
      mockAxiosGet.mockResolvedValue({ status: 200, data: 'OK' });
      const result = await service.checkAppAvailability(appUrn);
      expect(result.appUrl).toBeDefined();
    });

    it("MUST return errorCode 'CF_TUNNEL_NOT_FOUND' for Cloudflare 1033 error", async () => {
      setupApp({ exposureMode: 'cloudflare' });
      mockAxiosGet.mockResolvedValue({
        status: 530,
        data: '<html>Cloudflare Ray ID abc Error 1033 cf-error-details</html>',
      });
      const result = await service.checkAppAvailability(appUrn);
      expect(result.errorCode).toBe('CF_TUNNEL_NOT_FOUND');
    });

    it("MUST return errorCode 'CF_UPSTREAM_ERROR' for Cloudflare 502/503/504", async () => {
      setupApp({ exposureMode: 'cloudflare' });
      mockAxiosGet.mockResolvedValue({
        status: 502,
        data: '<html>Cloudflare Ray ID abc Error 502</html>',
      });
      const result = await service.checkAppAvailability(appUrn);
      expect(result.errorCode).toBe('CF_UPSTREAM_ERROR');
    });

    it("MUST return errorCode 'CF_ORIGIN_DOWN' for Cloudflare 521", async () => {
      setupApp({ exposureMode: 'cloudflare' });
      mockAxiosGet.mockResolvedValue({
        status: 521,
        data: '<html>Cloudflare Ray ID abc Error 521</html>',
      });
      const result = await service.checkAppAvailability(appUrn);
      expect(result.errorCode).toBe('CF_ORIGIN_DOWN');
    });

    it("MUST return errorCode 'CF_TIMEOUT' for Cloudflare 522/524", async () => {
      setupApp({ exposureMode: 'cloudflare' });
      mockAxiosGet.mockResolvedValue({
        status: 522,
        data: '<html>Cloudflare Ray ID abc Error 522</html>',
      });
      const result = await service.checkAppAvailability(appUrn);
      expect(result.errorCode).toBe('CF_TIMEOUT');
    });

    it("MUST return errorCode 'DNS_NOT_FOUND' for ENOTFOUND errors", async () => {
      setupApp({ exposureMode: 'cloudflare' });
      mockAxiosGet.mockRejectedValue(new Error('getaddrinfo ENOTFOUND myapp-myorg.example.com'));
      const result = await service.checkAppAvailability(appUrn);
      expect(result.errorCode).toBe('DNS_NOT_FOUND');
    });

    it("MUST return errorCode 'CONNECTION_REFUSED' for ECONNREFUSED", async () => {
      setupApp({ exposureMode: 'local' });
      mockAxiosGet.mockRejectedValue(new Error('connect ECONNREFUSED 192.168.1.100:8080'));
      const result = await service.checkAppAvailability(appUrn);
      expect(result.errorCode).toBe('CONNECTION_REFUSED');
    });

    it("MUST return errorCode 'CONNECTION_TIMEOUT' for ETIMEDOUT", async () => {
      setupApp({ exposureMode: 'local' });
      mockAxiosGet.mockRejectedValue(new Error('connect ETIMEDOUT'));
      const result = await service.checkAppAvailability(appUrn);
      expect(result.errorCode).toBe('CONNECTION_TIMEOUT');
    });

    it('MUST return resolvable: true for DNS_NOT_FOUND', async () => {
      setupApp({ exposureMode: 'local' });
      mockAxiosGet.mockRejectedValue(new Error('ENOTFOUND'));
      const result = await service.checkAppAvailability(appUrn);
      expect(result.errorCode).toBe('DNS_NOT_FOUND');
      expect(result.resolvable).toBe(true);
    });

    it("MUST return errorCode 'PROXY_UPSTREAM_ERROR' for non-Cloudflare 502/503", async () => {
      setupApp({ exposureMode: 'local' });
      mockAxiosGet.mockResolvedValue({ status: 502, data: '<html>Bad Gateway</html>' });
      const result = await service.checkAppAvailability(appUrn);
      expect(result.errorCode).toBe('PROXY_UPSTREAM_ERROR');
    });

    it('SHOULD return exposure-mode-specific detail for DNS_NOT_FOUND', async () => {
      setupApp({ exposureMode: 'cloudflare' });
      mockAxiosGet.mockRejectedValue(new Error('ENOTFOUND'));
      const cfResult = await service.checkAppAvailability(appUrn);
      expect(cfResult.detail).toContain('Cloudflare');

      setupApp({ exposureMode: 'tailscale' });
      mockAxiosGet.mockRejectedValue(new Error('ENOTFOUND'));
      const tsResult = await service.checkAppAvailability(appUrn);
      expect(tsResult.detail).toContain('Tailscale');
    });
  });

  describe('resolveAppAvailability', () => {
    const appUrn = 'test-store/test-app' as AppUrn;

    function setupForResolve(axiosBehavior: 'ok' | 'dns' | 'proxy502' | 'connrefused' | 'timeout', appOverrides: Record<string, any> = {}) {
      const app = {
        id: 1,
        appName: 'test-app',
        appStoreSlug: 'test-store',
        status: 'running',
        localSubdomain: 'myapp',
        port: 8080,
        exposureMode: 'local',
        ...appOverrides,
      };
      appsRepository.getAppByUrn.mockResolvedValue(app as any);
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: appUrn, url_suffix: '' } as any);
      marketplaceService.getAppUpdateInfo.mockResolvedValue({ latestVersion: 0, latestDockerVersion: '0.0.0' } as any);
      appFilesManager.getUserComposeFile.mockResolvedValue({ content: '' } as any);
      appFilesManager.getUserEnv.mockResolvedValue({ content: '' } as any);
      configService.getConfig.mockReturnValue({
        userSettings: { internalIp: '192.168.1.100', sslPort: 443, domain: 'example.com' },
      } as any);
      registrationService.getDeviceRegistrationInfo.mockResolvedValue({ slug: 'myorg' } as any);

      if (axiosBehavior === 'ok') mockAxiosGet.mockResolvedValue({ status: 200, data: 'OK' });
      else if (axiosBehavior === 'dns') mockAxiosGet.mockRejectedValue(new Error('ENOTFOUND'));
      else if (axiosBehavior === 'proxy502') mockAxiosGet.mockResolvedValue({ status: 502, data: 'Bad Gateway' });
      else if (axiosBehavior === 'connrefused') mockAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'));
      else if (axiosBehavior === 'timeout') mockAxiosGet.mockRejectedValue(new Error('ETIMEDOUT'));
    }

    it('MUST return success:true when app is already available', async () => {
      setupForResolve('ok');
      const result = await service.resolveAppAvailability(appUrn);
      expect(result.success).toBe(true);
      expect(result.action).toBe('none');
    });

    it('MUST return success:false when error is not resolvable', async () => {
      setupForResolve('timeout');
      const result = await service.resolveAppAvailability(appUrn);
      expect(result.success).toBe(false);
    });

    it('MUST call syncExposurePublic for CF/DNS errors', async () => {
      const mockSync = vi.fn().mockResolvedValue(undefined);
      moduleRef.get.mockImplementation((() => ({ syncExposurePublic: mockSync, restartContainer: vi.fn() })) as any);

      setupForResolve('dns');
      await service.resolveAppAvailability(appUrn);
      expect(mockSync).toHaveBeenCalled();
    });

    it('MUST attempt container restart for PROXY_UPSTREAM_ERROR', async () => {
      const mockRestart = vi.fn().mockResolvedValue(undefined);
      moduleRef.get.mockImplementation((() => ({ restartContainer: mockRestart, syncExposurePublic: vi.fn() })) as any);

      setupForResolve('proxy502');
      await service.resolveAppAvailability(appUrn);
      expect(mockRestart).toHaveBeenCalledWith('test-app');
    });

    it('SHOULD call tailscaleService.serveApp for tailscale + CONNECTION_REFUSED', async () => {
      const mockServeApp = vi.fn().mockResolvedValue(undefined);
      moduleRef.get.mockImplementation((() => ({
        serveApp: mockServeApp,
        restartContainer: vi.fn().mockResolvedValue(undefined),
      })) as any);

      setupForResolve('connrefused', { exposureMode: 'tailscale' });
      await service.resolveAppAvailability(appUrn);
      expect(mockServeApp).toHaveBeenCalled();
    });
  });
});
