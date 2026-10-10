import fs from 'node:fs';
import path from 'node:path';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUrn } from '@ci-hub/common/types';
import { ArchiveService } from '@/core/archive/archive.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { AppVolumeArchiveService } from '@/modules/docker/app-volume-archive.service';
import { BackupManager } from '../backup.manager';

describe('BackupManager.enforceRetentionAllApps', () => {
  let manager: BackupManager;
  let filesystem: MockProxy<FilesystemService>;

  // Backups are laid out `backups/<appStoreId>/<appName>`, but an app URN is the inverse
  // order — `<appName>:<appStoreId>` (see extractAppUrn). Composing the URN in directory
  // order silently inverted the halves, so every lookup resolved to a path that never
  // exists and this sweep pruned nothing at all.
  const dataDir = '/data';
  const store = 'ci-marketplace';
  const app = 'plane';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const config = mock<ConfigurationService>();
    config.get.mockImplementation((key: string) => {
      if (key === 'directories') return { dataDir } as never;
      if (key === 'userSettings') return { maxBackups: 2 } as never;
      return undefined as never;
    });

    filesystem = mock<FilesystemService>();
    // The sweep walks backups/ -> <store>/ -> <app>/
    filesystem.listFiles.mockImplementation(async (dir: string) => {
      if (dir === `${dataDir}/backups`) return [store];
      if (dir === `${dataDir}/backups/${store}`) return [app];
      // Archives, only under the CORRECT store/app path.
      if (dir === `${dataDir}/backups/${store}/${app}`) {
        return ['plane-1000.tar.gz', 'plane-2000.tar.gz', 'plane-3000.tar.gz', 'plane-4000.tar.gz'];
      }
      return [];
    });
    filesystem.getStats.mockImplementation(
      async (p: string) =>
        ({
          isDirectory: () => !p.endsWith('.tar.gz'),
          size: 10,
          mtime: new Date(Number(p.match(/-(\d+)\.tar\.gz$/)?.[1] ?? 0)),
        }) as never,
    );
    // Only the correctly-ordered path exists; an inverted URN must resolve to a miss.
    filesystem.pathExists.mockImplementation(async (p: string) => p.startsWith(`${dataDir}/backups/${store}/${app}`));
    filesystem.getSafeFilePath.mockImplementation((p: string) => p);
    filesystem.removeFile.mockResolvedValue(undefined as never);

    manager = new BackupManager(
      mock<ArchiveService>(),
      mock<LoggerService>(),
      config,
      filesystem,
      mock<AppFilesManager>(),
      mock<AppVolumeArchiveService>(),
    );
    manager.onApplicationShutdown(); // stop the constructor's weekly interval
  });

  it('derives the app URN in URN order, not directory order, so the sweep actually finds the backups', async () => {
    const listSpy = vi.spyOn(manager, 'listBackupsByAppId');

    await manager.enforceRetentionAllApps();

    // Directory order would yield `ci-marketplace:plane`, which resolves to
    // backups/plane/ci-marketplace — a path that never exists — making the sweep a no-op.
    expect(listSpy).toHaveBeenCalledWith(`${app}:${store}`);
    await expect(listSpy.mock.results[0]?.value).resolves.toHaveLength(4);
  });

  it('prunes only the archives beyond maxBackups, keeping the newest', async () => {
    await manager.enforceRetentionAllApps();

    // maxBackups = 2, so the two OLDEST of the four are removed.
    const removed = filesystem.removeFile.mock.calls.map(([p]) => String(p).split('/').pop()).sort();
    expect(removed).toEqual(['plane-1000.tar.gz', 'plane-2000.tar.gz']);
  });
});

