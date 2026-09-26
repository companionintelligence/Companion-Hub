import fs from 'node:fs';
import path from 'node:path';
import { AppService } from '@/app.service';
import { APP_DATA_DIR, APP_DIR, DATA_DIR, HUB_STACK_REGISTRY_REPO } from '@/common/constants';
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
import { APP_SESSION_KEY_PREFIX, SESSION_KEY_PREFIX } from '@/modules/auth/session.manager';

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

    databaseService.waitUntilReady.mockResolvedValue(undefined);
    databaseService.migrate.mockResolvedValue(undefined);
    cacheService.get.mockReturnValue(undefined);
    cacheService.clear.mockReturnValue(undefined);
    cacheService.set.mockReturnValue(undefined);
    appStoreService.registerCloudAppStore.mockResolvedValue(undefined);
    appStoreService.pullRepositories.mockResolvedValue({ success: true });
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
      registryService.getTagsSinceWithHubFallback.mockResolvedValueOnce([]);

      const result = await appService.getVersion();

      expect(result.current).toBe(version);
      expect(result.latest).toBe(version);
      expect(result.releases).toEqual([]);
      expect(registryService.getTagsSinceWithHubFallback).toHaveBeenCalledWith(HUB_STACK_REGISTRY_REPO, version);
    });

    it('should return latest version when newer tags exist', async () => {
      const version = '1.0.0';
      const newerTags = ['1.2.0', '1.1.0'];
      configurationService.getConfig.mockReturnValue(fromPartial({ version }));
      registryService.getTagsSinceWithHubFallback.mockResolvedValueOnce(newerTags);

      const result = await appService.getVersion();

      expect(result.current).toBe(version);
      expect(result.latest).toBe('1.2.0');
      expect(result.releases).toEqual([
        { version: '1.2.0', body: 'Release 1.2.0' },
        { version: '1.1.0', body: 'Release 1.1.0' },
      ]);
    });

    it('peekLocalVersion never calls the registry', () => {
      registryService.getTagsSinceWithHubFallback.mockClear();
      configurationService.getConfig.mockReturnValue(fromPartial({ version: '1.0.0' }));

      const result = appService.peekLocalVersion();

      expect(result).toEqual({ current: '1.0.0', latest: '1.0.0', body: '', releases: [] });
      expect(registryService.getTagsSinceWithHubFallback).not.toHaveBeenCalled();
    });

    it('returns the local version when the registry lookup times out', async () => {
      vi.useFakeTimers();
      configurationService.getConfig.mockReturnValue(fromPartial({ version: '1.0.0' }));
      registryService.getTagsSinceWithHubFallback.mockReturnValue(new Promise(() => undefined) as Promise<string[]>);

      const pending = appService.getVersion();
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await pending;

      expect(result).toEqual({ current: '1.0.0', latest: '1.0.0', body: '', releases: [] });
      vi.useRealTimers();
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
        [path.join(APP_DIR, 'assets', 'traefik', 'traefik.yml')]:
          'entryPoints:\n  web:\n    forwardedHeaders:\n      trustedIPs:\n        - 10.128.0.3/32 # edge hop: cloudflared\n        - 10.128.0.4/32 # edge hop: hub-tailscale\n  websecure:\n    forwardedHeaders:\n      trustedIPs:\n        - 10.128.0.3/32 # edge hop: cloudflared\n        - 10.128.0.4/32 # edge hop: hub-tailscale\ncertificatesResolvers:\n  letsencrypt:\n    acme:\n      email: {{ACME_EMAIL}}',
        [path.join(APP_DIR, 'assets', 'traefik', 'dynamic', 'dynamic.yml')]:
          'http:\n  middlewares:\n    ci-hub:\n      forwardAuth:\n        address: http://{{HUB_CONTAINER_NAME}}:5002/api/auth/traefik',
      });

      const traefikConfigPath = path.join(DATA_DIR, 'state', 'traefik', 'config', 'traefik.yml');
      const dynamicConfigPath = path.join(DATA_DIR, 'state', 'traefik', 'dynamic', 'dynamic.yml');
      await fs.promises.mkdir(traefikConfigPath, { recursive: true });
      await fs.promises.mkdir(dynamicConfigPath, { recursive: true });

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(APP_DIR);
      const previousHubContainerName = process.env.HUB_CONTAINER_NAME;
      const previousRabbitmqHost = process.env.RABBITMQ_HOST;
      delete process.env.HUB_CONTAINER_NAME;
      process.env.RABBITMQ_HOST = 'ci-os-hub-queue';
      // An operator who moved the edge network: the tagged hop lines follow it.
      vi.stubEnv('HUB_EDGE_CLOUDFLARED_IP', '10.200.0.3');
      vi.stubEnv('HUB_EDGE_TAILSCALE_IP', '10.200.0.4');

      try {
        await appService.copyAssets();
      } finally {
        cwdSpy.mockRestore();
        if (previousHubContainerName === undefined) delete process.env.HUB_CONTAINER_NAME;
        else process.env.HUB_CONTAINER_NAME = previousHubContainerName;
        if (previousRabbitmqHost === undefined) delete process.env.RABBITMQ_HOST;
        else process.env.RABBITMQ_HOST = previousRabbitmqHost;
        vi.unstubAllEnvs();
      }

      expect((await fs.promises.stat(traefikConfigPath)).isFile()).toBe(true);
      const traefikConfig = (await fs.promises.readFile(traefikConfigPath, 'utf8')).trim();
      expect(traefikConfig).toContain('admin@localhost');
      // Both entry points trust exactly the two edge hops, by address, and
      // never the edge subnet (whose gateway is how the host reaches Traefik).
      expect(traefikConfig.match(/- 10\.200\.0\.3\/32 # edge hop: cloudflared/g)).toHaveLength(2);
      expect(traefikConfig.match(/- 10\.200\.0\.4\/32 # edge hop: hub-tailscale/g)).toHaveLength(2);
      expect(traefikConfig).not.toContain('10.128.0.');
      expect((await fs.promises.stat(dynamicConfigPath)).isFile()).toBe(true);
      expect((await fs.promises.readFile(dynamicConfigPath, 'utf8')).trim()).toContain('address: http://ci-os-hub:5002/api/auth/traefik');
    });
  });

  describe('bootstrap', () => {
    it('continues bootstrap when docker socket access is denied during network prune', async () => {
      const error = Object.assign(new Error('connect EACCES /var/run/docker.sock'), { code: 'EACCES' });
      dockerode.pruneNetworks.mockRejectedValue(error);

      await expect(appService.bootstrap()).resolves.toBeUndefined();
      expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping Docker network prune during bootstrap'));
    });

    it('prunes only Hub-managed networks, never every idle network on the host', async () => {
      // A bare prune deletes the network of every stopped compose stack on the machine
      // (Docker counts only running containers as "in use"), which broke `make dev` in
      // sibling checkouts after each reboot. The filter is the whole fix.
      dockerode.pruneNetworks.mockResolvedValue({ NetworksDeleted: [] });

      await appService.bootstrap();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(dockerode.pruneNetworks).toHaveBeenCalledTimes(1);
      expect(dockerode.pruneNetworks).toHaveBeenCalledWith({ filters: { label: ['ci-hub.managed=true'] } });
    });

    it('schedules a background app store catalog sync after marketplace init', async () => {
      marketplaceService.initialize.mockClear();

      await appService.bootstrap();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(appStoreService.pullRepositories).toHaveBeenCalled();
      expect(marketplaceService.initialize).toHaveBeenCalledTimes(2);
    });

    it('spares Hub and app sessions from the version-bump cache wipe', async () => {
      // No stored buster, so this boot counts as an upgrade and wipes the cache. App sessions are no
      // more cache than Hub sessions are: losing them bounces every open app tab through edge SSO.
      await appService.bootstrap();

      expect(cacheService.clear).toHaveBeenCalledWith(expect.arrayContaining([SESSION_KEY_PREFIX, APP_SESSION_KEY_PREFIX]));
    });
  });
});
