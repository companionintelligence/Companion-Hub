import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import type Dockerode from 'dockerode';
import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppsRepository } from '../../apps/apps.repository';
import { DOCKERODE } from '../constants';
import { DockerReadFacade } from '../docker-read.facade';

// The real filesystem, with real permission bits. The suite's memfs mock cannot say "no" to a read or a
// mkdir, which is why no test noticed that, on a native-Linux Hub, an app update could not even take its
// rollback snapshot: /data is root-owned (only its subfolders are mounted from the host) and a database's
// files belong to the user its container ran as. Here the layout of that Hub is built for real.
vi.unmock('node:fs');
vi.unmock('fs');
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const fs = (await import('node:fs')).default;
const child_process = await import('node:child_process');
const { DockerService } = await import('../docker.service');
const { FilesystemService } = await import('@/core/filesystem/filesystem.service');

const canEnforcePermissions = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

const helperProcess = (exitCode: number) => {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.on = vi.fn().mockImplementation((event: string, handler: (code: number) => void) => {
    if (event === 'close') queueMicrotask(() => handler(exitCode));
    return proc;
  });
  return proc;
};

/** Undo the restrictive modes so the scratch folder can be deleted. */
async function loosen(dir: string): Promise<void> {
  await fs.promises.chmod(dir, 0o755).catch(() => undefined);
  for (const name of await fs.promises.readdir(dir).catch(() => [] as string[])) {
    const full = path.join(dir, name);
    const stat = await fs.promises.lstat(full).catch(() => null);
    if (!stat || stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) await loosen(full);
    else await fs.promises.chmod(full, 0o644).catch(() => undefined);
  }
}

describe.skipIf(!canEnforcePermissions)('createPreUpdateVolumeSnapshot on a Hub whose /data is not writable', () => {
  const urn = 'test-app:test-store' as any;
  let scratch: string;
  let dataDir: string;
  let appDataDir: string;
  let appInstalledDir: string;
  let service: InstanceType<typeof DockerService>;

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'snap-perms-'));
    dataDir = path.join(scratch, 'data');
    appDataDir = path.join(scratch, 'app-data', 'test-store', 'test-app');
    appInstalledDir = path.join(dataDir, 'apps', 'test-store', 'test-app');

    await fs.promises.mkdir(path.join(dataDir, 'backups'), { recursive: true });
    await fs.promises.mkdir(appInstalledDir, { recursive: true });
    await fs.promises.writeFile(path.join(appInstalledDir, 'docker-compose.yml'), 'services: {}\n');
    await fs.promises.mkdir(path.join(appDataDir, 'mysql'), { recursive: true });
    await fs.promises.writeFile(path.join(appDataDir, 'settings.json'), '{"ok":true}');
    // The Hub's own folders are its to write; /data itself is not (root-owned in the image).
    await fs.promises.chmod(dataDir, 0o555);

    const configService = mock<ConfigurationService>();
    configService.get.mockImplementation((key) =>
      key === 'directories' ? ({ dataDir, appsDir: path.join(dataDir, 'apps') } as any) : (null as any),
    );
    configService.getConfig.mockReturnValue({ userSettings: {}, rootFolderHost: '/host/root' } as any);
    const appFilesManager = mock<AppFilesManager>();
    appFilesManager.getAppPaths.mockReturnValue({ appDataDir, appInstalledDir } as any);
    const dockerode = mock<Dockerode>();
    dockerode.listContainers.mockResolvedValue([]);
    dockerode.listVolumes.mockResolvedValue({ Volumes: [] } as any);

    const moduleRef = await Test.createTestingModule({
      providers: [
        DockerReadFacade,
        DockerService,
        FilesystemService,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: ConfigurationService, useValue: configService },
        { provide: AppFilesManager, useValue: appFilesManager },
        { provide: AppsRepository, useValue: mock<AppsRepository>() },
        { provide: DOCKERODE, useValue: dockerode },
      ],
    }).compile();

    service = moduleRef.get(DockerService);
    (child_process.spawn as any).mockReset();
  });

  afterEach(async () => {
    await loosen(scratch);
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  it('takes the snapshot under backups/.pre-update-snapshots and copies the data and the installed files into it', async () => {
    const result = await service.createPreUpdateVolumeSnapshot(urn);

    expect(result.success).toBe(true);
    expect(result.dataSnapshotCopiedAsRoot).toBeUndefined();
    expect(result.snapshotBaseDir?.startsWith(path.join(dataDir, 'backups', '.pre-update-snapshots'))).toBe(true);
    await expect(fs.promises.readFile(path.join(result.snapshotPath as string, 'settings.json'), 'utf8')).resolves.toBe('{"ok":true}');
    await expect(fs.promises.readFile(path.join(result.appFilesSnapshotPath as string, 'docker-compose.yml'), 'utf8')).resolves.toBe(
      'services: {}\n',
    );
    expect(child_process.spawn).not.toHaveBeenCalled();
    // Nothing was written directly under the unwritable /data.
    await expect(fs.promises.readdir(dataDir)).resolves.toEqual(expect.not.arrayContaining(['snapshots']));
  });

  it('hands a data folder with a file the Hub cannot read to the privileged helper instead of failing', async () => {
    const dbFile = path.join(appDataDir, 'mysql', 'ibdata1');
    await fs.promises.writeFile(dbFile, 'database bytes');
    await fs.promises.chmod(dbFile, 0o000);
    (child_process.spawn as any).mockReturnValue(helperProcess(0));

    const result = await service.createPreUpdateVolumeSnapshot(urn);

    expect(result.success).toBe(true);
    expect(result.dataSnapshotCopiedAsRoot).toBe(true);
    expect(child_process.spawn).toHaveBeenCalledTimes(1);
    const args = (child_process.spawn as any).mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(['--user', '0:0', '--network', 'none', 'cp', '-a', '/src/.', '/dest/']));
    // The installed files are the Hub's own and are still copied by the Hub.
    await expect(fs.promises.readFile(path.join(result.appFilesSnapshotPath as string, 'docker-compose.yml'), 'utf8')).resolves.toBe(
      'services: {}\n',
    );
  });

  it('fails the snapshot, and the update with it, when even the helper cannot copy', async () => {
    const dbFile = path.join(appDataDir, 'mysql', 'ibdata1');
    await fs.promises.writeFile(dbFile, 'database bytes');
    await fs.promises.chmod(dbFile, 0o000);
    (child_process.spawn as any).mockReturnValue(helperProcess(1));

    const result = await service.createPreUpdateVolumeSnapshot(urn);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not copy');
  });
});
