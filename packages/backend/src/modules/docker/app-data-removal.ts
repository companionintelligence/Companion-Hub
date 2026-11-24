import type { AppCommandDeadline } from '@/common/helpers/app-command-deadline';
import type { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';
import type { DockerService } from './docker.service';

type AppDataRemovalDeps = {
  filesystem: Pick<FilesystemService, 'removeDirectoryDetailed' | 'listFiles' | 'findUnreadable'>;
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
 * @returns whether none of the old data is left: the folder is gone, or the helper emptied it and the Hub sees it empty. On
 * `false` the folder may be half emptied; the caller must not write new data over what is left.
 */
export async function removeAppDataDirWithRootFallback(
  deps: AppDataRemovalDeps,
  appUrn: AppUrn,
  appDataDir: string,
  deadline?: AppCommandDeadline,
): Promise<boolean> {
  const first = await deps.filesystem.removeDirectoryDetailed(appDataDir);

  if (first.removed) {
    return true;
  }

  if (!first.permissionDenied) {
    return false;
  }

  deps.logger.warn(`The Hub cannot delete some of the data of ${appUrn} (its container wrote it as another user); emptying it as root`);

  if (!(await deps.docker.removeAppDataDirAsRoot(appUrn, deadline))) {
    deps.logger.error(`Could not delete the data of ${appUrn}, as the Hub or as root`);
    return false;
  }

  // The helper keeps the folder itself, now empty. The Hub removes it if it can. One it cannot remove (its
  // parent belongs to another user) is fine while it is empty, since whatever comes next writes into it.
  // The helper works on the host path it derives from the settings, not on the Hub's own mount, so its
  // exit status alone does not prove that this folder is empty.
  if ((await deps.filesystem.removeDirectoryDetailed(appDataDir)).removed) {
    return true;
  }

  const left = await deps.filesystem.listFiles(appDataDir);

  if (left.length > 0) {
    deps.logger.error(`The root helper emptied the data of ${appUrn}, but ${appDataDir} still holds ${left.slice(0, 3).join(', ')}`);
    return false;
  }

  // `listFiles` answers `[]` for a folder it cannot read as well, and that one may still hold the old data.
  if ((await deps.filesystem.findUnreadable(appDataDir, { maxEntries: 1, maxFound: 1 })).length > 0) {
    deps.logger.error(`The root helper emptied the data of ${appUrn}, but the Hub cannot list ${appDataDir} to see that it is empty`);
    return false;
  }

  return true;
}
