/**
 * Restoring a backup deletes the app's live data and then writes the archive's. The archive may be
 * one a user uploaded, so these tests drive the real `tar` over real archives — including hostile
 * ones built byte by byte — and check the property that matters: a rejected archive leaves the live
 * data exactly as it was, and nothing it contained ever reaches a path outside the restore.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { AppVolumeArchiveService } from '@/modules/docker/app-volume-archive.service';
import type { AppUrn } from '@ci-hub/common/types';

vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { ArchiveService } = await import('@/core/archive/archive.service');
const { FilesystemService } = await import('@/core/filesystem/filesystem.service');
const { BackupManager } = await import('../backup.manager');

const hasTar = (() => {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

type TarEntry = { name: string; type?: '0' | '1' | '2' | '5'; content?: string; linkname?: string };

/** A ustar archive written by hand, so any name and entry type can be put in it whatever the host's tar would allow. */
function makeTarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const type = entry.type ?? '0';
    const data = type === '0' ? Buffer.from(entry.content ?? '') : Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write(type === '5' ? '0000755\0' : '0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148); // checksum placeholder: eight spaces
    header.write(type, 156);
    if (entry.linkname) header.write(entry.linkname, 157, 100, 'utf8');
    header.write('ustar\0', 257);
    header.write('00', 263);

    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);

    blocks.push(header);
    if (data.length > 0) {
      blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }

  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

const VALID_ENTRIES: TarEntry[] = [
  { name: './', type: '5' },
  { name: './app-data/', type: '5' },
  { name: './app-data/data.txt', content: 'restored-data' },
  { name: './app/', type: '5' },
  { name: './app/docker-compose.json', content: '{"restored":true}' },
  { name: './user-config/', type: '5' },
  { name: './user-config/app.env', content: 'RESTORED=true\n' },
];

