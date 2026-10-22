import { mock } from 'vitest-mock-extended';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';
import { removeAppDataDirWithRootFallback } from '../app-data-removal';
import type { DockerService } from '../docker.service';

describe('removeAppDataDirWithRootFallback', () => {
  const appUrn = 'uptime-kuma:ci-marketplace' as AppUrn;
  const appDataDir = '/app-data/ci-marketplace/uptime-kuma';
  let filesystem: ReturnType<typeof mock<FilesystemService>>;
  let docker: ReturnType<typeof mock<DockerService>>;
  let logger: ReturnType<typeof mock<LoggerService>>;

  const run = () => removeAppDataDirWithRootFallback({ filesystem, docker, logger }, appUrn, appDataDir);

  beforeEach(() => {
    filesystem = mock<FilesystemService>();
    docker = mock<DockerService>();
    logger = mock<LoggerService>();
  });

  it('is done when the Hub can delete the data itself', async () => {
    filesystem.removeDirectoryDetailed.mockResolvedValue({ removed: true, permissionDenied: false });

    await expect(run()).resolves.toBe(true);
    expect(docker.removeAppDataDirAsRoot).not.toHaveBeenCalled();
  });

  it('empties it as root on a permission error, then removes the empty folder', async () => {
    filesystem.removeDirectoryDetailed
      .mockResolvedValueOnce({ removed: false, permissionDenied: true })
      .mockResolvedValue({ removed: true, permissionDenied: false });
    docker.removeAppDataDirAsRoot.mockResolvedValue(true);

    await expect(run()).resolves.toBe(true);
    expect(docker.removeAppDataDirAsRoot).toHaveBeenCalledWith(appUrn);
    expect(filesystem.removeDirectoryDetailed).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('counts an emptied folder as done even when the Hub cannot remove the folder itself', async () => {
    filesystem.removeDirectoryDetailed.mockResolvedValue({ removed: false, permissionDenied: true });
    filesystem.listFiles.mockResolvedValue([]);
    filesystem.findUnreadable.mockResolvedValue([]);
    docker.removeAppDataDirAsRoot.mockResolvedValue(true);

    await expect(run()).resolves.toBe(true);
  });

  // `listFiles` says `[]` for a folder it cannot read too, which proves nothing about what is in it.
  it('fails when the Hub cannot list the folder to see that it is empty', async () => {
    filesystem.removeDirectoryDetailed.mockResolvedValue({ removed: false, permissionDenied: true });
    filesystem.listFiles.mockResolvedValue([]);
    filesystem.findUnreadable.mockResolvedValue([appDataDir]);
    docker.removeAppDataDirAsRoot.mockResolvedValue(true);

    await expect(run()).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`cannot list ${appDataDir}`));
  });

  // The helper mounts the host path it works out from the settings. If that is not the folder the Hub
  // sees, the helper "succeeds" and the old data is still here.
  it('fails when the helper reported success but the Hub still sees data in the folder', async () => {
    filesystem.removeDirectoryDetailed.mockResolvedValue({ removed: false, permissionDenied: true });
    filesystem.listFiles.mockResolvedValue(['data']);
    docker.removeAppDataDirAsRoot.mockResolvedValue(true);

    await expect(run()).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`${appDataDir} still holds data`));
  });

  it('fails and says so when root cannot delete it either', async () => {
    filesystem.removeDirectoryDetailed.mockResolvedValue({ removed: false, permissionDenied: true });
    docker.removeAppDataDirAsRoot.mockResolvedValue(false);

    await expect(run()).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(`Could not delete the data of ${appUrn}, as the Hub or as root`);
  });

  it('does not ask root about a failure that is not about permissions', async () => {
    filesystem.removeDirectoryDetailed.mockResolvedValue({ removed: false, permissionDenied: false });

    await expect(run()).resolves.toBe(false);
    expect(docker.removeAppDataDirAsRoot).not.toHaveBeenCalled();
  });
});
