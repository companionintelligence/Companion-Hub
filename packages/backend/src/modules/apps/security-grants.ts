import path from 'node:path';
import { type AppSecurityGrants, TRUSTED_APP_SECURITY_ALLOWLIST } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { resolveAppDataHostRoot } from '@/common/helpers/app-data-path.helper';
import { isOfficialStoreApp } from './official-store.predicate';

/** The store slug custom apps (and port-expose workloads) install under: written on this Hub. */
const CUSTOM_APP_STORE_SLUG = '_user';

export type ComposeAuthor = NonNullable<AppSecurityGrants['hostBindAuthor']>;

/**
 * This Hub's own folders on the host, which no app may bind: the data root (`ROOT_FOLDER_HOST`,
 * every app's data and the Hub's state), the folder that holds it (the install folder, where the
 * Hub's `.env` and the tunnel credentials sit in both the from-source and the packaged layout), and
 * the app-data root when `CI_HUB_APP_DATA_PATH` moved it elsewhere. The check denies each one's
 * ancestors as well, so `/home/<user>/ci-hub` also closes `/home/<user>`.
 *
 * Read from the environment the Hub loaded at boot (`/data/.env`), the same values compose
 * generation uses.
 */
export function hubProtectedHostPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths = new Set<string>();
  const root = env.ROOT_FOLDER_HOST?.trim();
  if (root && path.posix.isAbsolute(root.replace(/\\/g, '/'))) {
    paths.add(root);
    const parent = path.posix.dirname(root.replace(/\\/g, '/'));
    if (parent !== '/') paths.add(parent);
    try {
      paths.add(resolveAppDataHostRoot({ ciHubAppDataPath: env.CI_HUB_APP_DATA_PATH, appDataPath: env.CI_HUB_APP_DATA_PATH, rootFolderHost: root }));
    } catch {
      // A relative app-data path fails compose generation on its own; nothing more to protect.
    }
  }
  return [...paths];
}

/** One object per distinct context, so `dynamicComposeUnionFor`'s per-grants schema cache keeps hitting. */
const grantsCache = new Map<string, AppSecurityGrants>();

/**
 * The sandbox context a compose check applies to an app: its audited grants, who wrote the compose,
 * and this Hub's protected folders.
 *
 * Only an official store app can hold a grant, under the same provenance gate the compose builder
 * uses, and the grant is read under the same name, so the parse and the install sink agree.
 *
 * The author comes from install provenance (the URN's store segment), never from the manifest: an
 * app installed from any store is a `listing` and binds only its own data folder; a custom app
 * (`_user`) is the `operator`'s. A per-app override is written by someone on this Hub whatever store
 * the app came from, so its check passes `author: 'operator'`.
 */
export function securityGrantsFor(appUrn: AppUrn | string, options: { author?: ComposeAuthor } = {}): AppSecurityGrants {
  let appName: string | undefined;
  let storeSlug: string | undefined;
  try {
    ({ appName, appStoreId: storeSlug } = extractAppUrn(appUrn as AppUrn));
  } catch {
    // A malformed URN gets the strictest rule below.
  }

  const allowlisted =
    appName !== undefined && isOfficialStoreApp({ urn: appUrn as AppUrn }) && Object.hasOwn(TRUSTED_APP_SECURITY_ALLOWLIST, appName);
  const grantKey = allowlisted ? appName : undefined;
  const author: ComposeAuthor = options.author ?? (storeSlug === CUSTOM_APP_STORE_SLUG ? 'operator' : 'listing');
  const protectedHostPaths = hubProtectedHostPaths();

  const cacheKey = JSON.stringify([grantKey ?? null, author, protectedHostPaths]);
  let grants = grantsCache.get(cacheKey);
  if (!grants) {
    grants = Object.freeze({
      ...(grantKey ? TRUSTED_APP_SECURITY_ALLOWLIST[grantKey] : {}),
      hostBindAuthor: author,
      protectedHostPaths: Object.freeze(protectedHostPaths),
    });
    grantsCache.set(cacheKey, grants);
  }
  return grants;
}