describe('BackupManager.getAppBackupsHostDir', () => {
  const build = (rootFolderHost: unknown) => {
    const config = mock<ConfigurationService>();
    config.get.mockImplementation((key: string) => {
      if (key === 'rootFolderHost') return rootFolderHost as never;
      if (key === 'directories') return { dataDir: '/data' } as never;
      return undefined as never;
    });

    const manager = new BackupManager(
      mock<ArchiveService>(),
      mock<LoggerService>(),
      config,
      mock<FilesystemService>(),
      mock<AppFilesManager>(),
      mock<AppVolumeArchiveService>(),
    );
    manager.onApplicationShutdown();
    return manager;
  };

  it('maps the URN onto the host backups directory in directory order', () => {
    // Host path, never the in-container /data one — it is pasted into a `sudo rm`.
    // Backups deliberately hang off ROOT_FOLDER_HOST rather than the app-data base,
    // which the operator can relocate independently via CI_HUB_APP_DATA_PATH.
    expect(build('/srv/hub').getAppBackupsHostDir('plane:ci-marketplace')).toBe('/srv/hub/backups/ci-marketplace/plane');
  });

  it('keeps Windows separators consistent for a drive-letter host root', () => {
    expect(build('C:\\hub').getAppBackupsHostDir('plane:ci-marketplace')).toBe('C:\\hub\\backups\\ci-marketplace\\plane');
  });

  it('returns undefined rather than throwing when the host root is unusable', () => {
    // Best-effort guidance: a misconfigured root must degrade to a generic warning,
    // never turn an otherwise-successful uninstall into a failure.
    expect(build('relative/path').getAppBackupsHostDir('plane:ci-marketplace')).toBeUndefined();
    expect(build('').getAppBackupsHostDir('plane:ci-marketplace')).toBeUndefined();
    expect(build(undefined).getAppBackupsHostDir('plane:ci-marketplace')).toBeUndefined();
  });
});

describe('BackupManager.uploadBackup', () => {
  const dataDir = '/data';
  let manager: BackupManager;
  let filesystem: MockProxy<FilesystemService>;

  beforeEach(() => {
    const config = mock<ConfigurationService>();
    config.get.mockImplementation((key: string) => (key === 'directories' ? ({ dataDir } as never) : (undefined as never)));
    filesystem = mock<FilesystemService>();
    filesystem.createDirectory.mockResolvedValue(true);
    filesystem.writeBinaryFile.mockResolvedValue(true);
    manager = new BackupManager(
      mock<ArchiveService>(),
      mock<LoggerService>(),
      config,
      filesystem,
      mock<AppFilesManager>(),
      mock<AppVolumeArchiveService>(),
    );
    manager.onApplicationShutdown();
  });

  it('refuses a name that is already taken with a translatable 409, not a bare 500', async () => {
    filesystem.pathExists.mockResolvedValue(true);

    const failure = await manager.uploadBackup('app:store' as never, 'taken.tar.gz', Buffer.from('x')).catch((error) => error);

    expect(failure).toMatchObject({ message: 'APP_BACKUP_UPLOAD_ALREADY_EXISTS', status: 409 });
    expect(filesystem.writeBinaryFile).not.toHaveBeenCalled();
  });

  it('writes a new backup', async () => {
    filesystem.pathExists.mockResolvedValue(false);

    await expect(manager.uploadBackup('app:store' as never, 'fresh.tar.gz', Buffer.from('x'))).resolves.toBeUndefined();

    expect(filesystem.writeBinaryFile).toHaveBeenCalledWith('/data/backups/store/app/fresh.tar.gz', expect.any(Buffer));
  });
});

/**
 * On a Windows Hub the app-data folder cannot carry file ownership, so most apps keep their database
 * in a named Docker volume instead of the data folder, and a backup of the folders alone left it out.
 * These run the real BackupManager and FilesystemService over the in-memory filesystem. `tar` and
 * Docker are stand-ins that keep what they are given, so a test can say what went into the archive
 * and what came back out of it.
 */
