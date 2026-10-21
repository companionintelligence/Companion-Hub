import { DATABASE } from '@/core/database/database.module';
import { CacheService } from '@/core/cache/cache.service';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DOCKERODE } from '@/modules/docker/constants';
import { Test } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import { getTableName, is, type SQLWrapper } from 'drizzle-orm';
import { PgDialect, PgTable } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { FactoryResetService } from '../factory-reset.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { BearerOrgMembershipCache } from '@/modules/auth/bearer-org-membership.cache';
import { APP_DATA_DIR, TUNNEL_DIR } from '@/common/constants';
import { TranslatableError } from '@/common/error/translatable-error';
import * as schema from '@/core/database/drizzle/schema';
import { app } from '@/core/database/drizzle/schema';
import { ForwardAuthIdentityResolver } from '@/modules/auth/forward-auth-identity.resolver';
import { HubPoolIdentityService } from '@/modules/hub-pool/hub-pool-identity.service';
import { HubPoolPairingPinService } from '@/modules/hub-pool/hub-pool-pairing-pin.service';
import { AppCredentialsService } from '@/modules/inference/app-credentials.service';
import { HANDOUT_RECORDS_PATH, type RecordedHandout } from '@/modules/inference/app-handout-record';
import { CloudFallbackService } from '@/modules/inference/cloud-fallback.service';
import { ModelRegistryService } from '@/modules/inference/model-registry.service';
import { PINNED_MODELS_PATH, writePinnedModels } from '@/modules/inference/pinned-models-record';
import type { CloudProviderConfig } from '@ci-hub/common/types';
import fs from 'node:fs';
import path from 'node:path';
import { vol } from 'memfs';

const uninstallExecute = vi.fn().mockResolvedValue({ success: true, message: 'ok' });

/** `ConfigurationService.get` on a Hub whose data folder is `/data`, mounted from an ordinary ROOT_FOLDER_HOST. */
const configurationValue = (key: string) => (key === 'rootFolderHost' ? '/opt/ci-hub' : { dataDir: '/data' });

vi.mock('@/modules/app-lifecycle/commands/uninstall-app-command', () => ({
  UninstallAppCommand: class {
    execute = uninstallExecute;
  },
}));

