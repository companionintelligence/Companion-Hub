import os from 'node:os';
import path from 'node:path';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { mock, mockDeep } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DockerService } from '@/modules/docker/docker.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import type { AppUrn } from '@ci-hub/common/types';

vi.mock('@ci-hub/common/schemas', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  parseComposeJson: vi.fn().mockReturnValue({ services: [], overrides: [] }),
}));

// Real files with real permission bits: the suite's memfs mock cannot refuse a delete, which is how a
// rollback that could not put a root container's data back went unnoticed.
vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { FilesystemService } = await import('@/core/filesystem/filesystem.service');
const { UpdateAppCommand } = await import('../update-app-command');

// root ignores permission bits and Windows has none to speak of; there the Hub can delete anything.
const canEnforcePermissions = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

/** Give the owner back write access everywhere under `dir`, as root would not need, so it can be deleted. */
async function loosen(dir: string): Promise<void> {
  const stat = await fs.promises.lstat(dir).catch(() => null);
  if (!stat) return;
  await fs.promises.chmod(dir, stat.isDirectory() ? 0o755 : 0o644).catch(() => undefined);
  if (!stat.isDirectory()) return;
  for (const name of await fs.promises.readdir(dir).catch(() => [] as string[])) {
    await loosen(path.join(dir, name));
  }
}

/*
 * Uptime Kuma runs as root, so its `data/` and `kuma.db` belong to root. The Hub can read them, so it
 * takes the rollback snapshot itself, but it cannot delete them: when the new version failed, the
 * rollback could not put the snapshot back and the app came back on the new version's data. A folder
 * and a file the test cannot write stand in for root's.
 */
