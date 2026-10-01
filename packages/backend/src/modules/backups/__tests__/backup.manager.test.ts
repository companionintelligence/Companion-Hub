import fs from 'node:fs';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveService } from '@/core/archive/archive.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
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

    manager = new BackupManager(mock<ArchiveService>(), mock<LoggerService>(), config, filesystem, mock<AppFilesManager>());
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

    const manager = new BackupManager(mock<ArchiveService>(), mock<LoggerService>(), config, mock<FilesystemService>(), mock<AppFilesManager>());
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
    manager = new BackupManager(mock<ArchiveService>(), mock<LoggerService>(), config, filesystem, mock<AppFilesManager>());
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