describe.skipIf(!hasTar)('BackupManager (real filesystem and tar)', () => {
  const appUrn = 'test-app:test-store' as AppUrn;

  let scratch: string;
  let dataDir: string;
  let appDataDir: string;
  let appInstalledDir: string;
  let userConfigDir: string;
  let backupDir: string;
  let tempDirs: string[];
  let filesystem: InstanceType<typeof FilesystemService>;
  let archive: InstanceType<typeof ArchiveService>;
  let logger: ReturnType<typeof mock<LoggerService>>;
  let appFilesManager: ReturnType<typeof mock<AppFilesManager>>;
  let manager: InstanceType<typeof BackupManager>;

  const putArchive = async (name: string, bytes: Buffer | string) => {
    await fs.promises.mkdir(backupDir, { recursive: true });
    await fs.promises.writeFile(path.join(backupDir, name), bytes);
    return name;
  };

  const readLive = async () => ({
    data: await fs.promises.readFile(path.join(appDataDir, 'data.txt'), 'utf8'),
    compose: await fs.promises.readFile(path.join(appInstalledDir, 'docker-compose.json'), 'utf8'),
    env: await fs.promises.readFile(path.join(userConfigDir, 'app.env'), 'utf8'),
  });

  const expectLiveUntouched = async () => {
    await expect(readLive()).resolves.toEqual({ data: 'live-data', compose: '{"live":true}', env: 'LIVE=true\n' });
  };

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'restore-'));
    dataDir = path.join(scratch, 'data');
    appDataDir = path.join(scratch, 'app-data', 'test-store', 'test-app');
    appInstalledDir = path.join(dataDir, 'apps', 'test-store', 'test-app');
    userConfigDir = path.join(dataDir, 'user-config', 'test-store', 'test-app');
    backupDir = path.join(dataDir, 'backups', 'test-store', 'test-app');

    for (const [dir, file, content] of [
      [appDataDir, 'data.txt', 'live-data'],
      [appInstalledDir, 'docker-compose.json', '{"live":true}'],
      [userConfigDir, 'app.env', 'LIVE=true\n'],
    ] as const) {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, file), content);
    }

    logger = mock<LoggerService>();
    const config = mock<ConfigurationService>();
    config.get.mockImplementation(((key: string) => (key === 'directories' ? { dataDir } : { maxBackups: 0 })) as never);
    appFilesManager = mock<AppFilesManager>();
    appFilesManager.getAppPaths.mockReturnValue({ appDataDir, appInstalledDir } as never);

    filesystem = new FilesystemService(logger);
    tempDirs = [];
    const createTempDirectory = filesystem.createTempDirectory.bind(filesystem);
    vi.spyOn(filesystem, 'createTempDirectory').mockImplementation(async (prefix: string) => {
      const dir = await createTempDirectory(prefix);
      if (dir) tempDirs.push(dir);
      return dir;
    });

    archive = new ArchiveService(logger);
    // An app with no named Docker volumes, which is every app outside a Windows Hub.
    const appVolumes = mock<AppVolumeArchiveService>();
    appVolumes.listAppVolumes.mockResolvedValue([]);
    manager = new BackupManager(archive, logger, config, filesystem, appFilesManager, appVolumes);
    manager.onApplicationShutdown(); // stop the constructor's weekly interval
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(scratch, { recursive: true, force: true });
    await Promise.all(tempDirs.map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
  });

  it('replaces the live data with the backup', async () => {
    const name = await putArchive('good.tar.gz', makeTarGz(VALID_ENTRIES));

    await manager.restoreApp(appUrn, name);

    await expect(readLive()).resolves.toEqual({ data: 'restored-data', compose: '{"restored":true}', env: 'RESTORED=true\n' });
  });

  it('restores a backup written by the real backupApp tar invocation', async () => {
    const stage = path.join(scratch, 'stage');
    await fs.promises.mkdir(path.join(stage, 'app-data', 'nested'), { recursive: true });
    await fs.promises.mkdir(path.join(stage, 'app'), { recursive: true });
    await fs.promises.writeFile(path.join(stage, 'app-data', 'nested', 'file with spaces.txt'), 'nested-ok');
    await fs.promises.writeFile(path.join(stage, 'app', 'docker-compose.json'), '{"from":"tar"}');
    await fs.promises.mkdir(backupDir, { recursive: true });
    execFileSync('tar', ['-czpf', path.join(backupDir, 'real.tar.gz'), '-C', stage, '.']);

    await manager.restoreApp(appUrn, 'real.tar.gz');

    await expect(fs.promises.readFile(path.join(appDataDir, 'nested', 'file with spaces.txt'), 'utf8')).resolves.toBe('nested-ok');
    await expect(fs.promises.readFile(path.join(appInstalledDir, 'docker-compose.json'), 'utf8')).resolves.toBe('{"from":"tar"}');
    // A backup without a user-config folder leaves an empty one, as before.
    await expect(fs.promises.readdir(userConfigDir)).resolves.toEqual([]);
  });

  it('removes its temporary folder after a successful restore', async () => {
    const name = await putArchive('good.tar.gz', makeTarGz(VALID_ENTRIES));

    await manager.restoreApp(appUrn, name);

    expect(tempDirs).toHaveLength(1);
    await expect(fs.promises.access(tempDirs[0] as string)).rejects.toThrow();
  });

  const HOSTILE: Array<[string, TarEntry[], string]> = [
    ['a symlink in user-config', [...VALID_ENTRIES, { name: './user-config/leak', type: '2', linkname: '/etc/passwd' }], 'unsupported file types'],
    ['a symlink in app-data', [...VALID_ENTRIES, { name: './app-data/leak', type: '2', linkname: '/' }], 'unsupported file types'],
    ['a symlink in app', [...VALID_ENTRIES, { name: './app/leak', type: '2', linkname: 'docker-compose.json' }], 'unsupported file types'],
    [
      'a symlink at the top of app-data, where the Hub writes app.env',
      [...VALID_ENTRIES, { name: './app-data/app.env', type: '2', linkname: '/etc/passwd' }],
      'unsupported file types',
    ],
    ['a hard link', [...VALID_ENTRIES, { name: './app-data/twin', type: '1', linkname: './app-data/data.txt' }], 'unsupported file types'],
    ['a parent-directory path', [...VALID_ENTRIES, { name: '../escaped.txt', content: 'x' }], 'unsupported file types'],
    ['a ./-prefixed parent-directory path', [...VALID_ENTRIES, { name: './../escaped.txt', content: 'x' }], 'unsupported file types'],
    [
      'a path that climbs out of a backup folder',
      [...VALID_ENTRIES, { name: './app-data/../../escaped.txt', content: 'x' }],
      'unsupported file types',
    ],
    ['an absolute path', [...VALID_ENTRIES, { name: '/tmp/restore-escaped.txt', content: 'x' }], 'unsupported file types'],
    ['a top-level folder that is not part of a backup', [...VALID_ENTRIES, { name: './etc/cron.d/job', content: 'x' }], 'unsupported file types'],
    ['a top-level file', [...VALID_ENTRIES, { name: './.env', content: 'x' }], 'unsupported file types'],
    ['no app-data folder', VALID_ENTRIES.filter((e) => !e.name.startsWith('./app-data')), 'missing required folders'],
    ['no app folder', VALID_ENTRIES.filter((e) => !e.name.startsWith('./app/')), 'missing required folders'],
  ];

  it.each(HOSTILE)('rejects an archive with %s and leaves the live data alone', async (_name, entries, message) => {
    const name = await putArchive('bad.tar.gz', makeTarGz(entries));

    await expect(manager.restoreApp(appUrn, name)).rejects.toThrow(message);

    await expectLiveUntouched();
    // Whatever it tried to write outside the restore is not there.
    await expect(fs.promises.access(path.join(scratch, 'escaped.txt'))).rejects.toThrow();
    await expect(fs.promises.access('/tmp/restore-escaped.txt')).rejects.toThrow();
  });

  it.each(HOSTILE)('cleans up its temporary folder after rejecting an archive with %s', async (_name, entries) => {
    const name = await putArchive('bad.tar.gz', makeTarGz(entries));

    await expect(manager.restoreApp(appUrn, name)).rejects.toThrow();

    expect(tempDirs).toHaveLength(1);
    await expect(fs.promises.access(tempDirs[0] as string)).rejects.toThrow();
  });

  describe('symbolic links inside the app data folder', () => {
    const WITH_LINKS: TarEntry[] = [
      ...VALID_ENTRIES,
      { name: './app-data/data/', type: '5' },
      { name: './app-data/data/real.txt', content: 'target-content' },
      { name: './app-data/data/alias', type: '2', linkname: 'real.txt' },
      { name: './app-data/data/python', type: '2', linkname: '/usr/bin/python3' },
    ];

    it('restores them as links, with their targets as written', async () => {
      const name = await putArchive('links.tar.gz', makeTarGz(WITH_LINKS));

      await manager.restoreApp(appUrn, name);

      await expect(fs.promises.readlink(path.join(appDataDir, 'data', 'alias'))).resolves.toBe('real.txt');
      await expect(fs.promises.readlink(path.join(appDataDir, 'data', 'python'))).resolves.toBe('/usr/bin/python3');
      await expect(fs.promises.readFile(path.join(appDataDir, 'data', 'alias'), 'utf8')).resolves.toBe('target-content');
    });

    it('refuses an entry written through a link, whichever comes first in the archive', async () => {
      const outside = path.join(scratch, 'outside');
      await fs.promises.mkdir(outside);
      const link: TarEntry = { name: './app-data/data/hole', type: '2', linkname: outside };
      const through: TarEntry = { name: './app-data/data/hole/pwned.txt', content: 'x' };

      for (const order of [
        [link, through],
        [through, link],
      ]) {
        const name = await putArchive('through.tar.gz', makeTarGz([...VALID_ENTRIES, { name: './app-data/data/', type: '5' }, ...order]));

        await expect(manager.restoreApp(appUrn, name)).rejects.toThrow('unsupported file types');

        await expect(fs.promises.access(path.join(outside, 'pwned.txt'))).rejects.toThrow();
        await expectLiveUntouched();
      }
    });

    it('says which entry it refused, in the log', async () => {
      const name = await putArchive(
        'named.tar.gz',
        makeTarGz([...VALID_ENTRIES, { name: './user-config/leak', type: '2', linkname: '/etc/passwd' }]),
      );

      await expect(manager.restoreApp(appUrn, name)).rejects.toThrow('unsupported file types');

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('user-config/leak'));
    });
  });

  describe('backupApp', () => {
    it('writes a backup that restores, links included, with a relative target kept relative', async () => {
      await fs.promises.mkdir(path.join(appDataDir, 'data'), { recursive: true });
      await fs.promises.writeFile(path.join(appDataDir, 'data', 'real.txt'), 'before-backup');
      await fs.promises.symlink('real.txt', path.join(appDataDir, 'data', 'alias'));

      const { filename } = await manager.backupApp(appUrn);
      await fs.promises.rm(appDataDir, { recursive: true, force: true });
      await manager.restoreApp(appUrn, filename);

      await expect(fs.promises.readlink(path.join(appDataDir, 'data', 'alias'))).resolves.toBe('real.txt');
      await expect(fs.promises.readFile(path.join(appDataDir, 'data', 'alias'), 'utf8')).resolves.toBe('before-backup');
    });

    it('leaves no temporary folder or stray archive behind', async () => {
      const { filename } = await manager.backupApp(appUrn);

      expect(tempDirs).toHaveLength(1);
      await expect(fs.promises.access(tempDirs[0] as string)).rejects.toThrow();
      await expect(fs.promises.access(`${tempDirs[0]}.tar.gz`)).rejects.toThrow();
      await expect(fs.promises.readdir(backupDir)).resolves.toContain(filename);
    });

    it('does not report a backup when tar failed, and cleans up', async () => {
      vi.spyOn(archive, 'createTarGz').mockResolvedValue({ stdout: '', stderr: 'tar: No space left on device', exitCode: 2 });

      await expect(manager.backupApp(appUrn)).rejects.toThrow('Failed to create the backup archive: tar: No space left on device');

      // Nothing was moved into the backups folder, so there is no file for the name to refer to.
      await expect(fs.promises.access(backupDir)).rejects.toThrow();
      await expect(fs.promises.access(tempDirs[0] as string)).rejects.toThrow();
    });

    it('does not report a backup when the app files could not be copied', async () => {
      vi.spyOn(filesystem, 'copyDirectory').mockResolvedValue(false);

      await expect(manager.backupApp(appUrn)).rejects.toThrow('Failed to copy the app files for the backup');
      await expect(fs.promises.access(tempDirs[0] as string)).rejects.toThrow();
    });

    it('backs up an app whose data folder sits under a path containing "backups"', async () => {
      const mounted = path.join(scratch, 'mnt', 'backups', 'data');
      await fs.promises.mkdir(mounted, { recursive: true });
      await fs.promises.writeFile(path.join(mounted, 'file.txt'), 'on-the-backups-volume');
      appFilesManager.getAppPaths.mockReturnValue({ appDataDir: mounted, appInstalledDir } as never);

      const { filename } = await manager.backupApp(appUrn);
      await fs.promises.rm(mounted, { recursive: true, force: true });
      await manager.restoreApp(appUrn, filename);

      await expect(fs.promises.readFile(path.join(mounted, 'file.txt'), 'utf8')).resolves.toBe('on-the-backups-volume');
    });

    it('still leaves out a backups folder inside the data folder', async () => {
      await fs.promises.mkdir(path.join(appDataDir, 'backups'), { recursive: true });
      await fs.promises.writeFile(path.join(appDataDir, 'backups', 'old.tar.gz'), 'x');

      const { filename } = await manager.backupApp(appUrn);
      await fs.promises.rm(appDataDir, { recursive: true, force: true });
      await manager.restoreApp(appUrn, filename);

      await expect(fs.promises.access(path.join(appDataDir, 'backups', 'old.tar.gz'))).rejects.toThrow();
      await expect(fs.promises.readFile(path.join(appDataDir, 'data.txt'), 'utf8')).resolves.toBe('live-data');
    });

    it('gives an app with no data folder an empty one in the archive, so the backup can be restored', async () => {
      await fs.promises.rm(appDataDir, { recursive: true, force: true });

      const { filename } = await manager.backupApp(appUrn);
      await manager.restoreApp(appUrn, filename);

      await expect(fs.promises.readdir(appDataDir)).resolves.toEqual([]);
    });
  });

  it('rejects a file that is not an archive, rather than "extracting" nothing and wiping the app', async () => {
    const name = await putArchive('junk.tar.gz', 'this is not an archive');

    await expect(manager.restoreApp(appUrn, name)).rejects.toThrow('Invalid backup archive');

    await expectLiveUntouched();
  });

  it('rejects a truncated archive', async () => {
    const whole = makeTarGz([...VALID_ENTRIES, { name: './app-data/big.bin', content: 'z'.repeat(200_000) }]);
    const name = await putArchive('cut.tar.gz', whole.subarray(0, Math.floor(whole.length / 2)));

    await expect(manager.restoreApp(appUrn, name)).rejects.toThrow('Invalid backup archive');

    await expectLiveUntouched();
  });

  it('rejects an empty file', async () => {
    const name = await putArchive('empty.tar.gz', '');

    await expect(manager.restoreApp(appUrn, name)).rejects.toThrow();

    await expectLiveUntouched();
  });

  it('does not treat a symlink in the backups folder as a backup', async () => {
    const elsewhere = path.join(scratch, 'elsewhere.tar.gz');
    await fs.promises.writeFile(elsewhere, makeTarGz(VALID_ENTRIES));
    await fs.promises.mkdir(backupDir, { recursive: true });
    await fs.promises.symlink(elsewhere, path.join(backupDir, 'linked.tar.gz'));

    await expect(manager.restoreApp(appUrn, 'linked.tar.gz')).rejects.toThrow('The backup file does not exist');

    await expectLiveUntouched();
    await expect(manager.getBackupPath(appUrn, 'linked.tar.gz')).rejects.toThrow('The backup file does not exist');
  });

  it('reports a restore that could not write the data, instead of "succeeding"', async () => {
    const name = await putArchive('good.tar.gz', makeTarGz(VALID_ENTRIES));
    vi.spyOn(filesystem, 'copyDirectory').mockResolvedValue(false);

    await expect(manager.restoreApp(appUrn, name)).rejects.toThrow('Failed to restore the backup files');
  });

  it('refuses a filename that is not a single segment before creating anything', async () => {
    await expect(manager.restoreApp(appUrn, '../../../etc/passwd')).rejects.toThrow('Invalid backup filename');

    expect(tempDirs).toHaveLength(0);
  });

  it('refuses a backup that does not exist before creating anything', async () => {
    await expect(manager.restoreApp(appUrn, 'nope.tar.gz')).rejects.toThrow('The backup file does not exist');

    expect(tempDirs).toHaveLength(0);
  });
});
