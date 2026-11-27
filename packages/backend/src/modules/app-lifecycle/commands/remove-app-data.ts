import type { AppCommandDeadline } from '@/common/helpers/app-command-deadline';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { DockerService } from '@/modules/docker/docker.service';
import type { AppUrn } from '@ci-hub/common/types';

/**
 * What an uninstall or a cancelled install left behind, for its log line and message: "app folder and app data".
 * A cancelled install whose Compose teardown failed may also leave containers or volumes behind.
 */
export function describeLeftovers({
  folderRemoved,
  dataRemoved,
  userConfigRemoved = true,
  teardownFailed = false,
}: {
  folderRemoved: boolean;
  dataRemoved: boolean;
  userConfigRemoved?: boolean;
  teardownFailed?: boolean;
}): string {
  const parts = [
    folderRemoved ? null : 'app folder',
    dataRemoved ? null : 'app data',
    userConfigRemoved ? null : 'user config',
    teardownFailed ? 'containers or volumes' : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join('');
}

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
  return removeWithPrivilegedFallback(logger, appUrn, {
    what: 'app-data',
    remove: () => appFilesManager.deleteAppDataDirDetailed(appUrn),
    // getAppDataHostDir throws on a non-absolute ROOT_FOLDER_HOST; that gives the generic remnant warning.
    hostPath: () => appFilesManager.getAppDataHostDir(appUrn),
    emptyAsRoot: () => dockerService.removeAppDataDirAsRoot(appUrn, deadline),
    removeEmptied: () => appFilesManager.deleteAppDataDir(appUrn),
  });
}

/**
 * Remove an app's user config folder (its own `docker-compose.yml` and `app.env`), as an uninstall with Delete all
 * data does, the same way as its data: a file the Hub cannot delete goes to the root helper. `hostPath` is where
 * a folder even root left behind is on the host.
 */
export async function removeUserConfigWithPrivilegedFallback(
  appFilesManager: AppFilesManager,
  dockerService: DockerService,
  logger: LoggerService,
  appUrn: AppUrn,
): Promise<{ removed: boolean; hostPath?: string }> {
  return removeWithPrivilegedFallback(logger, appUrn, {
    what: 'user config',
    remove: () => appFilesManager.deleteUserConfigDirDetailed(appUrn),
    hostPath: () => appFilesManager.getUserConfigHostDir(appUrn),
    emptyAsRoot: () => dockerService.removeUserConfigDirAsRoot(appUrn),
    removeEmptied: () => appFilesManager.deleteUserConfigDir(appUrn),
  });
}

async function removeWithPrivilegedFallback(
  logger: LoggerService,
  appUrn: AppUrn,
  folder: {
    /** For the log lines: "app-data", "user config". */
    what: string;
    remove: () => Promise<{ removed: boolean; permissionDenied: boolean }>;
    hostPath: () => string | undefined;
    /** Empties the folder as root, never the folder itself. */
    emptyAsRoot: () => Promise<boolean>;
    removeEmptied: () => Promise<boolean>;
  },
): Promise<{ removed: boolean; hostPath?: string }> {
  const first = await folder.remove();
  if (first.removed) {
    return { removed: true };
  }

  // The host path is only for the manual `rm` command, so failing to resolve it must never turn the
  // outcome into a failure.
  let hostPath: string | undefined;
  try {
    hostPath = folder.hostPath();
  } catch (err) {
    logger.warn(
      `App ${appUrn}: could not resolve host ${folder.what} path for manual-cleanup guidance: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Root won't get past anything else, so only a permission error is worth the helper.
  if (!first.permissionDenied) {
    return { removed: false, hostPath };
  }

  logger.warn(
    `App ${appUrn} ${folder.what} not removable as non-root; attempting a privileged cleanup of ${hostPath ?? `its ${folder.what} folder`}`,
  );
  const emptied = await folder.emptyAsRoot();
  // The helper only empties the folder (never the mountpoint), so the Hub still removes the empty
  // folder itself, which also checks the result from the Hub's own view.
  if (emptied && (await folder.removeEmptied())) {
    logger.info(`App ${appUrn} ${folder.what} removed via privileged cleanup`);
    return { removed: true };
  }

  return { removed: false, hostPath };
}
