import { type AppSecurityGrants, TRUSTED_APP_SECURITY_ALLOWLIST } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { isOfficialStoreApp } from './official-store.predicate';

/**
 * The sandbox grants a compose parse may honour for an app. Only an official store app can hold a
 * grant, under the same provenance gate the compose builder uses, and the grant is read under the
 * same name, so the parse and the install sink agree. Anything else gets `undefined`: the strict rule.
 */
export function securityGrantsFor(appUrn: AppUrn | string): AppSecurityGrants | undefined {
  if (!isOfficialStoreApp({ urn: appUrn as AppUrn })) return undefined;

  const { appName } = extractAppUrn(appUrn as AppUrn);
  return Object.hasOwn(TRUSTED_APP_SECURITY_ALLOWLIST, appName) ? TRUSTED_APP_SECURITY_ALLOWLIST[appName] : undefined;
}
