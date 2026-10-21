import os from 'node:os';
import path from 'node:path';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { DockerService } from '@/modules/docker/docker.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import type { AppUrn } from '@ci-hub/common/types';

// Real files with real permission bits: the suite's memfs mock cannot refuse a delete, which is how a
// reset that left a root container's data in place and still said "reset successfully" went unnoticed.
vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { FilesystemService } = await import('@/core/filesystem/filesystem.service');
const { AppFilesManager } = await import('@/modules/apps/app-files-manager');
const { ResetAppCommand } = await import('../reset-app-command');

// root ignores permission bits and Windows has none to speak of; there the Hub can delete anything.
const canEnforcePermissions = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

/** Give the owner back write access everywhere under `dir`, as root would not need, so it can be deleted. */
async function loosen(dir: string): Promise<void> {
  const stat = await fs.promises.lstat(dir).catch(() => null);
  if (!stat?.isDirectory()) return;
  await fs.promises.chmod(dir, 0o755).catch(() => undefined);
  for (const name of await fs.promises.readdir(dir).catch(() => [] as string[])) {
    await loosen(path.join(dir, name));
  }
}

/*
 * After a first Reset, Uptime Kuma's container (it runs as root) re-creates `data/` as root:root 755
 * with `kuma.db` in it. The Hub, a plain user on a native Linux host, cannot delete that, so the next
 * Reset kept the old database and still reported success. A folder the test cannot write stands in
 * for the root-owned one.
 */
describe.skipIf(!canEnforcePermissions)('ResetAppCommand on data the Hub cannot delete', () => {
  const appUrn = 'uptime-kuma:ci-marketplace' as AppUrn;
  let scratch: string;
  let appDataDir: string;
  let docker: ReturnType<typeof mock<DockerService>>;
  let command: InstanceType<typeof ResetAppCommand>;

  const kumaDb = () => path.join(appDataDir, 'data', 'kuma.db');

  beforeEach(async () => {
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'reset-'));
    appDataDir = path.join(scratch, 'app-data', 'ci-marketplace', 'uptime-kuma');
    await fs.promises.mkdir(path.join(appDataDir, 'data', 'docker-tls'), { recursive: true });
    await fs.promises.writeFile(kumaDb(), 'monitors and users');
    await fs.promises.writeFile(path.join(appDataDir, 'data', 'docker-tls', 'ca.pem'), 'cert');
    await fs.promises.chmod(path.join(appDataDir, 'data', 'docker-tls'), 0o555);
    await fs.promises.chmod(path.join(appDataDir, 'data'), 0o555);

    const logger = mock<LoggerService>();
    const configuration = mock<ConfigurationService>();
    configuration.getConfig.mockReturnValue({
      directories: { dataDir: path.join(scratch, 'data'), appDataDir: path.join(scratch, 'app-data') },
    } as never);
    const filesystem = new FilesystemService(logger);
    const appFilesManager = new AppFilesManager(configuration, filesystem, logger);
    const envUtils = mock<EnvUtils>();
    envUtils.envStringToMap.mockReturnValue(new Map() as never);
    docker = mock<DockerService>();

    const services = new Map<unknown, unknown>([
      [LoggerService, logger],
      [AppFilesManager, appFilesManager],
      [DockerService, docker],
      [MarketplaceService, mock<MarketplaceService>()],
      [AppHelpers, mock<AppHelpers>()],
      [EnvUtils, envUtils],
      [FilesystemService, filesystem],
    ]);
    const moduleRef = mock<ModuleRef>();
    moduleRef.get.mockImplementation(((token: unknown) => services.get(token)) as never);

    command = new ResetAppCommand(moduleRef, {} as Dockerode);
    (command as unknown as { ensureAppDir: () => Promise<void> }).ensureAppDir = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await loosen(scratch);
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  it('empties it through the root helper, so the app really starts over', async () => {
    // What `find /target -mindepth 1 -delete` does as root: the contents go, the folder stays.
    docker.removeAppDataDirAsRoot.mockImplementation(async () => {
      await loosen(appDataDir);
      for (const name of await fs.promises.readdir(appDataDir)) {
        await fs.promises.rm(path.join(appDataDir, name), { recursive: true, force: true });
      }
      return true;
    });

    const result = await command.execute(appUrn, {});

    expect(result).toEqual({ success: true, message: `App ${appUrn} reset successfully` });
    expect(docker.removeAppDataDirAsRoot).toHaveBeenCalledWith(appUrn);
    await expect(fs.promises.access(kumaDb())).rejects.toThrow();
    await expect(fs.promises.readdir(appDataDir)).resolves.toEqual([]);
  });

  // Docker would otherwise create `data/` as root again when the app starts, and every later reset,
  // restore or backup of it would need the root helper.
  it('makes the bind-mount folders again as the Hub, so the next reset needs no root helper', async () => {
    const installed = path.join(scratch, 'data', 'apps', 'ci-marketplace', 'uptime-kuma');
    await fs.promises.mkdir(installed, { recursive: true });
    await fs.promises.writeFile(
      path.join(installed, 'docker-compose.json'),
      JSON.stringify({
        schemaVersion: 2,
        services: [
          {
            name: 'uptime-kuma',
            image: 'louislam/uptime-kuma:2',
            isMain: true,
            internalPort: 3001,
            volumes: [{ hostPath: '${APP_DATA_DIR}/data', containerPath: '/app/data' }],
          },
        ],
      }),
    );
    docker.removeAppDataDirAsRoot.mockImplementation(async () => {
      await loosen(appDataDir);
      for (const name of await fs.promises.readdir(appDataDir)) {
        await fs.promises.rm(path.join(appDataDir, name), { recursive: true, force: true });
      }
      return true;
    });

    await expect(command.execute(appUrn, {})).resolves.toMatchObject({ success: true });

    const data = await fs.promises.stat(path.join(appDataDir, 'data'));
    expect(data.isDirectory()).toBe(true);
    expect(data.uid).toBe(process.getuid?.());

    // What the app writes into a folder the Hub owns, the Hub can delete itself.
    await fs.promises.writeFile(kumaDb(), 'written after the reset');
    docker.removeAppDataDirAsRoot.mockClear();
    await expect(command.execute(appUrn, {})).resolves.toMatchObject({ success: true });
    expect(docker.removeAppDataDirAsRoot).not.toHaveBeenCalled();
    await expect(fs.promises.access(kumaDb())).rejects.toThrow();
  });

  it('says the reset failed, rather than that it worked, when the helper cannot remove the data either', async () => {
    docker.removeAppDataDirAsRoot.mockResolvedValue(false);

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain(`Could not delete the data of ${appUrn}, so it was not reset`);
    await expect(fs.promises.readFile(kumaDb(), 'utf8')).resolves.toBe('monitors and users');
  });

  it('does not call the helper when the Hub can delete the data itself', async () => {
    await loosen(appDataDir);

    const result = await command.execute(appUrn, {});

    expect(result.success).toBe(true);
    expect(docker.removeAppDataDirAsRoot).not.toHaveBeenCalled();
    await expect(fs.promises.access(kumaDb())).rejects.toThrow();
  });
});