describe('BackupManager: named Docker volumes', () => {
  const appUrn = 'wordpress:ci-marketplace' as AppUrn;
  const database = 'wordpress_ci-marketplace_data-mariadb';
  const appDataDir = path.join('/app-data', 'ci-marketplace', 'wordpress');
  const appInstalledDir = path.join('/data', 'apps', 'ci-marketplace', 'wordpress');
  const userConfigDir = path.join('/data', 'user-config', 'ci-marketplace', 'wordpress');
  const backupDir = path.join('/data', 'backups', 'ci-marketplace', 'wordpress');

  let manager: BackupManager;
  let appVolumes: MockProxy<AppVolumeArchiveService>;
  /** The Docker volumes on the engine, by name: the key compose gave each one, and its files. */
  let engine: Map<string, { key: string; files: Record<string, string> }>;
  /** What was in the folder `tar` was last asked to archive, at that moment. */
  let archived: Record<string, string | null>;

  /** Every file (with its text) and folder (`null`) under `root`, by its path relative to `root`. */
  const readTree = async (root: string) => {
    const tree: Record<string, string | null> = {};
    const walk = async (dir: string) => {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, String(entry.name));
        const relative = path.relative(root, full).split(path.sep).join('/');
        if (entry.isDirectory()) {
          tree[`${relative}/`] = null;
          await walk(full);
        } else {
          tree[relative] = await fs.promises.readFile(full, 'utf8');
        }
      }
    };
    await walk(root);
    return tree;
  };

  const writeTree = async (root: string, tree: Record<string, string | null>) => {
    for (const [relative, content] of Object.entries(tree)) {
      const target = path.join(root, relative);
      if (content === null) {
        await fs.promises.mkdir(target, { recursive: true });
      } else {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, content);
      }
    }
  };

  beforeEach(async () => {
    for (const [dir, file, content] of [
      [appDataDir, 'app.env', 'DB_PASSWORD=secret'],
      [appInstalledDir, 'docker-compose.yml', 'services: {}'],
      [userConfigDir, 'app.env', 'EXTRA=1'],
    ] as const) {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, file), content);
    }

    const config = mock<ConfigurationService>();
    config.get.mockImplementation((key: string) => (key === 'directories' ? ({ dataDir: '/data' } as never) : ({ maxBackups: 0 } as never)));
    const appFilesManager = mock<AppFilesManager>();
    appFilesManager.getAppPaths.mockReturnValue({ appDataDir, appInstalledDir } as never);

    const filesystem = new FilesystemService(mock<LoggerService>());
    let temps = 0;
    vi.spyOn(filesystem, 'createTempDirectory').mockImplementation(async () => {
      const dir = path.join('/data', 'tmp', `work-${++temps}`);
      await fs.promises.mkdir(dir, { recursive: true });
      return dir;
    });

    // `tar` writes the folder it is given as JSON, so the archive holds exactly what the folder did.
    archived = {};
    const archive = mock<ArchiveService>();
    archive.createTarGz.mockImplementation(async (sourceDir, destinationFile) => {
      archived = await readTree(sourceDir);
      await fs.promises.writeFile(destinationFile, JSON.stringify(archived));
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    archive.listTarGz.mockImplementation(async (file) => {
      const tree = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, string | null>;
      return [
        { path: './', type: 'd' },
        ...Object.entries(tree).map(([entry, content]) => ({ path: `./${entry}`, type: content === null ? 'd' : '-' })),
      ];
    });
    archive.extractTarGz.mockImplementation(async (file, destinationDir) => {
      await writeTree(destinationDir, JSON.parse(await fs.promises.readFile(file, 'utf8')));
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    // Docker keeps volumes in a map, and a volume's archive is its files as JSON.
    engine = new Map();
    appVolumes = mock<AppVolumeArchiveService>();
    appVolumes.listAppVolumes.mockImplementation(async () => [...engine].map(([name, { key }]) => ({ name, key })));
    appVolumes.exportVolume.mockImplementation(async (name, file) => {
      await fs.promises.writeFile(file, JSON.stringify(engine.get(name)?.files));
    });
    appVolumes.restoreTargets.mockImplementation(async (_appUrn, keys) =>
      keys.map((key) => {
        const name = [...engine].find(([, volume]) => volume.key === key)?.[0];
        return { name: name ?? `wordpress_ci-marketplace_${key}`, key, create: !name };
      }),
    );
    appVolumes.importVolume.mockImplementation(async (_appUrn, target, file) => {
      engine.set(target.name, { key: target.key, files: JSON.parse(await fs.promises.readFile(file, 'utf8')) });
    });

    manager = new BackupManager(archive, mock<LoggerService>(), config, filesystem, appFilesManager, appVolumes);
    manager.onApplicationShutdown();
  });

  it("brings back an app's database kept in a named volume", async () => {
    engine.set(database, { key: 'data-mariadb', files: { ibdata1: 'posts and users' } });

    const { filename } = await manager.backupApp(appUrn);
    // Resetting the app leaves an empty database volume.
    engine.set(database, { key: 'data-mariadb', files: {} });
    await manager.restoreApp(appUrn, filename);

    expect(engine.get(database)?.files).toEqual({ ibdata1: 'posts and users' });
  });

  it('puts each named volume in the archive as volumes/<key>.tar', async () => {
    engine.set(database, { key: 'data-mariadb', files: { ibdata1: 'posts and users' } });

    await manager.backupApp(appUrn);

    expect(archived['volumes/data-mariadb.tar']).toBe(JSON.stringify({ ibdata1: 'posts and users' }));
  });

  it('archives an app without named volumes exactly as before', async () => {
    await manager.backupApp(appUrn);

    expect(Object.keys(archived).sort()).toEqual([
      'app-data/',
      'app-data/app.env',
      'app/',
      'app/docker-compose.yml',
      'user-config/',
      'user-config/app.env',
    ]);
    expect(appVolumes.exportVolume).not.toHaveBeenCalled();
  });

  it('does not report a backup when a volume could not be copied', async () => {
    engine.set(database, { key: 'data-mariadb', files: { ibdata1: 'posts and users' } });
    appVolumes.exportVolume.mockRejectedValue(new Error('docker run exited 1: tar: write error: No space left on device'));

    await expect(manager.backupApp(appUrn)).rejects.toThrow('No space left on device');

    await expect(fs.promises.readdir(backupDir).catch(() => [])).resolves.toEqual([]);
  });

  it("refuses a restore before it touches the app's files when a volume cannot go back", async () => {
    engine.set(database, { key: 'data-mariadb', files: { ibdata1: 'posts and users' } });
    const { filename } = await manager.backupApp(appUrn);
    await fs.promises.writeFile(path.join(appDataDir, 'app.env'), 'DB_PASSWORD=changed');
    appVolumes.restoreTargets.mockRejectedValue(new Error('Volume wordpress_ci-marketplace_data-mariadb belongs to another app'));

    await expect(manager.restoreApp(appUrn, filename)).rejects.toThrow('belongs to another app');

    await expect(fs.promises.readFile(path.join(appDataDir, 'app.env'), 'utf8')).resolves.toBe('DB_PASSWORD=changed');
    expect(appVolumes.importVolume).not.toHaveBeenCalled();
  });

  it('restores a backup that has no volumes without asking Docker about them', async () => {
    const { filename } = await manager.backupApp(appUrn);
    engine.set(database, { key: 'data-mariadb', files: { ibdata1: 'live' } });
    await fs.promises.writeFile(path.join(appDataDir, 'app.env'), 'DB_PASSWORD=changed');

    await manager.restoreApp(appUrn, filename);

    await expect(fs.promises.readFile(path.join(appDataDir, 'app.env'), 'utf8')).resolves.toBe('DB_PASSWORD=secret');
    expect(engine.get(database)?.files).toEqual({ ibdata1: 'live' });
    expect(appVolumes.restoreTargets).not.toHaveBeenCalled();
  });
});
