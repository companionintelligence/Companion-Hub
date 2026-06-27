import path from 'node:path';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import type { AppUrn } from '@ci-hub/common/types';

/**
 * Inputs needed to resolve where an app's data lives on the **host** filesystem.
 *
 * These come from the Hub configuration:
 * - `ciHubAppDataPath` — the `CI_HUB_APP_DATA_PATH` env value (may be unset).
 * - `appDataPath`      — the user-configured `userSettings.appDataPath` (may be unset).
 * - `rootFolderHost`   — the `ROOT_FOLDER_HOST` absolute host path.
 */
export interface AppDataPathInputs {
  ciHubAppDataPath?: string | null;
  appDataPath?: string | null;
  rootFolderHost: string;
}

/**
 * Host paths may be POSIX (`/foo/bar`), Windows drive-letter (`C:/foo`), or UNC
 * (`\\server\share`). The backend often runs in a Linux container, so accept a
 * path that is absolute under either the POSIX or the Windows rules.
 */
export function isAbsoluteHostPath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

/**
 * Resolve a relative `base` against an absolute host `root`. The backend runs on
 * POSIX, but a host root may be Windows/UNC (e.g. `C:\\hub`). Using the default
 * (POSIX) `path.resolve` on a Windows root would prepend the container CWD and
 * produce a corrupt path like `/cwd/C:\hub/...`, so resolve with the path flavor
 * that matches the root.
 */
function resolveAgainstHostRoot(root: string, base: string): string {
  if (path.win32.isAbsolute(root) && !path.posix.isAbsolute(root)) {
    return path.win32.resolve(root, base);
  }
  return path.resolve(root, base);
}

/**
 * Join path segments onto a host `base` using the path flavor that matches the
 * base. The backend runs on POSIX, so the default `path.join` would emit
 * mixed-separator paths like `C:\\hub/app-data/...` for a Windows/UNC base; use
 * `path.win32.join` in that case so the rebuilt host path stays valid for bind
 * mounts and the desktop "open folder" action.
 */
function joinHostPath(base: string, ...segments: string[]): string {
  if (path.win32.isAbsolute(base) && !path.posix.isAbsolute(base)) {
    return path.win32.join(base, ...segments);
  }
  return path.join(base, ...segments);
}

/**
 * Fallback host base used when the resolved path looks like a *container* path
 * rather than a host path. Prefers the configured `rootFolderHost`, then the
 * `ROOT_FOLDER_HOST` env var, and finally `/tmp` as a last resort.
 */
function fallbackHostBase(rootFolderHost: string): string {
  if (isAbsoluteHostPath(rootFolderHost)) {
    return rootFolderHost;
  }
  const envRoot = process.env.ROOT_FOLDER_HOST;
  return envRoot && isAbsoluteHostPath(envRoot) ? envRoot : '/tmp';
}

/**
 * Resolve the absolute host base directory (the parent of `app-data`), applying
 * the same precedence the Hub uses when generating an app's `APP_DATA_DIR`:
 * `CI_HUB_APP_DATA_PATH` → `userSettings.appDataPath` → `ROOT_FOLDER_HOST`.
 *
 * A relative base is resolved against `rootFolderHost` (or `process.env.ROOT_FOLDER_HOST`).
 * Any trailing `app-data` segment is stripped so callers can append it exactly once.
 *
 * @throws if neither the base nor `rootFolderHost` can be resolved to an absolute path.
 */
function resolveHostBase({ ciHubAppDataPath, appDataPath, rootFolderHost }: AppDataPathInputs): string {
  const base = ciHubAppDataPath || appDataPath || rootFolderHost;

  let hostBase: string;
  if (isAbsoluteHostPath(base)) {
    hostBase = base;
  } else if (isAbsoluteHostPath(rootFolderHost)) {
    hostBase = resolveAgainstHostRoot(rootFolderHost, base);
  } else {
    const envRoot = process.env.ROOT_FOLDER_HOST;
    if (envRoot && isAbsoluteHostPath(envRoot)) {
      hostBase = resolveAgainstHostRoot(envRoot, base);
    } else {
      throw new Error(
        'Cannot resolve app data host path: both ROOT_FOLDER_HOST and CI_HUB_APP_DATA_PATH are relative paths. ' +
          'ROOT_FOLDER_HOST must be an absolute path.',
      );
    }
  }

  // If the base already ends with /app-data (or \app-data), drop it so we don't
  // double up when re-appending the segment below.
  if (hostBase.endsWith('/app-data') || hostBase.endsWith('\\app-data')) {
    hostBase = hostBase.slice(0, -'/app-data'.length);
  }

  return hostBase;
}

/**
 * A resolved path is unusable if it is not absolute, or if it looks like a
 * Docker *container* path (`/app-data/...` or `/data/...`) instead of a host path.
 */
function looksLikeContainerPath(resolved: string): boolean {
  return resolved.startsWith('/app-data') || resolved.startsWith('/data/');
}

/**
 * Validate a candidate host path, preserving the exact behavior of the original
 * inline APP_DATA_DIR construction:
 *  - If it looks like a Docker *container* path (`/app-data*`, `/data/*`), rebuild
 *    it under the host fallback base (ROOT_FOLDER_HOST) — this is a recoverable
 *    misconfiguration.
 *  - If it is not absolute at all, throw — a relative path would break Docker
 *    bind mounts and must fail loudly (callers that only need a best-effort value
 *    catch this and treat it as "unavailable").
 *
 * `fallbackSegments` are appended to `{fallbackBase}/app-data` to mirror the
 * original fallback shape (root → [], per-app → [appStoreId, appName]).
 */
function ensureHostPath(candidate: string, rootFolderHost: string, fallbackSegments: string[]): string {
  if (looksLikeContainerPath(candidate)) {
    return joinHostPath(fallbackHostBase(rootFolderHost), 'app-data', ...fallbackSegments);
  }
  if (!isAbsoluteHostPath(candidate)) {
    throw new Error(`App data host path must be absolute, got: ${candidate}`);
  }
  return candidate;
}

/**
 * Resolve the **root** host directory that holds every app's persistent data,
 * i.e. `{base}/app-data`. This is the folder the Settings "Open app data folder"
 * button reveals in the OS file explorer.
 *
 * Note: this is a *host* path (what Docker bind-mounts and what the desktop opener
 * can open), never the in-container `/app-data` path.
 */
export function resolveAppDataHostRoot(inputs: AppDataPathInputs): string {
  const root = joinHostPath(resolveHostBase(inputs), 'app-data');
  return ensureHostPath(root, inputs.rootFolderHost, []);
}

/**
 * Resolve the host data directory for a single app: `{base}/app-data/{appStoreId}/{appName}`.
 *
 * This is the same directory that gets bind-mounted into the app's container as
 * `${APP_DATA_DIR}`, so the "Open data folder" button on the app details page
 * lands exactly where the app persists its data.
 */
export function getAppDataHostPath(appUrn: AppUrn, inputs: AppDataPathInputs): string {
  const { appName, appStoreId } = extractAppUrn(appUrn);
  const final = joinHostPath(resolveHostBase(inputs), 'app-data', appStoreId, appName);
  return ensureHostPath(final, inputs.rootFolderHost, [appStoreId, appName]);
}
