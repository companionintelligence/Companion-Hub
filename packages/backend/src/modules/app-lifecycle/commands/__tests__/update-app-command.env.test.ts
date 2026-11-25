import fs from 'node:fs';
import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DockerService } from '@/modules/docker/docker.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import type { AppInfo } from '@ci-hub/common/schemas';
import type { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { fromPartial } from '@total-typescript/shoehorn';
import type Dockerode from 'dockerode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import { UpdateAppCommand } from '../update-app-command';

vi.mock('@ci-hub/common/schemas', async (importOriginal) => ({
  ...((await importOriginal()) as any),
  parseComposeJson: vi.fn().mockReturnValue({ services: [], overrides: [] }),
}));

/*
 * The env an update's new version first boots with, through the real AppHelpers.generateEnvFile
 * and the real AppFilesManager on the in-memory filesystem: the installed config.json and app.env
 * are files here, so the test sees exactly what compose would read at the update's `up`.
 */
describe('UpdateAppCommand: the env the new version boots with', () => {
  const appUrn = createAppUrn('ledger', 'test-store');
  const appDataDir = '/app-data/test-store/ledger';
  const installedDir = '/data/apps/test-store/ledger';
  const appEnvPath = path.join(appDataDir, 'app.env');
  const form = {};
  const startCommand = 'up --detach --force-recreate --remove-orphans';

  const manifest = (overrides: Partial<AppInfo>): AppInfo => ({
    id: 'ledger',
    urn: appUrn,
    name: 'Ledger',
    author: 'Test Author',
    port: 8080,
    https: false,
    no_gui: false,
    available: true,
    exposable: false,
    dynamic_config: true,
    source: 'http://example.com',
    version: '1.0.0',
    categories: ['utilities'],
    description: '',
    short_desc: 'Test app',
    website: 'http://example.com',
    supported_architectures: [],
    created_at: 0,
    updated_at: 0,
    deprecated: false,
    cihub_app_version: 1,
    force_expose: false,
    force_pull: false,
    generate_vapid_keys: false,
    form_fields: [],
    ...overrides,
  });

  const previousVersion = manifest({
    form_fields: [
      { env_variable: 'DB_PASSWORD', label: 'Database password', type: 'random', min: 32, required: false },
      { env_variable: 'ADMIN_USER', label: 'Admin user', type: 'text', default: 'admin', required: false },
    ],
  });

  // What easy-appointments, azuracast and countly did: the new version adds a database secret and
  // a defaulted setting that its containers read on their first boot.
  const nextVersion = manifest({
    version: '1.1.0',
    cihub_app_version: 2,
    form_fields: [
      ...previousVersion.form_fields,
      { env_variable: 'MARIADB_PASSWORD', label: 'MariaDB password', type: 'random', min: 32, required: false },
      { env_variable: 'SMTP_PORT', label: 'SMTP port', type: 'number', default: 587, required: false },
    ],
  });

  const envUtils = new EnvUtils();
  let logger: ReturnType<typeof mockDeep<LoggerService>>;
  let config: ReturnType<typeof mock<ConfigurationService>>;
  let filesystem: FilesystemService;
  let appFilesManager: AppFilesManager;
  let appHelpers: AppHelpers;
  let dockerService: ReturnType<typeof mock<DockerService>>;
  let marketplaceService: ReturnType<typeof mock<MarketplaceService>>;
  let moduleRef: ReturnType<typeof mock<ModuleRef>>;
  let envAtStart: Map<string, string>[];
  let incoming: AppInfo;

  const writeConfig = async (info: AppInfo) => {
    await fs.promises.mkdir(installedDir, { recursive: true });
    await fs.promises.writeFile(path.join(installedDir, 'config.json'), JSON.stringify(info));
  };
  const readEnvText = async () => fs.promises.readFile(appEnvPath, 'utf8');
  const readEnv = async () => envUtils.envStringToMap(await readEnvText());

  const updateCommand = (options: { wasRunning?: boolean } = {}) => {
    const command = new UpdateAppCommand(moduleRef, {} as Dockerode, false, options.wasRunning ?? true);
    (command as any).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
    (command as any).ensureAppDir = vi.fn().mockResolvedValue(undefined);
    return command;
  };

  beforeEach(async () => {
    logger = mockDeep<LoggerService>();
    config = mock<ConfigurationService>();
    config.getConfig.mockReturnValue(
      fromPartial({
        internalIp: '127.0.0.1',
        envFilePath: '/data/.env',
        rootFolderHost: '/opt/ci-hub',
        domain: 'example.com',
        localDomain: 'ci.localhost',
        directories: { dataDir: '/data', appDataDir: '/app-data', appDir: '/app' },
        userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com', localDomain: 'ci.localhost' },
      }),
    );

    filesystem = new FilesystemService(logger);
    appFilesManager = new AppFilesManager(config, filesystem, logger);

    const testingModule = await Test.createTestingModule({
      providers: [
        AppHelpers,
        { provide: AppFilesManager, useValue: appFilesManager },
        { provide: ConfigurationService, useValue: config },
        { provide: FilesystemService, useValue: filesystem },
        { provide: EnvUtils, useValue: envUtils },
        { provide: LoggerService, useValue: logger },
      ],
    })
      .useMocker(mock)
      .compile();
    appHelpers = testingModule.get(AppHelpers);

    dockerService = mock<DockerService>();
    marketplaceService = mock<MarketplaceService>();
    // The smallest manifest the compose schema accepts: schemaVersion 2 and one main service.
    marketplaceService.getDockerComposeJson.mockResolvedValue({
      content: { schemaVersion: 2, services: [{ name: 'main', image: 'example/ledger:2.0.0', isMain: true }] },
    } as any);
    incoming = nextVersion;
    // The real copy replaces the installed folder with the store's; here, with the next version's config.
    marketplaceService.copyAppFromRepoToInstalled.mockImplementation(async () => {
      await writeConfig(incoming);
    });

    // The snapshot is what a rollback restores from, so it is a real copy of both folders.
    dockerService.createPreUpdateVolumeSnapshot.mockImplementation(async (urn, options) => {
      const base = '/data/snapshots/test-store/ledger/snap-1';
      const includeData = options?.includeData ?? true;
      if (includeData) await filesystem.copyDirectory(appDataDir, `${base}/app-data`);
      await filesystem.copyDirectory(installedDir, `${base}/app-files`);
      return {
        appUrn: urn,
        snapshotId: 'snap-1',
        timestamp: new Date(0).toISOString(),
        snapshotBaseDir: base,
        snapshotPath: includeData ? `${base}/app-data` : undefined,
        appFilesSnapshotPath: `${base}/app-files`,
        volumes: [],
        success: true,
      };
    });
    dockerService.verifyContainerHealthProbe.mockResolvedValue({ ok: true, healthy: true, containers: [], message: 'healthy' });
    envAtStart = [];
    dockerService.composeApp.mockImplementation(async (_urn, command) => {
      if (command === startCommand) {
        envAtStart.push(await readEnv());
      }
      return undefined as any;
    });

    moduleRef = mock<ModuleRef>();
    moduleRef.get.mockImplementation((token: unknown) => {
      if (token === LoggerService) return logger;
      if (token === AppFilesManager) return appFilesManager;
      if (token === AppHelpers) return appHelpers;
      if (token === DockerService) return dockerService;
      if (token === MarketplaceService) return marketplaceService;
      if (token === FilesystemService) return filesystem;
      if (token === ConfigurationService) return config;
      if (token === BackupManager) return mock<BackupManager>();
      return undefined as any;
    });

    // The installed previous version, with the app.env its install wrote.
    await writeConfig(previousVersion);
    await fs.promises.mkdir(appDataDir, { recursive: true });
    await appHelpers.generateEnvFile(appUrn, form);
  });

  it("boots the new version with the values its config adds, and keeps the app's own", async () => {
    const before = await readEnv();
    expect(before.get('DB_PASSWORD')).toMatch(/^[0-9a-f]{32}$/);
    expect(before.has('MARIADB_PASSWORD')).toBe(false);

    const result = await updateCommand().execute(appUrn, form);

    expect(result).toMatchObject({ success: true });
    expect(envAtStart).toHaveLength(1);
    const firstBoot = envAtStart[0] as Map<string, string>;
    // A secret the database was created with is the same one.
    expect(firstBoot.get('DB_PASSWORD')).toBe(before.get('DB_PASSWORD'));
    // The secret this version adds is there on its first boot, not an empty string.
    expect(firstBoot.get('MARIADB_PASSWORD')).toMatch(/^[0-9a-f]{32}$/);
    expect(firstBoot.get('SMTP_PORT')).toBe('587');
    expect(firstBoot.get('ADMIN_USER')).toBe('admin');
    expect(firstBoot.get('APP_IMAGE_TAG')).toBe('1.1.0');
  });

  it('hands the start after the update the same secrets the first boot used', async () => {
    await updateCommand().execute(appUrn, form);
    // What AppLifecycleService.updateApp's startAppAndWait runs once the update has succeeded.
    await appHelpers.generateEnvFile(appUrn, form);

    const afterStart = await readEnv();
    expect(afterStart.get('MARIADB_PASSWORD')).toBe(envAtStart[0]?.get('MARIADB_PASSWORD'));
  });

  it('writes the new env for an app that was stopped, and leaves it stopped', async () => {
    const result = await updateCommand({ wasRunning: false }).execute(appUrn, form);

    expect(result).toMatchObject({ success: true });
    expect(envAtStart).toHaveLength(0);
    const env = await readEnv();
    expect(env.get('MARIADB_PASSWORD')).toMatch(/^[0-9a-f]{32}$/);
    expect(env.get('APP_IMAGE_TAG')).toBe('1.1.0');
  });

  describe('a field the new version requires and only the operator can fill', () => {
    beforeEach(() => {
      incoming = manifest({
        ...nextVersion,
        form_fields: [...nextVersion.form_fields, { env_variable: 'LICENSE_KEY', label: 'License key', type: 'text', required: true }],
      });
    });

    it('does not block the update, which still hands over everything it can derive', async () => {
      const result = await updateCommand().execute(appUrn, form);

      expect(result).toMatchObject({ success: true });
      const firstBoot = envAtStart[0] as Map<string, string>;
      expect(firstBoot.has('LICENSE_KEY')).toBe(false);
      expect(firstBoot.get('MARIADB_PASSWORD')).toMatch(/^[0-9a-f]{32}$/);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('License key'));
    });

    it('is still asked for by the start that follows the update', async () => {
      await updateCommand().execute(appUrn, form);

      // The settings form now shows the new version's fields, so this is where the operator fills it in.
      await expect(appHelpers.generateEnvFile(appUrn, form)).rejects.toThrow('Variable License key is required');
    });
  });

  describe('rollback', () => {
    it('puts the previous app.env back when the new version fails before it starts', async () => {
      const before = await readEnv();
      const command = updateCommand();
      // The second compose preparation is the new version's: its compose file cannot be built.
      (command as any).ensureAppDir = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('the new compose file is invalid'));

      const result = await command.execute(appUrn, form);

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(await readEnv()).toEqual(before);
      expect(JSON.parse(await fs.promises.readFile(path.join(installedDir, 'config.json'), 'utf8')).version).toBe('1.0.0');
      // The previous version is started with that env.
      expect(envAtStart.at(-1)?.has('MARIADB_PASSWORD')).toBe(false);
    });

    it('puts the previous app.env back with the data when the new version fails its health probe', async () => {
      const before = await readEnvText();
      dockerService.verifyContainerHealthProbe.mockResolvedValue({ ok: false, healthy: false, containers: [], message: 'db exited with code 1' });

      const result = await updateCommand().execute(appUrn, form);

      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(envAtStart).toHaveLength(2);
      expect(envAtStart[0]?.has('MARIADB_PASSWORD')).toBe(true);
      expect(await readEnvText()).toBe(before);
      expect(envAtStart[1]?.has('MARIADB_PASSWORD')).toBe(false);
    });

    it("goes back to the previous config's env when there was no app.env before the update", async () => {
      await fs.promises.rm(appEnvPath);
      const command = updateCommand({ wasRunning: false });
      (command as any).ensureAppDir = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('the new compose file is invalid'));

      const result = await command.execute(appUrn, form);

      expect(result).toMatchObject({ success: false, rolledBack: true });
      const env = await readEnv();
      expect(env.get('APP_IMAGE_TAG')).toBe('1.0.0');
      expect(env.has('MARIADB_PASSWORD')).toBe(false);
      expect(env.has('SMTP_PORT')).toBe(false);
    });
  });
});