describe('FactoryResetService', () => {
  let service: FactoryResetService;
  let db: { execute: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; query: { app: { findMany: ReturnType<typeof vi.fn> } } };
  let filesystem: MockProxy<FilesystemService>;
  let cache: MockProxy<CacheService>;
  let sessionUserCache: SessionUserCache;
  let registrationService: MockProxy<RegistrationService>;
  let bearerOrgMembership: BearerOrgMembershipCache;
  let moduleRefMock: MockProxy<ModuleRef>;

  beforeEach(async () => {
    uninstallExecute.mockClear();
    db = {
      execute: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      query: { app: { findMany: vi.fn().mockResolvedValue([]) } },
    };
    filesystem = mock<FilesystemService>();
    bearerOrgMembership = new BearerOrgMembershipCache();
    moduleRefMock = mock<ModuleRef>();
    moduleRefMock.get.mockImplementation((token: unknown) => (token === BearerOrgMembershipCache ? bearerOrgMembership : undefined) as never);
    cache = mock<CacheService>();
    registrationService = mock<RegistrationService>();
    registrationService.resetRegistration.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        FactoryResetService,
        { provide: DATABASE, useValue: db },
        { provide: DOCKERODE, useValue: {} },
        { provide: ModuleRef, useValue: moduleRefMock },
        { provide: FilesystemService, useValue: filesystem },
        {
          provide: ConfigurationService,
          useValue: {
            get: vi.fn(configurationValue),
            forgetPersistedUserSettings: vi.fn(),
          },
        },
        { provide: CacheService, useValue: cache },
        // Real instance: the point of the assertion below is that the wipe empties this map.
        SessionUserCache,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: RegistrationService, useValue: registrationService },
      ],
    }).compile();

    service = moduleRef.get(FactoryResetService);
    sessionUserCache = moduleRef.get(SessionUserCache);
    filesystem.pathExists.mockResolvedValue(true);
    filesystem.removeDirectory.mockResolvedValue(true);
    filesystem.createDirectory.mockResolvedValue(true);
  });

  it('wipes the database and clears sessions', async () => {
    const result = await service.execute();

    expect(result.success).toBe(true);
    expect(db.execute).toHaveBeenCalled();
    expect(registrationService.resetRegistration).toHaveBeenCalledWith({ reason: 'manual', removesDeviceKey: true });
    expect(cache.clear).toHaveBeenCalled();
  });

  /**
   * Forward-auth Bearer verdicts moved out of CacheService into a process-local store, so
   * `cache.clear()` no longer reaches them. Without an explicit clear, a subject cached as allowed
   * seconds before the reset keeps passing forward-auth for the rest of its 60s TTL — on an
   * appliance that has just been unbound from the organisation that vouched for them.
   */
  it('MUST revoke cached Bearer org-membership verdicts, which CacheService.clear() cannot reach', async () => {
    bearerOrgMembership.set('portal-subject', true);
    expect(bearerOrgMembership.get('portal-subject')).toBe(true);

    await service.execute();

    expect(bearerOrgMembership.get('portal-subject')).toBeUndefined();
  });

  // The TRUNCATE goes around UserRepository, so nothing else drops these entries: a surviving
  // DTO keeps a wiped Hub answering AuthGuard as an operator, and `RESTART IDENTITY` means the
  // next account created can be handed the same id the stale entry describes.
  it('MUST drop cached session users when the user table is truncated', async () => {
    sessionUserCache.set(1, { id: 1, username: 'previous-operator' } as never);
    expect(sessionUserCache.get(1)).toBeDefined();

    await service.wipeDatabase();

    expect(sessionUserCache.get(1)).toBeUndefined();
  });

  /**
   * Sessions live in CacheService and outlive the rows they name. `execute()` only clears them
   * after three more awaits, so a reset that failed partway used to leave a live `ci-hub-sid`
   * behind — and `RESTART IDENTITY` hands the next account the very id that cookie resolves to,
   * which would admit the old browser tab as the new operator.
   */
  it('MUST clear sessions in the same step that truncates the user rows they point at', async () => {
    await service.wipeDatabase();

    expect(cache.clear).toHaveBeenCalled();
  });

  /**
   * A key acts with its creator's grants, and `RESTART IDENTITY` hands the next account that
   * creator's id. CASCADE reaches `api_key` through `created_by_user_id` today; naming the table
   * keeps every key going with a reset however that foreign key changes.
   */
  it('MUST name api_key in the TRUNCATE rather than leave the keys to a foreign-key cascade', async () => {
    await service.wipeDatabase();

    const { sql: statement } = new PgDialect().sqlToQuery(db.execute.mock.calls[0][0]);

    expect(statement).toMatch(/\bapi_key\b/);
  });

  /**
   * A reset that named seven tables left the rest: Memory keys of the apps it removed, Hub Pool pairings
   * and the key the peers pinned, the old organization's entitlements and the old Hub's job history.
   * A table added later is emptied too, or this fails until someone says why it should stay.
   */
  it('MUST empty every table in the database', async () => {
    await service.wipeDatabase();

    const { sql: statement } = new PgDialect().sqlToQuery(db.execute.mock.calls[0][0]);
    const emptied = /^TRUNCATE TABLE (.+) RESTART IDENTITY CASCADE$/
      .exec(statement)?.[1]
      .split(', ')
      .map((name) => name.replaceAll('"', ''));
    const tables = Object.values(schema)
      .filter((value): value is PgTable => is(value, PgTable))
      .map((table) => getTableName(table));

    expect(tables).toEqual(expect.arrayContaining(['memory_connection', 'hub_pool_peer', 'hub_pool_identity', 'lifecycle_job']));
    expect([...(emptied ?? [])].sort()).toEqual([...tables].sort());
  });

  // They cache rows of the tables the TRUNCATE empties. `RESTART IDENTITY` hands an old account's id
  // to the next one: a cached public id was signed for that new person until a restart.
  it('MUST forget the stable ids forward auth signs and the Hub Pool identity and PIN, even when the TRUNCATE rejects', async () => {
    const resolver = { forget: vi.fn() };
    const poolIdentity = { forget: vi.fn() };
    const pairingPins = { cancel: vi.fn() };
    const others = new Map<unknown, unknown>([
      [BearerOrgMembershipCache, bearerOrgMembership],
      [ForwardAuthIdentityResolver, resolver],
      [HubPoolIdentityService, poolIdentity],
      [HubPoolPairingPinService, pairingPins],
    ]);
    moduleRefMock.get.mockImplementation(((token: unknown) => others.get(token)) as never);
    db.execute.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(service.wipeDatabase()).rejects.toThrow('ECONNRESET');

    expect(resolver.forget).toHaveBeenCalled();
    expect(poolIdentity.forget).toHaveBeenCalled();
    expect(pairingPins.cancel).toHaveBeenCalled();
  });

  it('MUST drop cached session users even when the TRUNCATE rejects on the way back', async () => {
    sessionUserCache.set(1, { id: 1, username: 'previous-operator' } as never);
    db.execute.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(service.wipeDatabase()).rejects.toThrow('ECONNRESET');

    expect(sessionUserCache.get(1)).toBeUndefined();
    expect(cache.clear).toHaveBeenCalled();
  });

  it('removes registration.json with the tunnel token, so the desktop app and CLI cannot restart the tunnel', async () => {
    // The registration service mock does no file work here, so this checks the factory reset's own cleanup.
    vol.mkdirSync(TUNNEL_DIR, { recursive: true });
    vol.writeFileSync(path.join(TUNNEL_DIR, 'token'), 'tunnel-token');
    vol.writeFileSync(path.join(TUNNEL_DIR, 'registration.json'), JSON.stringify({ tunnelId: 'tunnel-1', writtenAt: '2026-09-01T00:00:00.000Z' }));

    await service.execute();

    expect(vol.existsSync(path.join(TUNNEL_DIR, 'token'))).toBe(false);
    expect(vol.existsSync(path.join(TUNNEL_DIR, 'registration.json'))).toBe(false);
  });

  it('removes the copies of settings.json a boot or a crash left beside it, which hold the credentials it clears', async () => {
    // The suite pins the data folder to /data (vitest.config.ts), as the configuration mock above does.
    const stateDir = path.join('/data', 'state');
    const credentials = JSON.stringify({ ciHubApiKey: 'portal-device-key', inferenceCloudProviders: [{ provider: 'openai', apiKey: 'sk-test' }] });
    vol.writeFileSync(path.join(stateDir, 'settings.json'), credentials);
    // Kept by a boot that found the file torn, and left by a crash between a write and its rename.
    vol.writeFileSync(path.join(stateDir, 'settings.json.corrupt-2026-10-10T11-25-42-646Z'), `${credentials}"tail"}`);
    vol.writeFileSync(path.join(stateDir, 'settings.json.1-3.tmp'), credentials);

    await service.execute();

    expect(vol.readFileSync(path.join(stateDir, 'settings.json'), 'utf8')).toBe('{}');
    expect(vol.readdirSync(stateDir).filter((name) => String(name).startsWith('settings.json'))).toEqual(['settings.json']);
    expect(vol.existsSync(path.join(stateDir, 'seed'))).toBe(true);
  });

  it('finishes the reset when a copy of settings.json cannot be removed', async () => {
    const stateDir = path.join('/data', 'state');
    // A folder where a copy would be, which rm without `recursive` refuses.
    vol.mkdirSync(path.join(stateDir, 'settings.json.corrupt-2026-10-10T11-25-42-646Z', 'inside'), { recursive: true });
    vol.writeFileSync(path.join(stateDir, 'settings.json.1-3.tmp'), '{"ciHubApiKey":"portal-device-key"}');
    bearerOrgMembership.set('portal-subject', true);

    await expect(service.execute()).resolves.toMatchObject({ success: true });

    // The steps after the settings reset still ran, and the other copy went.
    expect(cache.clear).toHaveBeenCalled();
    expect(bearerOrgMembership.get('portal-subject')).toBeUndefined();
    expect(vol.existsSync(path.join(stateDir, 'settings.json.1-3.tmp'))).toBe(false);
  });

  it('tears down installed apps before wiping data mounts', async () => {
    db.query.app.findMany.mockResolvedValue([
      {
        appName: 'demo',
        appStoreSlug: 'ci-store',
      } as any,
    ]);

    await service.execute();

    expect(db.query.app.findMany).toHaveBeenCalled();
    expect(uninstallExecute).toHaveBeenCalled();
    expect(uninstallExecute.mock.invocationCallOrder[0]).toBeLessThan(filesystem.createDirectory.mock.invocationCallOrder[0] ?? 0);
  });
});

