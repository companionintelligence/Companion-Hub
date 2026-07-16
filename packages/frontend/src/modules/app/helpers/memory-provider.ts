import { CI_MARKETPLACE_STORE_ID } from '@/lib/portal-store';

/** App-directory name of the first-party Companion Memory provider. */
export const CI_MEMORY_APP_NAME = 'ci-memory';

/**
 * Whether an app URN is the trusted Companion Memory provider. Mirrors the
 * backend predicate (`isMemoryProviderApp`): the provider is `ci-memory`
 * installed from the official CI-Marketplace store. Advisory only — the backend
 * remains authoritative — this just drives the extra uninstall/reset gating in
 * the UI so the shared provider isn't torn down out from under its consumers.
 */
export function isMemoryProviderUrn(urn: string): boolean {
  const separatorIndex = urn.indexOf(':');
  if (separatorIndex === -1) {
    return false;
  }

  const appName = urn.slice(0, separatorIndex);
  const appStoreId = urn.slice(separatorIndex + 1);

  return appName === CI_MEMORY_APP_NAME && appStoreId === CI_MARKETPLACE_STORE_ID;
}
