import type { AppCommandDeadline } from '@/common/helpers/app-command-deadline';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { DockerService } from '@/modules/docker/docker.service';
import type { AppUrn } from '@ci-hub/common/types';

/**
 * Remove an app's data folder for good, as an uninstall or a cancelled install does. The Hub cannot
 * delete what a container wrote as another user (MinIO's `.minio.sys`, a MariaDB data folder), so a
 * permission error goes to the root helper. When even that leaves the folder behind, `hostPath` is
 * where it is on the host, for the manual `rm` the page can show.
 */
export async function removeAppDataWithPrivilegedFallback(
  appFilesManager: AppFilesManager,
  dockerService: DockerService,
  logger: LoggerService,
  appUrn: AppUrn,
  deadline?: AppCommandDeadline,
): Promise<{ removed: boolean; hostPath?: string }> {
  const first = await appFilesManager.deleteAppDataDirDetailed(appUrn);
  if (first.removed) {
    return { removed: true };
  }

  // The host path is only for the manual `rm` command, so failing to resolve it must never turn the
  // outcome into a failure. getAppDataHostDir throws on a non-absolute ROOT_FOLDER_HOST; that gives
  // the generic remnant warning.
  let hostPath: string | undefined;
  try {
    hostPath = appFilesManager.getAppDataHostDir(appUrn);
  } catch (err) {
    logger.warn(
      `App ${appUrn}: could not resolve host app-data path for manual-cleanup guidance: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Root won't get past anything else, so only a permission error is worth the helper.
  if (!first.permissionDenied) {
    return { removed: false, hostPath };
  }

  logger.warn(`App ${appUrn} app-data not removable as non-root; attempting a privileged cleanup of ${hostPath ?? 'its data directory'}`);
  const emptied = await dockerService.removeAppDataDirAsRoot(appUrn, deadline);
  // The helper only empties the folder (never the mountpoint), so the Hub still removes the empty
  // folder itself, which also checks the result from the Hub's own view.
  if (emptied && (await appFilesManager.deleteAppDataDir(appUrn))) {
    logger.info(`App ${appUrn} app-data removed via privileged cleanup`);
    return { removed: true };
  }

  return { removed: false, hostPath };
}