describe('FactoryResetService: data folders', () => {
  // Each data folder is a bind mount in the Hub container, and removing a mount point fails with EBUSY
  // before anything inside it is touched. That is how a reset said it had deleted everything and left
  // every app backup on disk.
  const dataFolders = [APP_DATA_DIR, ...['apps', 'repos', 'backups', 'user-config'].map((name) => path.join('/data', name))];
  const mediaFolder = path.join('/data', 'media');
  const mountPoints = new Set([...dataFolders, mediaFolder].map((folder) => path.resolve(folder)));

  /**
   * `/proc/self/mountinfo` for this container on Docker Engine in WSL2, as read there: each folder is
   * mounted from the folder of the same name under `%APPDATA%/companion-hub`, through drvfs. `sources`
   * replaces the folder a mount point comes from.
   */
  const writeMountInfo = (sources: Record<string, string> = {}) => {
    const hub = '/Users/ci/AppData/Roaming/companion-hub';
    const mounts = {
      '/app-data': `${hub}/app-data`,
      ...Object.fromEntries(['apps', 'repos', 'media', 'backups', 'user-config'].map((name) => [`/data/${name}`, `${hub}/${name}`])),
      ...sources,
    };
    vol.mkdirSync('/proc/self', { recursive: true });
    vol.writeFileSync(
      '/proc/self/mountinfo',
      [
        '836 506 0:104 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC',
        ...Object.entries(mounts).map(
          ([mountPoint, root], index) =>
            `${861 + index} 836 0:69 ${root} ${mountPoint} rw,noatime - 9p C:\\134 rw,aname=drvfs;path=C:\\;symlinkroot=/mnt/`,
        ),
      ].join('\n'),
    );
  };

  let service: FactoryResetService;
  let db: {
    execute: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    query: { app: { findMany: ReturnType<typeof vi.fn> } };
  };
  /** The `where` of each row delete, rendered as SQL with its parameters. */
  let deletedRows: Array<{ table: unknown; sql: string; params: unknown[] }>;
  /** Paths the Hub may not delete, such as a file an app wrote as root. */
  let undeletable: Set<string>;

  beforeEach(() => {
    undeletable = new Set();
    const rm = fs.promises.rm;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      const resolved = path.resolve(String(target));
      if (mountPoints.has(resolved)) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${target}'`), { code: 'EBUSY' });
      }
      if (undeletable.has(resolved)) {
        throw Object.assign(new Error(`EACCES: permission denied, rmdir '${target}'`), { code: 'EACCES' });
      }
      return rm(target, options);
    });

    deletedRows = [];
    db = {
      execute: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn((table: unknown) => ({
        where: vi.fn(async (condition: SQLWrapper) => {
          const { sql, params } = new PgDialect().sqlToQuery(condition.getSQL());
          deletedRows.push({ table, sql, params });
        }),
      })),
      query: { app: { findMany: vi.fn().mockResolvedValue([]) } },
    };
    const registrationService = mock<RegistrationService>();
    registrationService.resetRegistration.mockResolvedValue(undefined);
    const logger = mock<LoggerService>();

    service = new FactoryResetService(
      db as never,
      {} as never,
      mock<ModuleRef>(),
      new FilesystemService(logger),
      { get: vi.fn(configurationValue) } as never,
      mock<CacheService>(),
      new SessionUserCache(),
      logger,
      registrationService,
    );

    for (const file of [
      path.join(APP_DATA_DIR, 'ci-marketplace', 'uptime-kuma', 'data', 'kuma.db'),
      path.join('/data', 'apps', 'ci-marketplace', 'wordpress', 'docker-compose.yml'),
      path.join('/data', 'repos', 'ci-marketplace', 'catalog-index.json'),
      path.join('/data', 'media', 'data', 'movies', 'home-video.mkv'),
      path.join('/data', 'backups', 'ci-marketplace', 'wordpress', 'wordpress:ci-marketplace-1791551417985.tar.gz'),
      path.join('/data', 'user-config', 'ci-marketplace', 'wordpress', 'app.env'),
    ]) {
      vol.mkdirSync(path.dirname(file), { recursive: true });
      vol.writeFileSync(file, 'x');
    }
    // Part of the media library skeleton the Hub creates at boot.
    vol.mkdirSync(path.join(mediaFolder, 'downloads', 'complete'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('empties every data folder, user-config included, and keeps the folder itself', async () => {
    await service.wipeDataMounts();

    for (const folder of dataFolders) {
      expect(vol.readdirSync(folder)).toEqual([]);
    }
  });

  it('leaves the media library alone, its files and the folders the Hub made for it', async () => {
    await service.wipeDataMounts();

    expect(vol.readFileSync(path.join(mediaFolder, 'data', 'movies', 'home-video.mkv'), 'utf8')).toBe('x');
    expect(vol.existsSync(path.join(mediaFolder, 'downloads', 'complete'))).toBe(true);
  });

  it('empties every folder of a normal install on Docker Engine in WSL2, read from mountinfo', async () => {
    writeMountInfo();

    await service.wipeDataMounts();

    for (const folder of dataFolders) {
      expect(vol.readdirSync(folder)).toEqual([]);
    }
  });

  it('leaves a data folder that is a link to a folder with another name alone, and stops before the database', async () => {
    // `backups` is a junction to an archive folder elsewhere: Docker mounted the archive.
    writeMountInfo({ '/data/backups': '/Users/ci/Documents/Hub\\040Archive' });

    const failure = await service.execute().catch((error: unknown) => error);

    expect((failure as TranslatableError).getResponse()).toEqual({
      message: 'SETTINGS_FACTORY_RESET_FILES_LEFT',
      intlParams: { count: '1', paths: 'backups/' },
    });
    expect(vol.readdirSync(path.join('/data', 'backups', 'ci-marketplace', 'wordpress'))).toEqual(['wordpress:ci-marketplace-1791551417985.tar.gz']);
    expect(vol.readdirSync(path.join('/data', 'repos'))).toEqual([]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('stops before it wipes the database when a data folder could not be emptied, and says what is left', async () => {
    undeletable.add(path.resolve('/data', 'backups', 'ci-marketplace'));

    const failure = await service.execute().catch((error: unknown) => error);

    // The page shows this error, so it names what is left as it sits in the Hub's data folder.
    expect(failure).toBeInstanceOf(TranslatableError);
    expect((failure as TranslatableError).getResponse()).toEqual({
      message: 'SETTINGS_FACTORY_RESET_FILES_LEFT',
      intlParams: { count: '1', paths: 'backups/ci-marketplace' },
    });
    expect(db.execute).not.toHaveBeenCalled();
    // The other folders are still emptied, so a second run has only the leftover to deal with.
    expect(vol.readdirSync(path.join('/data', 'repos'))).toEqual([]);
  });

  it('drops the row of each app it tore down, so a reset that stops on leftovers does not list apps that are gone', async () => {
    // The uninstall removed the containers and files of the first app. The second one's teardown failed,
    // so it may still be there and keeps its row, as an ordinary uninstall that fails would.
    db.query.app.findMany.mockResolvedValue([
      { id: 7, appName: 'wordpress', appStoreSlug: 'ci-marketplace' },
      { id: 9, appName: 'stuck', appStoreSlug: 'ci-marketplace' },
    ]);
    uninstallExecute
      .mockResolvedValueOnce({ success: true, message: 'ok' })
      .mockResolvedValueOnce({ success: false, message: 'compose down failed' });
    undeletable.add(path.resolve('/data', 'backups', 'ci-marketplace'));

    await expect(service.execute()).rejects.toBeInstanceOf(TranslatableError);

    expect(deletedRows).toEqual([{ table: app, sql: '"app"."id" = $1', params: [7] }]);
    expect(db.execute).not.toHaveBeenCalled();
  });
});

/**
 * A reset on the suite's memfs disk, with a real `FilesystemService` and a real `ConfigurationService`
 * (built without its constructor, which wants the whole appliance env). `moduleRef` hands out the
 * services the reset reaches that way.
 */
function resetOnDisk(
  options: { rootFolderHost?: string; userSettings?: Record<string, unknown>; pairing?: Record<string, string>; moduleRef?: ModuleRef } = {},
) {
  const logger = mock<LoggerService>();
  const configuration = Object.assign(Object.create(ConfigurationService.prototype) as ConfigurationService, {
    logger,
    config: {
      demoMode: false,
      rootFolderHost: options.rootFolderHost ?? '/opt/ci-hub',
      directories: { dataDir: '/data' },
      userSettings: { ...options.userSettings },
      ...options.pairing,
    },
  });
  const db = {
    execute: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    query: { app: { findMany: vi.fn().mockResolvedValue([]) } },
  };
  const registrationService = mock<RegistrationService>();
  registrationService.resetRegistration.mockResolvedValue(undefined);
  const service = new FactoryResetService(
    db as never,
    {} as never,
    options.moduleRef ?? mock<ModuleRef>(),
    new FilesystemService(logger),
    configuration,
    mock<CacheService>(),
    new SessionUserCache(),
    logger,
    registrationService,
  );

  return { service, configuration, db, registrationService };
}

const SETTINGS_PATH = path.join('/data', 'state', 'settings.json');

const onDisk = () => JSON.parse(String(vol.readFileSync(SETTINGS_PATH, 'utf8')));

describe('FactoryResetService: settings the Hub holds in memory', () => {
  const OPENAI: CloudProviderConfig = { provider: 'openai', apiKey: 'sk-before-the-reset', enabled: true, defaultModel: 'gpt-4o' };
  const GOOGLE: CloudProviderConfig = { provider: 'google', apiKey: 'key-after-the-reset', enabled: true, defaultModel: 'gemini-2.5-pro' };

  let cloudFallback: CloudFallbackService;
  let configuration: ConfigurationService;
  let service: FactoryResetService;

  const setUp = (userSettings: Record<string, unknown> = {}) => {
    const moduleRef = mock<ModuleRef>();
    moduleRef.get.mockImplementation((token: unknown) => (token === CloudFallbackService ? cloudFallback : undefined) as never);
    ({ service, configuration } = resetOnDisk({ moduleRef, userSettings }));
    cloudFallback = new CloudFallbackService(mock<LoggerService>(), configuration);
    cloudFallback.onModuleInit();
  };

  beforeEach(() => {
    vol.writeFileSync(SETTINGS_PATH, '{}');
  });

  it('forgets the cloud provider keys, so the next provider saved is the only one in settings.json', async () => {
    setUp();
    await cloudFallback.setProvider(OPENAI);
    expect(onDisk().inferenceCloudProviders).toEqual([expect.objectContaining({ provider: 'openai' })]);

    await service.execute();
    await cloudFallback.setProvider(GOOGLE);

    expect(onDisk()).toEqual({
      inferenceCloudProviders: [{ ...GOOGLE, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' }],
    });
  });

  it('hands apps no cloud key, and lists no provider, once the reset is done', async () => {
    setUp();
    await cloudFallback.setProvider(OPENAI);

    await service.execute();

    expect(cloudFallback.toAppEnv()).toEqual({});
    expect(cloudFallback.listProviders()).toEqual([]);
    expect(configuration.getInferenceCloudProviders()).toEqual([]);
  });

  it('puts the settings it read from settings.json back to their defaults, and keeps the ones from the environment', async () => {
    // As boot leaves them on a Hub that was then paired, and set up in Settings, in this process.
    setUp({
      timeZone: 'Europe/Berlin',
      maxBackups: 7,
      inferenceBackend: 'vllm',
      inferenceVllmApiKey: 'vllm-key-before-the-reset',
      defaultAppCpuLimit: '2',
      autoAllocateAppResources: false,
      hubPoolMdnsEnabled: true,
      hubPoolPins: [{ scope: 'all', targetKind: 'local' }],
      // The pairing callback saves these through setUserSettings, which merges them in here too.
      ciHubApiKey: 'portal-device-key',
      ciHubMoveKey: 'portal-move-key',
      ciHubOrganizationId: 'org-1',
    });

    await service.execute();

    expect(JSON.parse(JSON.stringify(configuration.get('userSettings')))).toEqual({
      timeZone: 'Europe/Berlin',
      maxBackups: 7,
      autoAllocateAppResources: true,
    });
    expect(configuration.getInferencePreferences()).toMatchObject({ preferredBackend: null, preferredVllmApiKey: null });
    expect(configuration.getHubPoolPreferences()).toMatchObject({ poolMdnsEnabled: false, poolPins: [] });
  });

  /**
   * Boot lifts these out of settings.json into the config itself. Only their copies in the user
   * settings went. Until a restart the reset Hub asked Portal about its old device with the key (the
   * pairing page offered Move this device). Its next pairing sent both keys as proof.
   */
  it('forgets the Portal device key, the move key and the organization id the config holds', async () => {
    const pairing = { ciHubApiKey: 'portal-device-key', ciHubMoveKey: 'portal-move-key', ciHubOrganizationId: 'org-1' };
    ({ service, configuration } = resetOnDisk({ pairing, userSettings: pairing }));

    await service.execute();

    expect(configuration.get('ciHubApiKey')).toBeNull();
    expect(configuration.get('ciHubMoveKey')).toBeNull();
    expect(configuration.get('ciHubOrganizationId')).toBeNull();
    expect(configuration.get('userSettings')).not.toHaveProperty('ciHubApiKey');
  });
});

describe('FactoryResetService: what the inference module keeps in state/', () => {
  const handout: RecordedHandout = {
    servedAt: '2026-10-20T10:00:00.000Z',
    routedThroughPool: false,
    chatModelId: 'gemma4-e4b',
    chatModelError: null,
    endpointUrl: 'http://host.docker.internal:11434/v1',
    managedKeys: ['CI_LLM_MODEL'],
    envDigests: { CI_LLM_MODEL: 'digest' },
  };

  const resetWith = (providers: Map<unknown, unknown>) => {
    const moduleRef = mock<ModuleRef>();
    moduleRef.get.mockImplementation(((token: unknown) => providers.get(token)) as never);
    return resetOnDisk({ moduleRef }).service;
  };

  // The new Hub read them back at its next boot: "[ModelRegistry] Restored 3 pinned model(s)".
  it('unpins the models and removes the pins file, so the next boot pins nothing', async () => {
    await writePinnedModels({ pinned: ['gemma4-e4b', 'gemma3-1b', 'nomic-embed-text'] });
    const registry = new ModelRegistryService(mock<LoggerService>());
    await registry.onModuleInit();
    registry.trackModel('gemma4-e4b', 'loaded');
    expect(registry.getTrackedModel('gemma4-e4b')).toMatchObject({ state: 'pinned' });

    await resetWith(new Map([[ModelRegistryService, registry]])).execute();

    expect(registry.getPinnedCatalogIds()).toEqual([]);
    expect(registry.getTrackedModel('gemma4-e4b')).toMatchObject({ state: 'loaded', pinned: false });
    expect(vol.existsSync(PINNED_MODELS_PATH)).toBe(false);
    const nextBoot = new ModelRegistryService(mock<LoggerService>());
    await nextBoot.onModuleInit();
    expect(nextBoot.getPinnedCatalogIds()).toEqual([]);
  });

  it('forgets what each app was handed, which describes apps the reset removed', async () => {
    vol.writeFileSync(HANDOUT_RECORDS_PATH, JSON.stringify({ openclaw: handout }));
    const credentials = new AppCredentialsService(mock<LoggerService>(), mock(), mock(), mock(), mock(), mock(), mock(), mock());
    await expect(credentials.lastHandout('openclaw')).resolves.toEqual(handout);

    await resetWith(new Map([[AppCredentialsService, credentials]])).execute();

    await expect(credentials.lastHandout('openclaw')).resolves.toBeNull();
    expect(vol.existsSync(HANDOUT_RECORDS_PATH)).toBe(false);
  });

  it('keeps the footprint sightings, which describe this hardware, not the Hub', async () => {
    const sightings = path.join('/data', 'state', 'inference-footprint-sightings.json');
    vol.writeFileSync(sightings, '{"hardware":"cuda:0:8","sightings":[]}');

    await resetWith(new Map()).execute();

    expect(vol.readFileSync(sightings, 'utf8')).toBe('{"hardware":"cuda:0:8","sightings":[]}');
  });

  it('stops before the pins when a data folder could not be emptied, as it does before users and pairing', async () => {
    await writePinnedModels({ pinned: ['gemma4-e4b'] });
    const registry = new ModelRegistryService(mock<LoggerService>());
    await registry.onModuleInit();
    const service = resetWith(new Map([[ModelRegistryService, registry]]));
    vi.spyOn(service, 'wipeDataMounts').mockRejectedValueOnce(
      new TranslatableError('SETTINGS_FACTORY_RESET_FILES_LEFT', { count: '1', paths: 'backups/' }),
    );

    await expect(service.execute()).rejects.toBeInstanceOf(TranslatableError);

    expect(registry.getPinnedCatalogIds()).toEqual(['gemma4-e4b']);
    expect(vol.existsSync(PINNED_MODELS_PATH)).toBe(true);
  });
});

describe('FactoryResetService: a data folder that is a home folder', () => {
  const folders = ['app-data', 'apps', 'repos', 'backups', 'user-config'];
  const ownFile = path.join('/data', 'repos', 'notes', 'todo.txt');

  /** The filesystem columns of a mountinfo line, for the engines and disks the tests below use. */
  const DRIVE_C = '9p C:\\134 rw,aname=drvfs;path=C:\\';
  const DRIVE_D = '9p D:\\134 rw,aname=drvfs;path=D:\\';
  const LINUX_ROOT = 'ext4 /dev/nvme0n1p2 rw';
  const LINUX_DATA_DISK = 'ext4 /dev/sdb1 rw';
  const MAC_VIRTIOFS = 'fakeowner /run/host_mark/Users rw,fakeowner';

  /**
   * `/proc/self/mountinfo` with each data folder mounted from `<root>/<name>`, as compose mounts them,
   * from the filesystem `fs` (drive C through drvfs unless given). `sources` replaces the folder a data
   * folder comes from, as a link would.
   */
  const mountEachFrom = (root: string, { sources = {}, fs = DRIVE_C }: { sources?: Record<string, string>; fs?: string } = {}) => {
    vol.mkdirSync('/proc/self', { recursive: true });
    vol.writeFileSync(
      '/proc/self/mountinfo',
      [
        '836 506 0:104 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC',
        ...folders.map((name, index) => {
          const mountPoint = name === 'app-data' ? '/app-data' : `/data/${name}`;
          return `${861 + index} 836 0:69 ${sources[name] ?? `${root}/${name}`} ${mountPoint} rw,noatime - ${fs}`;
        }),
      ].join('\n'),
    );
  };

  beforeEach(() => {
    uninstallExecute.mockClear();
    vol.mkdirSync(path.dirname(ownFile), { recursive: true });
    vol.writeFileSync(ownFile, 'x');
    vol.writeFileSync(SETTINGS_PATH, '{"ciHubApiKey":"portal-device-key"}');
  });

  it.each([
    '/',
    '/root',
    '/home/ci',
    '/home/ci/',
    '/var/home/ci',
    '/Users/ci',
    'C:\\Users\\ci',
    'c:/users/ci',
    '/mnt/c/Users/ci',
    '/c/Users/ci',
    'C:\\',
    '/mnt/c',
    '/c',
  ])('refuses ROOT_FOLDER_HOST=%s before it touches an app, a file, the registration or the database', async (rootFolderHost) => {
    const { service, db, registrationService } = resetOnDisk({ rootFolderHost });
    db.query.app.findMany.mockResolvedValue([{ id: 7, appName: 'wordpress', appStoreSlug: 'ci-marketplace' }]);

    const failure = await service.execute().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TranslatableError);
    expect((failure as TranslatableError).getResponse()).toEqual({
      message: 'SETTINGS_FACTORY_RESET_DATA_ROOT_REFUSED',
      intlParams: { root: rootFolderHost },
    });
    expect(uninstallExecute).not.toHaveBeenCalled();
    expect(vol.readFileSync(ownFile, 'utf8')).toBe('x');
    expect(registrationService.resetRegistration).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
    expect(onDisk()).toEqual({ ciHubApiKey: 'portal-device-key' });
  });

  it.each([
    ['a junction to a Windows home folder', '/Users/ci', DRIVE_C, '/mnt/c/hub', 'C:\\Users\\ci'],
    ['a symlink to a Linux home folder', '/home/ci', LINUX_ROOT, '/srv/hub', '/home/ci'],
    ['a symlink to a macOS home folder, through VirtioFS', '/ci', MAC_VIRTIOFS, '/opt/hub', '/Users/ci'],
  ])('refuses when ROOT_FOLDER_HOST is %s, and names it as the host does', async (_shape, root, fs, rootFolderHost, named) => {
    mountEachFrom(root, { fs });
    const { service, db } = resetOnDisk({ rootFolderHost });

    const failure = await service.execute().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TranslatableError);
    expect((failure as TranslatableError).getResponse()).toEqual({
      message: 'SETTINGS_FACTORY_RESET_DATA_ROOT_REFUSED',
      intlParams: { root: named },
    });
    expect(uninstallExecute).not.toHaveBeenCalled();
    expect(vol.readFileSync(ownFile, 'utf8')).toBe('x');
    expect(db.execute).not.toHaveBeenCalled();
  });

  it.each([
    'C:\\Users\\ci\\AppData\\Roaming\\companion-hub',
    '/mnt/c/Users/ci/AppData/Roaming/companion-hub',
    '/c/Users/ci/AppData/Roaming/companion-hub',
    '/home/ci/.local/share/companion-hub',
    '/Users/ci/Library/Application Support/companion-hub',
    '/home/ci/CI-Hub/.internal',
    '/opt/ci-hub',
    '/srv/hub',
    'D:\\',
    '/mnt/d',
  ])('runs with ROOT_FOLDER_HOST=%s', async (rootFolderHost) => {
    const { service } = resetOnDisk({ rootFolderHost });

    await expect(service.execute()).resolves.toMatchObject({ success: true });

    expect(vol.readdirSync(path.join('/data', 'repos'))).toEqual([]);
  });

  it.each([
    [
      'a Windows install, each folder mounted from %APPDATA%\\companion-hub',
      '/Users/ci/AppData/Roaming/companion-hub',
      DRIVE_C,
      '/mnt/c/Users/ci/AppData/Roaming/companion-hub',
    ],
    // A mount on a Windows drive names no letter, so D:\home\hub reads /home/hub.
    ['D:\\home\\hub', '/home/hub', DRIVE_D, '/mnt/d/home/hub'],
    ['a junction to D:\\home\\hub', '/home/hub', DRIVE_D, '/mnt/c/hub'],
    // A disk mounted at /data: its mounts read /home/hub, without the /data.
    ['/data/home/hub on a disk of its own', '/home/hub', LINUX_DATA_DISK, '/data/home/hub'],
    ['Linux, the data folder on the root filesystem', '/home/ci/.local/share/companion-hub', LINUX_ROOT, '/home/ci/.local/share/companion-hub'],
  ])('runs on %s', async (_shape, root, fs, rootFolderHost) => {
    mountEachFrom(root, { fs });
    const { service } = resetOnDisk({ rootFolderHost });

    await expect(service.execute()).resolves.toMatchObject({ success: true });

    expect(vol.readdirSync(path.join('/data', 'repos'))).toEqual([]);
  });

  it.each([
    [
      'a Windows install',
      '/Users/ci/AppData/Roaming/companion-hub',
      DRIVE_C,
      '/mnt/c/Users/ci/AppData/Roaming/companion-hub',
      { backups: '/Users/ci', repos: '/Users/ci/repos' },
    ],
    ['a Linux install', '/srv/hub', LINUX_ROOT, '/srv/hub', { backups: '/home/ci', repos: '/home/ci/repos' }],
  ])(
    'on %s, leaves a folder linked to a home folder alone, or to a folder of the same name in one, and names both',
    async (_shape, root, fs, rootFolderHost, sources) => {
      // `backups` is a link to the user's home folder itself, `repos` one to the `repos` folder in it.
      // Neither says ROOT_FOLDER_HOST is a home folder, so the reset is not refused, but emptying
      // either would delete the user's own files.
      mountEachFrom(root, { fs, sources });
      const { service, db } = resetOnDisk({ rootFolderHost });

      const failure = await service.execute().catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(TranslatableError);
      expect((failure as TranslatableError).getResponse()).toEqual({
        message: 'SETTINGS_FACTORY_RESET_FILES_LEFT',
        intlParams: { count: '2', paths: 'repos/, backups/' },
      });
      expect(vol.readFileSync(ownFile, 'utf8')).toBe('x');
      expect(vol.readdirSync(path.join('/data', 'apps'))).toEqual([]);
      expect(db.execute).not.toHaveBeenCalled();
    },
  );

  it('still empties a folder linked to one of the same name outside a home folder', async () => {
    // It can't be told apart from a Hub folder kept elsewhere, so it is emptied, as before.
    mountEachFrom('/Users/ci/AppData/Roaming/companion-hub', { sources: { repos: '/Users/ci/Documents/repos' } });
    const { service } = resetOnDisk({ rootFolderHost: '/mnt/c/Users/ci/AppData/Roaming/companion-hub' });

    await expect(service.execute()).resolves.toMatchObject({ success: true });

    expect(vol.readdirSync(path.join('/data', 'repos'))).toEqual([]);
  });
});
