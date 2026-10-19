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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { SystemEventsQueue } from '@/modules/queue/entities/system-events';
import { TranslatableError } from '@/common/error/translatable-error';

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
  let systemEventsQueue = mock<SystemEventsQueue>();

  beforeEach(async () => {
    dockerode = mock<Dockerode>();
    // One fresh mock per token. `useMocker(mock)` hands the class itself to `mock()` as the mock's
    // implementation, so the mock functions were stored on the class and every test wrapped the last
    // test's: setups leaked from test to test, and the module took twice as long to build each time.
    const mocks = new Map<unknown, unknown>();
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
      .useMocker((token) => {
        if (!mocks.has(token)) mocks.set(token, mock());
        return mocks.get(token);
      })
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
    systemEventsQueue = moduleRef.get(SystemEventsQueue);

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
          'http:\n  middlewares:\n    ci-hub:\n      forwardAuth:\n        address: http://ci-hub:5002/api/auth/traefik # hub container',
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

  /*
   * Traefik reads traefik.yml only at startup, and on an upgrade compose has recreated it from the
   * previous Hub's file before this Hub's bootstrap rewrites it — so the edge hops' `trustedIPs`
   * would wait for some unrelated Traefik restart unless the Hub restarts it.
   */
  describe('copyAssets restarts Traefik when its static config changed', () => {
    const traefikConfigPath = path.join(DATA_DIR, 'state', 'traefik', 'config', 'traefik.yml');
    const asset = 'entryPoints:\n  web:\n    forwardedHeaders:\n      trustedIPs:\n        - 10.128.0.3/32 # edge hop: cloudflared\n';
    let traefik: { inspect: ReturnType<typeof vi.fn>; restart: ReturnType<typeof vi.fn> };

    const copy = async () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(APP_DIR);
      vi.stubEnv('HUB_EDGE_CLOUDFLARED_IP', '');
      try {
        await appService.copyAssets();
      } finally {
        cwdSpy.mockRestore();
        vi.unstubAllEnvs();
      }
    };

    beforeEach(() => {
      configurationService.getConfig.mockReturnValue(
        fromPartial({ directories: { appDir: APP_DIR, dataDir: DATA_DIR, appDataDir: APP_DATA_DIR }, userSettings: { persistTraefikConfig: false } }),
      );
      (fs as unknown as FsMock).__applyMockFiles({
        [path.join(APP_DIR, 'assets', 'traefik', 'traefik.yml')]: asset,
        [path.join(APP_DIR, 'assets', 'traefik', 'dynamic', 'dynamic.yml')]: 'http: {}\n',
        // What an older Hub wrote: no forwardedHeaders at all.
        [traefikConfigPath]: 'entryPoints:\n  web:\n    address: ":80"\n',
      });
      traefik = { inspect: vi.fn().mockResolvedValue({ State: { Running: true } }), restart: vi.fn().mockResolvedValue(undefined) };
      dockerode.getContainer.mockReturnValue(traefik as never);
    });

    it('restarts a running Traefik once, when the file on disk predates the change', async () => {
      await copy();

      expect((await fs.promises.readFile(traefikConfigPath, 'utf8')).trimEnd()).toBe(asset.trimEnd());
      expect(dockerode.getContainer).toHaveBeenCalledWith('traefik');
      expect(traefik.restart).toHaveBeenCalledTimes(1);

      // The next boot writes the same file, so Traefik is left alone.
      await copy();
      expect(traefik.restart).toHaveBeenCalledTimes(1);
    });

    it('leaves Traefik alone when the CLI seeded the same file (trailing newline aside)', async () => {
      await fs.promises.writeFile(traefikConfigPath, asset.trimEnd());

      await copy();

      expect(traefik.restart).not.toHaveBeenCalled();
    });

    it('leaves a stopped Traefik to read the file when it starts', async () => {
      traefik.inspect.mockResolvedValue({ State: { Running: false } });

      await copy();

      expect(traefik.restart).not.toHaveBeenCalled();
    });

    it('does not restart on a first write, and a failed restart does not stop the boot', async () => {
      await fs.promises.rm(traefikConfigPath);
      await copy();
      expect(traefik.restart).not.toHaveBeenCalled();

      await fs.promises.writeFile(traefikConfigPath, 'entryPoints: {}\n');
      traefik.restart.mockRejectedValue(new Error('container is restarting'));
      await expect(copy()).resolves.toBeUndefined();
      expect((await fs.promises.readFile(traefikConfigPath, 'utf8')).trimEnd()).toBe(asset.trimEnd());
    });
  });

  /*
   * The compose file mounts the ACME store as a file and never creates it, so a missing one keeps
   * Traefik from starting at all. After a reboot Docker leaves that Traefik exited (CI-Hub#2055).
   */
  describe('copyAssets keeps Traefik ACME store in place', () => {
    const acmeStoragePath = path.join(DATA_DIR, 'state', 'traefik', 'acme_storage.json');
    const traefikConfigPath = path.join(DATA_DIR, 'state', 'traefik', 'config', 'traefik.yml');
    let traefik: {
      inspect: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
      restart: ReturnType<typeof vi.fn>;
    };

    const copy = async () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(APP_DIR);
      vi.stubEnv('HUB_EDGE_CLOUDFLARED_IP', '');
      try {
        await appService.copyAssets();
      } finally {
        cwdSpy.mockRestore();
        vi.unstubAllEnvs();
      }
    };

    beforeEach(() => {
      configurationService.getConfig.mockReturnValue(
        fromPartial({ directories: { appDir: APP_DIR, dataDir: DATA_DIR, appDataDir: APP_DATA_DIR }, userSettings: { persistTraefikConfig: false } }),
      );
      (fs as unknown as FsMock).__applyMockFiles({
        [path.join(APP_DIR, 'assets', 'traefik', 'traefik.yml')]: 'entryPoints: {}\n',
        [path.join(APP_DIR, 'assets', 'traefik', 'dynamic', 'dynamic.yml')]: 'http: {}\n',
      });
      // What a reboot leaves behind when the store was missing at boot.
      traefik = {
        inspect: vi.fn().mockResolvedValue({ State: { Status: 'exited', Running: false, ExitCode: 127 } }),
        start: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn().mockResolvedValue(undefined),
      };
      dockerode.getContainer.mockReturnValue(traefik as never);
    });

    it('creates a missing store that only its owner can read, then starts the exited Traefik', async () => {
      await copy();

      expect(await fs.promises.readFile(acmeStoragePath, 'utf8')).toBe('{}');
      expect((await fs.promises.stat(acmeStoragePath)).mode & 0o777).toBe(0o600);
      expect(dockerode.getContainer).toHaveBeenCalledWith('traefik');
      expect(traefik.start).toHaveBeenCalledTimes(1);

      // The next boot finds the store and leaves Traefik alone.
      await copy();
      expect(traefik.start).toHaveBeenCalledTimes(1);
    });

    it('never touches a store that exists, or Traefik', async () => {
      await fs.promises.mkdir(path.dirname(acmeStoragePath), { recursive: true });
      await fs.promises.writeFile(acmeStoragePath, '{"letsencrypt":{"Certificates":[]}}', { mode: 0o600 });

      await copy();

      expect(await fs.promises.readFile(acmeStoragePath, 'utf8')).toBe('{"letsencrypt":{"Certificates":[]}}');
      expect(traefik.start).not.toHaveBeenCalled();
    });

    it('replaces a directory at the store path with an empty store', async () => {
      await fs.promises.mkdir(acmeStoragePath, { recursive: true });

      await copy();

      expect((await fs.promises.stat(acmeStoragePath)).isFile()).toBe(true);
      expect(await fs.promises.readFile(acmeStoragePath, 'utf8')).toBe('{}');
      expect(traefik.start).toHaveBeenCalledTimes(1);
    });

    it('creates the store before a changed traefik.yml restarts a running Traefik and does not start it again', async () => {
      await fs.promises.mkdir(path.dirname(traefikConfigPath), { recursive: true });
      await fs.promises.writeFile(traefikConfigPath, 'entryPoints:\n  web:\n    address: ":80"\n');
      traefik.inspect.mockResolvedValue({ State: { Status: 'running', Running: true } });
      let storeExistedAtRestart = false;
      traefik.restart.mockImplementation(async () => {
        storeExistedAtRestart = fs.existsSync(acmeStoragePath);
      });

      await copy();

      expect(traefik.restart).toHaveBeenCalledTimes(1);
      expect(storeExistedAtRestart).toBe(true);
      expect(traefik.start).not.toHaveBeenCalled();
    });

    it('leaves a restarting or paused Traefik alone', async () => {
      traefik.inspect.mockResolvedValue({ State: { Status: 'restarting', Running: false, Restarting: true } });

      await copy();

      expect(await fs.promises.readFile(acmeStoragePath, 'utf8')).toBe('{}');
      expect(traefik.start).not.toHaveBeenCalled();
    });

    it('takes a Traefik that something else started first as started, with no warning', async () => {
      traefik.start.mockRejectedValue(Object.assign(new Error('(HTTP code 304) container already started'), { statusCode: 304 }));

      await expect(copy()).resolves.toBeUndefined();

      expect(traefik.start).toHaveBeenCalledTimes(1);
      expect(loggerService.warn).not.toHaveBeenCalledWith(expect.stringContaining('Could not start Traefik'));
    });

    it('finishes the boot when Traefik cannot be started or does not exist', async () => {
      traefik.start.mockRejectedValue(new Error('driver failed programming external connectivity'));
      await expect(copy()).resolves.toBeUndefined();
      expect(traefik.start).toHaveBeenCalledTimes(1);

      await fs.promises.rm(acmeStoragePath);
      traefik.inspect.mockRejectedValue(Object.assign(new Error('no such container: traefik'), { statusCode: 404 }));
      await expect(copy()).resolves.toBeUndefined();
      expect(await fs.promises.readFile(acmeStoragePath, 'utf8')).toBe('{}');
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

    /*
     * At log level Debug, bootstrap writes the configuration into the log, and Settings → Logs hands
     * that log to whoever asks for it (#1724). The configuration below is shaped like the one
     * `ConfigurationService.configure()` builds, and every credential in it has a value of its own,
     * so a leak names the field it came from.
     */
    it('logs the configuration at startup without any of its credentials', async () => {
      const credentials = {
        postgresPassword: 'leaked-postgres-password',
        rabbitmqPassword: 'leaked-rabbitmq-password',
        jwtSecret: 'leaked-jwt-secret',
        forwardAuthSecret: 'leaked-forward-auth-secret',
        ciHubApiKey: 'leaked-portal-device-key',
        ciHubMoveKey: 'leaked-portal-move-key',
        hubLocalKey: 'leaked-host-local-key',
        portalPushKeyPending: 'leaked-portal-push-key',
        inferenceVllmApiKey: 'leaked-vllm-api-key',
        cloudProviderApiKey: 'leaked-openai-api-key',
      };
      configurationService.getConfig.mockReturnValue(
        fromPartial({
          database: { host: 'ci-hub-db', port: 5432, username: 'tipi', password: credentials.postgresPassword, database: 'tipi' },
          queue: { host: 'ci-hub-queue', username: 'tipi', password: credentials.rabbitmqPassword, port: 5672 },
          directories: { dataDir: DATA_DIR, appDataDir: APP_DATA_DIR, appDir: APP_DIR },
          logLevel: 'debug',
          version: '1.2.3',
          isProduction: false,
          userSettings: {
            demoMode: false,
            disablePasswordReset: true,
            domain: 'example.com',
            port: 8080,
            sslPort: 8443,
            postgresPort: 5432,
            forwardAuthUrl: 'http://ci-hub:5002/api/auth/traefik',
            persistTraefikConfig: false,
            logLevel: 'debug',
            inferenceBackend: 'vllm',
            inferenceVllmApiKey: credentials.inferenceVllmApiKey,
            inferenceVllmUrl: 'http://vllm:8000',
            inferenceCloudProviders: [
              {
                provider: 'openai',
                apiKey: credentials.cloudProviderApiKey,
                baseUrl: 'https://api.openai.com/v1',
                defaultModel: 'gpt-4o',
                enabled: true,
              },
            ],
            hubPoolMaxPromptTokens: 16000,
            experimental: { insecureCookie: false },
          },
          domain: 'example.com',
          ciCloudUrl: 'https://portal.example.com',
          ciHubOrganizationId: 'org-1',
          ciHubApiKey: credentials.ciHubApiKey,
          ciHubMoveKey: credentials.ciHubMoveKey,
          hubLocalKey: credentials.hubLocalKey,
          portalPushKeyPrefix: 'abcdef01',
          portalPushKeyPending: credentials.portalPushKeyPending,
          portalPushKeyDeliveredAt: '2026-09-25T12:00:00.000Z',
          architecture: 'amd64',
          rootFolderHost: '/opt/ci-hub',
          jwtSecret: credentials.jwtSecret,
          forwardAuthSecret: credentials.forwardAuthSecret,
          __prod__: false,
        }),
      );

      await appService.bootstrap();

      // Each call rendered the way LoggerService writes it: an Error as its message and stack, any
      // other object as JSON.
      const written = (['debug', 'info', 'warn', 'error'] as const)
        .flatMap((level) => loggerService[level].mock.calls)
        .map((args) =>
          args
            .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
            .join(' '),
        )
        .join('\n');
      expect(Object.values(credentials).filter((credential) => written.includes(credential))).toEqual([]);

      // Still the line someone debugging a Hub needs: version, folders, ports and switches.
      const startup = loggerService.debug.mock.calls.find(([message]) => message === 'Starting with configuration');
      expect(startup?.[1]).toMatchObject({
        version: '1.2.3',
        directories: { dataDir: DATA_DIR, appDataDir: APP_DATA_DIR, appDir: APP_DIR },
        database: { host: 'ci-hub-db', port: 5432, username: 'tipi', password: '[redacted]' },
        queue: { host: 'ci-hub-queue', port: 5672, password: '[redacted]' },
        userSettings: {
          port: 8080,
          sslPort: 8443,
          disablePasswordReset: true,
          hubPoolMaxPromptTokens: 16000,
          inferenceVllmApiKey: '[redacted]',
          inferenceVllmUrl: 'http://vllm:8000',
          inferenceCloudProviders: [{ provider: 'openai', apiKey: '[redacted]', defaultModel: 'gpt-4o' }],
          experimental: { insecureCookie: false },
        },
        ciHubApiKey: '[redacted]',
        ciHubMoveKey: '[redacted]',
        hubLocalKey: '[redacted]',
        portalPushKeyPrefix: 'abcdef01',
        portalPushKeyPending: '[redacted]',
        portalPushKeyDeliveredAt: '2026-09-25T12:00:00.000Z',
        jwtSecret: '[redacted]',
        forwardAuthSecret: '[redacted]',
        __prod__: false,
      });
    });
  });

  /*
   * An uninstall of the desktop app that keeps its data removes every app container but keeps the
   * cache, so a reinstall of the same version skipped the version-change restart. The apps stayed
   * down and the status sync reported each one as a crash (Companion-Hub#1980).
   */
  describe('bootstrap on the version the cache already holds', () => {
    const wordpress = { id: 1, appName: 'wordpress', appStoreSlug: 'ci-marketplace', status: 'running', config: {} };

    beforeEach(() => {
      configurationService.getConfig.mockReturnValue(
        fromPartial({
          version: '1.0.0',
          __prod__: true,
          directories: { appDir: APP_DIR, dataDir: DATA_DIR, appDataDir: APP_DATA_DIR },
          userSettings: { logLevel: 'info', persistTraefikConfig: false },
        }),
      );
      cacheService.get.mockImplementation((key: string) => (key === 'buster' ? '1.0.0' : undefined));
      dockerode.listContainers.mockResolvedValue([]);
      appsRepository.updateAppByIdIfStatus.mockResolvedValue(true);
      appLifecycleService.startApp.mockResolvedValue({ requestId: 'req-1' });
    });

    it('starts a running app that has no containers before it schedules the status sync', async () => {
      appsRepository.getApps.mockResolvedValue([wordpress] as never);

      await appService.bootstrap();

      expect(appLifecycleService.restartRunningApps).not.toHaveBeenCalled();
      expect(appLifecycleService.startApp).toHaveBeenCalledTimes(1);
      expect(appLifecycleService.startApp).toHaveBeenCalledWith({
        appUrn: 'wordpress:ci-marketplace',
        skipPull: true,
        onlyRecreateChanged: true,
        actor: { kind: 'system', reason: 'bootstrap-recreate' },
      });
      // The start moves the row to `starting`, so the first sync cannot read it as a crash.
      const syncCall = systemEventsQueue.publishRepeatable.mock.calls.findIndex(([event]) => event.command === 'sync_app_statuses');
      expect(syncCall).toBeGreaterThanOrEqual(0);
      expect(appLifecycleService.startApp.mock.invocationCallOrder[0]).toBeLessThan(
        systemEventsQueue.publishRepeatable.mock.invocationCallOrder[syncCall],
      );
    });

    it('leaves stopped apps, apps with containers, and port-expose apps alone', async () => {
      appsRepository.getApps.mockResolvedValue([
        { id: 2, appName: 'plane', appStoreSlug: 'ci-marketplace', status: 'stopped', config: {} },
        { id: 3, appName: 'flatnotes', appStoreSlug: 'ci-marketplace', status: 'running', config: {} },
        { id: 4, appName: 'ggs', appStoreSlug: '_user', status: 'running', config: { kind: 'port-expose', port: 3000 } },
      ] as never);
      // Stopped with `docker stop`, as the desktop's Stop Hub leaves it: the status sync reads it.
      dockerode.listContainers.mockImplementation((async (options?: Dockerode.ContainerListOptions) =>
        options?.filters && JSON.stringify(options.filters).includes('ci-hub.managed=true')
          ? [
              {
                Id: 'f1',
                State: 'exited',
                Status: 'Exited (0) 1 hour ago',
                Labels: { 'ci-hub.managed': 'true', 'ci-hub.appurn': 'flatnotes:ci-marketplace' },
              },
            ]
          : []) as never);

      await appService.bootstrap();

      expect(appLifecycleService.startApp).not.toHaveBeenCalled();
    });

    /*
     * A start the queue never took puts back the status it read. Left `running` with no containers,
     * the app was what the first status sync reports as a crash.
     */
    it('moves the app to starting before it starts it', async () => {
      appsRepository.getApps.mockResolvedValue([wordpress] as never);

      await appService.bootstrap();

      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(1, 'running', { status: 'starting' });
      expect(appsRepository.updateAppByIdIfStatus.mock.invocationCallOrder[0]).toBeLessThan(appLifecycleService.startApp.mock.invocationCallOrder[0]);
    });

    describe('when the queue is not up yet', () => {
      const refusal = () => new TranslatableError('APP_ERROR_QUEUE_UNAVAILABLE', { command: 'start' }, 503);

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        appsRepository.getApps.mockResolvedValue([wordpress] as never);
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('starts the app once the queue is up, and leaves it starting meanwhile', async () => {
        appLifecycleService.startApp.mockRejectedValueOnce(refusal());
        systemEventsQueue.unavailableReason.mockReturnValueOnce("Queue 'system-events-queue' is unavailable while RabbitMQ is connecting.");

        await appService.bootstrap();
        expect(appLifecycleService.startApp).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(2_000);

        await vi.waitFor(() => expect(appLifecycleService.startApp).toHaveBeenCalledTimes(2));
        expect(appLifecycleService.startApp).toHaveBeenLastCalledWith(expect.objectContaining({ appUrn: 'wordpress:ci-marketplace' }));
        expect(appsRepository.updateAppByIdIfStatus).not.toHaveBeenCalledWith(1, expect.anything(), { status: 'stopped' });
      });

      it('marks the app stopped when the queue refuses it again', async () => {
        appLifecycleService.startApp.mockRejectedValue(refusal());
        systemEventsQueue.unavailableReason.mockReturnValue("Queue 'system-events-queue' is unavailable while RabbitMQ is connecting.");

        await appService.bootstrap();
        await vi.advanceTimersByTimeAsync(10 * 60_000);

        await vi.waitFor(() => expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(1, 'starting', { status: 'stopped' }));
        expect(appLifecycleService.startApp).toHaveBeenCalledTimes(2);
      });
    });

    it('marks an app stopped at once when its start fails for another reason', async () => {
      appsRepository.getApps.mockResolvedValue([wordpress] as never);
      appLifecycleService.startApp.mockRejectedValue(new Error('connection to the database was lost'));

      await expect(appService.bootstrap()).resolves.toBeUndefined();

      expect(appsRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(1, 'starting', { status: 'stopped' });
      expect(appLifecycleService.startApp).toHaveBeenCalledTimes(1);
    });

    // The boot waits on this listing before the Hub listens, so a Docker that never answers must not hold it.
    it('finishes the boot without starting anything when Docker does not list the containers', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        appsRepository.getApps.mockResolvedValue([wordpress] as never);
        dockerode.listContainers.mockReturnValue(new Promise(() => undefined) as never);

        let settled = false;
        const booting = appService.bootstrap().finally(() => {
          settled = true;
        });
        for (let tick = 0; tick < 40 && !settled; tick++) {
          await vi.advanceTimersByTimeAsync(1_000);
        }

        await expect(booting).resolves.toBeUndefined();
        expect(appLifecycleService.startApp).not.toHaveBeenCalled();
        expect(systemEventsQueue.publishRepeatable).toHaveBeenCalledWith({ command: 'sync_app_statuses' }, '*/5 * * * *');
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves the apps to the version-change restart on an upgrade', async () => {
      appsRepository.getApps.mockResolvedValue([wordpress] as never);
      cacheService.get.mockReturnValue('0.9.0');

      await appService.bootstrap();

      expect(appLifecycleService.restartRunningApps).toHaveBeenCalledTimes(1);
      expect(appLifecycleService.startApp).not.toHaveBeenCalled();
    });
  });
});
