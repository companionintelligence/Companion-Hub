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
 * ⚠ THE RULE IS "SAFE PATH SEGMENT", NOT AN ALPHABET, because the alphabet does
 * not match what this system actually mints:
 *
 *   - `_user` is the built-in per-user store slug (`RESERVED_APP_STORE_SLUGS`,
 *     `APPS_FOLDER`) every custom app and port-expose workload is filed under, so
 *     demanding an alphanumeric first character rejects `<app>:_user` — every
 *     route the custom-app UI calls.
 *   - `AppStoreService.createAppStore` derives a store slug with `slugify(name,
 *     { lower: true, trim: true })`, and *without* `strict: true` slugify keeps
 *     `( ) : ! + $ * @ ~ _ .` — so a store a user named "Store (beta)" is really
 *     stored as `store-(beta)`. An alphabet of `[a-zA-Z0-9._-]` orphans every app
 *     in it.
 *
 * So the test is the property that actually matters, and the characters that are
 * genuinely dangerous are named individually:
 *
 *   - a path separator (`/`, and `\` for the Windows convention) or a NUL would
 *     let a half address a file outside the directory built from it;
 *   - a LEADING `.` is what makes `.` and `..`, the traversal names themselves;
 *   - a LEADING `-` is read as a flag by most of the tools these paths reach;
 *   - whitespace is never in a minted name and splits an unquoted word.
 *
 * Everything else is an ordinary, inert filename character.
 */
const APP_URN_SEGMENT = /^[^.\-\s/\\\0][^\s/\\\0]*$/;

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
