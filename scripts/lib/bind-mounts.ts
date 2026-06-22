/** Hub data directories bind-mounted from ROOT_FOLDER_HOST into the container. */
export const BIND_MOUNT_DIRS = ['cache', 'state', 'logs', 'apps', 'media', 'repos', 'app-data', 'user-config', 'backups', '.docker'] as const;

/** Safe to recreate when permissions are wrong (no user data). */
export const RECREATABLE_BIND_MOUNT_DIRS = ['cache', 'logs', 'user-config', '.docker'] as const;

/** Directories that hold user/app data — never delete during heal. */
export const DATA_BEARING_BIND_MOUNT_DIRS = ['apps', 'app-data', 'media', 'repos', 'backups'] as const;

export type BindMountDir = (typeof BIND_MOUNT_DIRS)[number];
