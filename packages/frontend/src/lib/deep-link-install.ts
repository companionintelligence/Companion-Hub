const PENDING_INSTALL_INTENT_KEY = 'ci-hub.pending-install-intent';

export const DEFAULT_INSTALL_STORE_ID = 'ci-marketplace';

export type InstallIntent = {
  appSlug: string;
  storeId: string;
  deviceId?: string | null;
};

function normalizeInstallIntent(raw: Partial<InstallIntent> | null | undefined): InstallIntent | null {
  const appSlug = raw?.appSlug?.trim();
  if (!appSlug) {
    return null;
  }

  const storeId = raw?.storeId?.trim() || DEFAULT_INSTALL_STORE_ID;

  return {
    appSlug,
    storeId,
    deviceId: raw?.deviceId?.trim() || null,
  };
}

export function stashPendingInstallIntent(intent: InstallIntent) {
  const normalized = normalizeInstallIntent(intent);
  if (!normalized) {
    return;
  }
  sessionStorage.setItem(PENDING_INSTALL_INTENT_KEY, JSON.stringify(normalized));
}

export function peekStashedInstallIntent(): InstallIntent | null {
  const raw = sessionStorage.getItem(PENDING_INSTALL_INTENT_KEY);
  if (!raw) {
    return null;
  }

  try {
    return normalizeInstallIntent(JSON.parse(raw) as InstallIntent);
  } catch {
    return null;
  }
}

export function takeStashedInstallIntent(): InstallIntent | null {
  const intent = peekStashedInstallIntent();
  if (!intent) {
    return null;
  }
  sessionStorage.removeItem(PENDING_INSTALL_INTENT_KEY);
  return intent;
}

export function clearStashedInstallIntentForApp(appSlug: string, storeId: string) {
  const pending = peekStashedInstallIntent();
  if (pending?.appSlug === appSlug && pending.storeId === storeId) {
    sessionStorage.removeItem(PENDING_INSTALL_INTENT_KEY);
  }
}

export async function takePendingInstallIntentFromDesktop(): Promise<InstallIntent | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return null;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const payload = await invoke<{ appSlug?: string; storeId?: string; deviceId?: string | null } | null>('consume_pending_install_intent');
    return normalizeInstallIntent(payload ?? undefined);
  } catch {
    return null;
  }
}

export async function resolvePendingInstallIntent(): Promise<InstallIntent | null> {
  return (await takePendingInstallIntentFromDesktop()) ?? takeStashedInstallIntent();
}

/**
 * Forget the link that asked to install this app, wherever it left a copy, once the app's page has
 * acted on it.
 *
 * The desktop shell parks every install link as well as emitting it, and nothing else empties that
 * slot. A copy left there sent the next page load back to this app with the install dialog open.
 */
export async function forgetInstallIntentForApp(appSlug: string, storeId: string): Promise<void> {
  clearStashedInstallIntentForApp(appSlug, storeId);
  const parked = await takePendingInstallIntentFromDesktop();
  if (parked && (parked.appSlug !== appSlug || parked.storeId !== storeId)) {
    // A link for another app arrived meanwhile: keep it for that app's page.
    stashPendingInstallIntent(parked);
  }
}

export function buildInstallIntentPath(intent: InstallIntent): string {
  return `/store/${encodeURIComponent(intent.storeId)}/${encodeURIComponent(intent.appSlug)}?install=1`;
}

export function shouldAutoOpenInstall(appSlug: string, storeId: string, search: string): boolean {
  if (new URLSearchParams(search).get('install') === '1') {
    return true;
  }

  const pending = peekStashedInstallIntent();
  return pending?.appSlug === appSlug && pending.storeId === storeId;
}
