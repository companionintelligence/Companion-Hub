import os from 'node:os';
import path from 'node:path';
import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';

// Real folders, so the test can see who made them and with what mode.
vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { FilesystemService } = await import('@/core/filesystem/filesystem.service');
const { AppFilesManager } = await import('../app-files-manager');

/*
 * Docker creates a missing bind-mount source as root:root 755. After Reset app that was every one of
 * them, so a Hub running as the host user could not open them up or delete what the app wrote there.
 * Install has always made them as the Hub first; Reset, a restore and an update rollback now do too.
 */
describe('AppFilesManager.createVolumeHostDirs', () => {
  const appUrn = 'uptime-kuma:ci-marketplace' as AppUrn;
  let scratch: string;
  let appDataDir: string;
  let manager: InstanceType<typeof AppFilesManager>;

  const writeCompose = async (volumes: Array<Record<string, unknown>>) => {
    const installed = path.join(scratch, 'data', 'apps', 'ci-marketplace', 'uptime-kuma');
    await fs.promises.mkdir(installed, { recursive: true });
    await fs.promises.writeFile(
      path.join(installed, 'docker-compose.json'),
      JSON.stringify({
        schemaVersion: 2,
        services: [{ name: 'uptime-kuma', image: 'louislam/uptime-kuma:2', isMain: true, internalPort: 3001, volumes }],
      }),
    );
  };

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'volume-dirs-'));
    appDataDir = path.join(scratch, 'app-data', 'ci-marketplace', 'uptime-kuma');
    await fs.promises.mkdir(appDataDir, { recursive: true });
    const logger = mock<LoggerService>();
    const configuration = mock<ConfigurationService>();
    configuration.getConfig.mockReturnValue({
      directories: { dataDir: path.join(scratch, 'data'), appDataDir: path.join(scratch, 'app-data') },
    } as never);
    manager = new AppFilesManager(configuration, new FilesystemService(logger), logger);
  });

  afterEach(async () => {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  it('makes each missing bind-mount folder as the Hub', async () => {
    await writeCompose([
      { hostPath: '${APP_DATA_DIR}/data', containerPath: '/app/data' },
      { hostPath: '${APP_DATA_DIR}/data/db', containerPath: '/var/lib/mysql' },
    ]);

    await manager.createVolumeHostDirs(appUrn);

    for (const folder of ['data', 'data/db']) {
      const stat = await fs.promises.stat(path.join(appDataDir, folder));
      expect(stat.isDirectory()).toBe(true);
      expect(stat.uid).toBe(process.getuid?.());
    }
  });

  it('leaves a folder that exists, and what is in it, as it is', async () => {
    await writeCompose([{ hostPath: '${APP_DATA_DIR}/data', containerPath: '/app/data' }]);
    await fs.promises.mkdir(path.join(appDataDir, 'data'));
    await fs.promises.writeFile(path.join(appDataDir, 'data', 'kuma.db'), 'monitors');
    await fs.promises.chmod(path.join(appDataDir, 'data'), 0o750);

    await manager.createVolumeHostDirs(appUrn);

    await expect(fs.promises.readFile(path.join(appDataDir, 'data', 'kuma.db'), 'utf8')).resolves.toBe('monitors');
    expect((await fs.promises.stat(path.join(appDataDir, 'data'))).mode & 0o777).toBe(0o750);
  });

  it.skipIf(process.platform === 'win32')('starts a private volume at 700', async () => {
    await writeCompose([{ hostPath: '${APP_DATA_DIR}/data/secrets', containerPath: '/run/secrets', private: true }]);

    await manager.createVolumeHostDirs(appUrn);

    expect((await fs.promises.stat(path.join(appDataDir, 'data', 'secrets'))).mode & 0o777).toBe(0o700);
  });

  it('SECURITY: makes nothing outside the app data folder, including a sibling whose name starts the same', async () => {
    await writeCompose([
      { hostPath: '${APP_DATA_DIR}/../other-app/data', containerPath: '/x' },
      { hostPath: '${APP_DATA_DIR}-evil/data', containerPath: '/y' },
      { hostPath: path.join(scratch, 'outside'), containerPath: '/z' },
    ]);

    await manager.createVolumeHostDirs(appUrn);

    await expect(fs.promises.access(path.join(scratch, 'app-data', 'ci-marketplace', 'other-app'))).rejects.toThrow();
    await expect(fs.promises.access(`${appDataDir}-evil`)).rejects.toThrow();
    await expect(fs.promises.access(path.join(scratch, 'outside'))).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'SECURITY: neither makes nor opens anything through a link a restored backup left in the data',
    async () => {
      // A backup may hold links below the top of app-data. Followed, `data/secrets -> <elsewhere>` would
      // have the private chmod close a folder of the Hub's, and `data/up -> <elsewhere>` the mkdir make one there.
      const elsewhere = path.join(scratch, 'elsewhere');
      await fs.promises.mkdir(elsewhere, { mode: 0o755 });
      await fs.promises.chmod(elsewhere, 0o755);
      await fs.promises.mkdir(path.join(appDataDir, 'data'));
      await fs.promises.symlink(elsewhere, path.join(appDataDir, 'data', 'secrets'));
      await fs.promises.symlink(elsewhere, path.join(appDataDir, 'data', 'up'));
      await writeCompose([
        { hostPath: '${APP_DATA_DIR}/data/secrets', containerPath: '/run/secrets', private: true },
        { hostPath: '${APP_DATA_DIR}/data/up/db', containerPath: '/var/lib/db' },
      ]);

      await manager.createVolumeHostDirs(appUrn);

      expect((await fs.promises.stat(elsewhere)).mode & 0o777).toBe(0o755);
      await expect(fs.promises.readdir(elsewhere)).resolves.toEqual([]);
      expect((await fs.promises.lstat(path.join(appDataDir, 'data', 'secrets'))).isSymbolicLink()).toBe(true);
    },
  );

  it('does nothing for an app with no manifest', async () => {
    await expect(manager.createVolumeHostDirs(appUrn)).resolves.toBeUndefined();
    await expect(fs.promises.readdir(appDataDir)).resolves.toEqual([]);
  });
});
