import type { AppUrn } from '@ci-hub/common/types';

export const extractAppUrn = (id: AppUrn) => {
  const separatorIndex = id.indexOf(':');
  if (separatorIndex === -1) {
    throw new Error(`Invalid App URN: ${id}`);
  }
  const appName = id.substring(0, separatorIndex);
  const appStoreId = id.substring(separatorIndex + 1);

  if (!appStoreId || !appName) {
    throw new Error(`Invalid App URN: ${id}`);
  }

  return { appName, appStoreId };
};

export const createAppUrn = (appName: string, appstore: string) => {
  return `${appName}:${appstore}` as AppUrn;
};

/**
 * The shape both halves of an app URN must have.
 *
 * ⚠ AN APP URN IS TWO PATH SEGMENTS, and it is used as such. `extractAppUrn`
 * splits it and callers join the halves straight into filesystem paths —
 * `path.join(dataDir, 'backups', appStoreId, appName)` in the backup manager,
 * app data directories, compose files. `castAppUrn` checked only that a colon
 * was present, so `../../..:x` was a valid URN as far as this function was
 * concerned and traversed as far as the caller's own fencing allowed.
 *
 * Deliberately narrower than "no separators": an app name and a store id are
 * both slugs by construction everywhere they are minted, so anything outside
 * this alphabet is a caller doing something other than naming an app.
 */
const APP_URN_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Turn caller-supplied text into an `AppUrn`, or throw.
 *
 * ⚠ THIS IS A VALIDATOR, NOT A CAST, and it was only the latter. Route
 * parameters reach it directly (`@Param('urn')`), so it is the boundary between
 * a request and every path this system builds from an app's identity.
 *
 * Rejected rather than sanitised: silently rewriting an id would act on an app
 * the caller did not name.
 */
export const castAppUrn = (id: string): AppUrn => {
  const separatorIndex = id.indexOf(':');
  if (separatorIndex === -1) {
    throw new Error(`Invalid namespaced app id: ${id}`);
  }

  const appName = id.substring(0, separatorIndex);
  const appStoreId = id.substring(separatorIndex + 1);

  if (!APP_URN_SEGMENT.test(appName) || !APP_URN_SEGMENT.test(appStoreId)) {
    throw new Error(`Invalid namespaced app id: ${id}`);
  }

  return id as AppUrn;
};
