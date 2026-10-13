import path from 'node:path';

/**
 * A user's home folder, going by the shape of the path alone and ignoring letter case:
 *
 * - `/root`, `/home/<name>`, and `/var/home/<name>`, where Fedora Atomic keeps them (Linux)
 * - `/Users/<name>` (macOS)
 * - `<drive>:\Users\<name>` (Windows), and the same folder as a WSL2 engine names it,
 *   `/mnt/<drive>/Users/<name>`, and as Docker Desktop and Git Bash do, `/<drive>/Users/<name>`
 *
 * The Hub container can't ask the host where home is or look at the host's folders, so the path is
 * all it has. `cihub reset` runs on the host and compares real paths with the real home folder
 * instead (`scripts/lib/cli-teardown.ts`).
 */
const HOME_FOLDER_SHAPES = [/^\/root$/, /^(\/var)?\/home\/[^/]+$/, /^([a-z]:|\/mnt\/[a-z]|\/[a-z])?\/users\/[^/]+$/];

/** `folder` with forward slashes, `.` and `..` worked out, no slash at the end, in lower case. */
function normalizeFolder(folder: string): string {
  const normalized = path.posix.normalize(folder.trim().replace(/\\/g, '/'));

  return (normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized).toLowerCase();
}

/** Whether `folder` is a user's home folder by its shape. See {@link HOME_FOLDER_SHAPES}. */
export function isHomeFolder(folder: string): boolean {
  const normalized = normalizeFolder(folder);

  return HOME_FOLDER_SHAPES.some((shape) => shape.test(normalized));
}

/** Whether `folder` is `/` or a user's home folder (see {@link isHomeFolder}). */
export function isTopOrHomeFolder(folder: string): boolean {
  return normalizeFolder(folder) === '/' || isHomeFolder(folder);
}
