import fs from 'node:fs';
import path from 'node:path';
import { AppService } from '@/app.service';
import { APP_DATA_DIR, APP_DIR, DATA_DIR } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { FsMock } from '@/tests/__mocks__/fs';
import { RegistryService } from '@/utils/registry/registry.service';
import { faker } from '@faker-js/faker';
import { Test } from '@nestjs/testing';
import { fromPartial } from '@total-typescript/shoehorn';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DOCKERODE } from '@/modules/docker/docker.module';
import Dockerode from 'dockerode';
import { DatabaseService } from '@/core/database/database.service';
import { LoggerService } from '@/core/logger/logger.service';
import { CacheService } from '@/core/cache/cache.service';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { PortManagerService } from '@/modules/network/port-manager.service';

describe('AppService', () => {
  let appService: AppService;
  let configurationService = mock<ConfigurationService>();
  let registryService = mock<RegistryService>();
  let dockerode = mock<Dockerode>();
  let databaseService = mock<DatabaseService>();
  let loggerService = mock<LoggerService>();
  let cacheService = mock<CacheService>();
  let appStoreService = mock<AppStoreService>();
  let marketplaceService = mock<MarketplaceService>();
  let appLifecycleService = mock<AppLifecycleService>();
  let appsRepository = mock<AppsRepository>();
  let portManagerService = mock<PortManagerService>();

  beforeEach(async () => {
    dockerode = mock<Dockerode>();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppService,
        FilesystemService,
        {
          provide: DOCKERODE,
          useValue: dockerode,
        },
      ],
    })
      .useMocker(mock)
      .compile();

    appService = moduleRef.get(AppService);
    configurationService = moduleRef.get(ConfigurationService);
    registryService = moduleRef.get(RegistryService);
    databaseService = moduleRef.get(DatabaseService);
    loggerService = moduleRef.get(LoggerService);
    cacheService = moduleRef.get(CacheService);
    appStoreService = moduleRef.get(AppStoreService);
    marketplaceService = moduleRef.get(MarketplaceService);
    appLifecycleService = moduleRef.get(AppLifecycleService);
    appsRepository = moduleRef.get(AppsRepository);
    portManagerService = moduleRef.get(PortManagerService);

    databaseService.migrate.mockResolvedValue(undefined);
    cacheService.get.mockReturnValue(undefined);
    cacheService.clear.mockReturnValue(undefined);
    cacheService.set.mockReturnValue(undefined);
    appStoreService.registerCloudAppStore.mockResolvedValue(undefined);
    marketplaceService.initialize.mockResolvedValue(undefined);
    appsRepository.getApps.mockResolvedValue([]);
    portManagerService.migrateExistingApp.mockResolvedValue(undefined as never);
    appLifecycleService.restartRunningApps.mockResolvedValue(undefined);
    configurationService.getConfig.mockReturnValue(
      fromPartial({
        version: '1.0.0',
        __prod__: false,
        directories: { appDir: APP_DIR, dataDir: DATA_DIR, appDataDir: APP_DATA_DIR },
        userSettings: { logLevel: 'info', persistTraefikConfig: false },
      }),
    );
  });

  describe('getVersion', () => {
    it('should return current version when no newer tags exist', async () => {
      const version = faker.system.semver();
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ version }));
      registryService.getTagsSince.mockResolvedValueOnce([]);

      const result = await appService.getVersion();

      expect(result.current).toBe(version);
      expect(result.latest).toBe(version);
      expect(result.releases).toEqual([]);
      expect(registryService.getTagsSince).toHaveBeenCalledWith('ci-os-hub', version);
    });

    it('should return latest version when newer tags exist', async () => {
      const version = '1.0.0';
      const newerTags = ['1.2.0', '1.1.0'];
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ version }));
      registryService.getTagsSince.mockResolvedValueOnce(newerTags);

      const result = await appService.getVersion();

      expect(result.current).toBe(version);
      expect(result.latest).toBe('1.2.0');
      expect(result.releases).toEqual([
        { version: '1.2.0', body: 'Release 1.2.0' },
        { version: '1.1.0', body: 'Release 1.1.0' },
      ]);
    });
  });

  describe('copyAssets', () => {
    it('should create base folder structure', async () => {
      const appDir = APP_DIR;
      const dataDir = DATA_DIR;
      const appDataDir = APP_DATA_DIR;
      const directories = { appDir, dataDir, appDataDir };
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ directories, userSettings: { persistTraefikConfig: false } }));

      await appService.copyAssets();

      expect((fs as unknown as FsMock).tree()).toMatchSnapshot();
    });

    it('should replace Traefik config directories with files during bootstrap', async () => {
      const directories = { appDir: APP_DIR, dataDir: DATA_DIR, appDataDir: APP_DATA_DIR };
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ directories, userSettings: { persistTraefikConfig: false } }));

      (fs as unknown as FsMock).__applyMockFiles({
        [path.join(APP_DIR, 'assets', 'traefik', 'traefik.yml')]: 'certificatesResolvers:\n  letsencrypt:\n    acme:\n      email: {{ACME_EMAIL}}',
        [path.join(APP_DIR, 'assets', 'traefik', 'dynamic', 'dynamic.yml')]: 'http:\n  middlewares: {}',
      });

      const traefikConfigPath = path.join(DATA_DIR, 'state', 'traefik', 'config', 'traefik.yml');
      const dynamicConfigPath = path.join(DATA_DIR, 'state', 'traefik', 'dynamic', 'dynamic.yml');
      await fs.promises.mkdir(traefikConfigPath, { recursive: true });
      await fs.promises.mkdir(dynamicConfigPath, { recursive: true });

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(APP_DIR);

      await appService.copyAssets();

      cwdSpy.mockRestore();

      expect((await fs.promises.stat(traefikConfigPath)).isFile()).toBe(true);
      expect((await fs.promises.readFile(traefikConfigPath, 'utf8')).trim()).toContain('admin@example.com');
      expect((await fs.promises.stat(dynamicConfigPath)).isFile()).toBe(true);
      expect((await fs.promises.readFile(dynamicConfigPath, 'utf8')).trim()).toBe('http:\n  middlewares: {}');
    });
  });

  describe('bootstrap', () => {
    it('continues bootstrap when docker socket access is denied during network prune', async () => {
      const error = Object.assign(new Error('connect EACCES /var/run/docker.sock'), { code: 'EACCES' });
      dockerode.pruneNetworks.mockRejectedValue(error);

      await expect(appService.bootstrap()).resolves.toBeUndefined();
      expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping Docker network prune during bootstrap'));
    });
  });
});