describe.skipIf(!canEnforcePermissions)('UpdateAppCommand rollback over data the Hub cannot delete', () => {
  const appUrn = 'uptime-kuma:ci-marketplace' as AppUrn;
  let scratch: string;
  let appDataDir: string;
  let appInstalledDir: string;
  let snapshotBaseDir: string;
  let docker: ReturnType<typeof mock<DockerService>>;
  let appFilesManager: ReturnType<typeof mock<AppFilesManager>>;
  let command: InstanceType<typeof UpdateAppCommand>;

  const kumaDb = () => path.join(appDataDir, 'data', 'kuma.db');

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rollback-'));
    appDataDir = path.join(scratch, 'app-data', 'ci-marketplace', 'uptime-kuma');
    appInstalledDir = path.join(scratch, 'data', 'apps', 'ci-marketplace', 'uptime-kuma');
    snapshotBaseDir = path.join(scratch, 'data', 'backups', '.pre-update-snapshots', 'ci-marketplace', 'uptime-kuma', 'pre-update-uptime-kuma-1');

    // The snapshot the Hub took before the update and the files it was taken from.
    await fs.promises.mkdir(path.join(snapshotBaseDir, 'app-data', 'data'), { recursive: true });
    await fs.promises.writeFile(path.join(snapshotBaseDir, 'app-data', 'data', 'kuma.db'), 'before the update');
    await fs.promises.mkdir(path.join(snapshotBaseDir, 'app-files'), { recursive: true });
    await fs.promises.writeFile(path.join(snapshotBaseDir, 'app-files', 'docker-compose.yml'), 'old version');
    await fs.promises.mkdir(appInstalledDir, { recursive: true });
    await fs.promises.writeFile(path.join(appInstalledDir, 'docker-compose.yml'), 'old version');

    // What the new version left behind, as root.
    await fs.promises.mkdir(path.join(appDataDir, 'data'), { recursive: true });
    await fs.promises.writeFile(kumaDb(), 'migrated by the new version');
    await fs.promises.chmod(kumaDb(), 0o444);
    await fs.promises.chmod(path.join(appDataDir, 'data'), 0o555);

    const logger = mockDeep<LoggerService>();
    const filesystem = new FilesystemService(logger);
    appFilesManager = mock<AppFilesManager>();
    appFilesManager.getAppPaths.mockReturnValue({ appDataDir, appInstalledDir } as never);
    appFilesManager.deleteAppFolder.mockResolvedValue(true);
    appFilesManager.getAppEnv.mockResolvedValue({ path: path.join(appDataDir, 'app.env'), content: 'PREVIOUS=1\n' } as never);
    const marketplace = mock<MarketplaceService>();
    marketplace.getDockerComposeJson.mockResolvedValue({ content: 'services: {}' } as never);
    const configuration = mock<ConfigurationService>();
    configuration.get.mockReturnValue({ maxBackups: 0 } as never);
    const appsRepository = mock<AppsRepository>();
    appsRepository.getAppByUrn.mockResolvedValue({ maxBackups: null } as never);

    docker = mock<DockerService>();
    docker.composeApp.mockResolvedValue(undefined as never);
    docker.createPreUpdateVolumeSnapshot.mockResolvedValue({
      appUrn,
      snapshotId: 'pre-update-uptime-kuma-1',
      timestamp: new Date().toISOString(),
      snapshotBaseDir,
      snapshotPath: path.join(snapshotBaseDir, 'app-data'),
      appFilesSnapshotPath: path.join(snapshotBaseDir, 'app-files'),
      volumes: [],
      success: true,
    });
    // The new version does not come up healthy, so the update rolls back.
    docker.verifyContainerHealthProbe.mockResolvedValue({ ok: true, healthy: false, containers: [], message: 'uptime-kuma exited' } as never);

    const services = new Map<unknown, unknown>([
      [LoggerService, logger],
      [AppFilesManager, appFilesManager],
      [DockerService, docker],
      [MarketplaceService, marketplace],
      [AppHelpers, mock<AppHelpers>()],
      [BackupManager, mock<BackupManager>()],
      [FilesystemService, filesystem],
      [ConfigurationService, configuration],
      [AppsRepository, appsRepository],
    ]);
    const moduleRef = mock<ModuleRef>();
    moduleRef.get.mockImplementation(((token: unknown) => services.get(token)) as never);

    // "Back up first" off, so the rollback comes from the snapshot.
    command = new UpdateAppCommand(moduleRef, {} as Dockerode, false, true);
    (command as unknown as { assertMarketplaceEntitlement: () => Promise<void> }).assertMarketplaceEntitlement = vi.fn().mockResolvedValue(undefined);
    (command as unknown as { ensureAppDir: () => Promise<void> }).ensureAppDir = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await loosen(scratch);
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  it('empties the data through the root helper and puts the snapshot back', async () => {
    // What `find /target -mindepth 1 -delete` does as root: the contents go, the folder stays.
    docker.removeAppDataDirAsRoot.mockImplementation(async () => {
      await loosen(appDataDir);
      for (const name of await fs.promises.readdir(appDataDir)) {
        await fs.promises.rm(path.join(appDataDir, name), { recursive: true, force: true });
      }
      return true;
    });

    const result = await command.execute(appUrn, {});

    expect(result).toMatchObject({ success: false, rolledBack: true });
    // No budget of its own yet: the whole-update deadline comes with #2107.
    expect(docker.removeAppDataDirAsRoot).toHaveBeenCalledWith(appUrn, undefined);
    await expect(fs.promises.readFile(kumaDb(), 'utf8')).resolves.toBe('before the update');
    // Any bind-mount folder the snapshot did not hold is made by the Hub, not by Docker as root.
    expect(appFilesManager.createVolumeHostDirs).toHaveBeenCalledWith(appUrn);
    // A rollback that worked no longer needs the snapshot.
    await expect(fs.promises.access(snapshotBaseDir)).rejects.toThrow();
  });

  it('keeps the snapshot and says the rollback did not work when the helper cannot remove the data either', async () => {
    docker.removeAppDataDirAsRoot.mockResolvedValue(false);

    const result = await command.execute(appUrn, {});

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(appFilesManager.createVolumeHostDirs).not.toHaveBeenCalled();
    await expect(fs.promises.readFile(path.join(snapshotBaseDir, 'app-data', 'data', 'kuma.db'), 'utf8')).resolves.toBe('before the update');
  });
});
