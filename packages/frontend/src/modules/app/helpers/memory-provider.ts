import type { AppUrn } from '@ci-hub/common/types';
import { CI_MARKETPLACE_STORE_ID } from '@/lib/portal-store';
import { extractAppUrn } from '@/utils/app-helpers';

/** App-directory name of the first-party Companion Memory provider. */
export const CI_MEMORY_APP_NAME = 'ci-memory';

/**
 * Whether an app URN is the trusted Companion Memory provider. Mirrors the
 * backend predicate (`isMemoryProviderApp`): the provider is `ci-memory`
 * installed from the official CI-Marketplace store, parsed with the same shared
 * `extractAppUrn` helper. Advisory only — the backend remains authoritative —
 * this just drives the extra uninstall/reset gating in the UI so the shared
 * provider isn't torn down out from under its consumers.
 */
export function isMemoryProviderUrn(urn: string): boolean {
  try {
    const { appName, appStoreId } = extractAppUrn(urn as AppUrn);
    return appName === CI_MEMORY_APP_NAME && appStoreId === CI_MARKETPLACE_STORE_ID;
  } catch {
    // Malformed / missing URN → not the provider.
    return false;
  }
}

/** What the dashboard says for each memory-connect result the Hub's callback can land there with. */
const MEMORY_CONNECT_RESULT_TOASTS: Readonly<Record<string, string>> = {
  error: 'MEMORY_CONNECT_ERROR_TOAST',
  unavailable: 'MEMORY_CONNECT_UNAVAILABLE_TOAST',
  // The connect failed after another person's connection had been revoked for it.
  previous_removed: 'MEMORY_CONNECT_PREVIOUS_REMOVED_TOAST',
  // Connecting restarts the app, and this person may not restart it.
  denied: 'MEMORY_CONNECT_DENIED_TOAST',
  // Another operation held the app, so nothing was revoked or exchanged. The marker names the app.
  busy: 'MEMORY_CONNECT_BUSY_TOAST',
};

/** The toast key for a `?memoryConnect=` marker, or null for one the Hub never sends. */
export function memoryConnectResultToastKey(marker: string | null): string | null {
  return marker && Object.hasOwn(MEMORY_CONNECT_RESULT_TOASTS, marker) ? (MEMORY_CONNECT_RESULT_TOASTS[marker] ?? null) : null;
}

/** An app id shaped like `<name>:<store>`, and nothing else a link could carry. */
const APP_URN_PATTERN = /^[A-Za-z0-9][\w.-]*:[\w.-]+$/;

/** The app a `busy` result names, or null: no other result carries one, and junk is dropped. */
export function memoryConnectResultApp(marker: string | null, app: string | null): string | null {
  return marker === 'busy' && app && APP_URN_PATTERN.test(app) ? app : null;
}

/**
 * The dashboard's toast for a memory-connect result. A `busy` result says which app was busy, by the
 * name the Hub has for it, never by text from the link. Null for a marker the Hub never sends.
 */
export function memoryConnectResultToast(
  marker: string | null,
  app: string | null,
  installed: ReadonlyArray<{ info: { urn: string; name: string } }>,
): { key: string; params?: { name: string } } | null {
  const key = memoryConnectResultToastKey(marker);

  if (key !== 'MEMORY_CONNECT_BUSY_TOAST') {
    return key ? { key } : null;
  }

  const appUrn = memoryConnectResultApp(marker, app);
  const name = appUrn ? installed.find(({ info }) => info.urn === appUrn)?.info.name : undefined;

  return name ? { key, params: { name } } : { key: 'MEMORY_CONNECT_BUSY_TOAST_UNNAMED' };
}
