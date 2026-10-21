import type { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';
import type { DockerService } from './docker.service';

type AppDataRemovalDeps = {
  filesystem: Pick<FilesystemService, 'removeDirectoryDetailed'>;
  docker: Pick<DockerService, 'removeAppDataDirAsRoot'>;
  logger: Pick<LoggerService, 'warn' | 'error'>;
};

/**
 * Deletes an app's data folder for a step that is about to write new data into it (Reset app, a
 * restore, an update rollback), going to the root helper when the Hub cannot.
 *
 * A Hub on a native Linux host runs as the host user. An app's container writes its data as
 * whoever it runs as: Uptime Kuma as root, MariaDB as uid 999. The Hub cannot delete that data, even
 * where it can read it. {@link DockerService.removeAppDataDirAsRoot} empties the folder as root (uninstall uses it
 * the same way) and the Hub removes the empty folder itself.
 *
 * @returns whether none of the old data is left: the folder is gone, or the helper emptied it. On
 * `false` the folder may be half emptied; the caller must not write new data over what is left.
 */
export async function removeAppDataDirWithRootFallback(deps: AppDataRemovalDeps, appUrn: AppUrn, appDataDir: string): Promise<boolean> {
  const first = await deps.filesystem.removeDirectoryDetailed(appDataDir);

  if (first.removed) {
    return true;
  }

  if (!first.permissionDenied) {
    return false;
  }

  deps.logger.warn(`The Hub cannot delete some of the data of ${appUrn} (its container wrote it as another user); emptying it as root`);

  if (!(await deps.docker.removeAppDataDirAsRoot(appUrn))) {
    deps.logger.error(`Could not delete the data of ${appUrn}, as the Hub or as root`);
    return false;
  }

  // The helper keeps the folder itself, now empty. Whatever comes next writes into it either way, so removing it is only tidying.
  await deps.filesystem.removeDirectoryDetailed(appDataDir);
  return true;
}
