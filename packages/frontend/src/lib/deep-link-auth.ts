export interface DesktopPortalAuthPayload {
  token?: string;
  error?: string;
}

const PENDING_DESKTOP_PORTAL_TOKEN_KEY = 'ci-hub.pending-desktop-portal-token';

export function persistDesktopPortalToken(token: string): void {
  try {
    sessionStorage.setItem(PENDING_DESKTOP_PORTAL_TOKEN_KEY, token);
  } catch {
    // sessionStorage unavailable — exchange still proceeds from the live payload.
  }
}

export function takePersistedDesktopPortalToken(): string | null {
  try {
    const token = sessionStorage.getItem(PENDING_DESKTOP_PORTAL_TOKEN_KEY)?.trim();
    return token || null;
  } catch {
    return null;
  }
}

export function clearPersistedDesktopPortalToken(): void {
  try {
    sessionStorage.removeItem(PENDING_DESKTOP_PORTAL_TOKEN_KEY);
  } catch {
    // ignore
  }
}

function normalizeDesktopPortalAuthPayload(payload: DesktopPortalAuthPayload | null | undefined): DesktopPortalAuthPayload | null {
  const token = payload?.token?.trim();
  const error = payload?.error?.trim();

  if (error) {
    return { error };
  }

  if (!token) {
    return null;
  }

  return { token };
}

export async function takePendingDesktopPortalAuth(): Promise<DesktopPortalAuthPayload | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return null;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const payload = await invoke<DesktopPortalAuthPayload | null>('consume_pending_portal_auth');
    return normalizeDesktopPortalAuthPayload(payload);
  } catch {
    return null;
  }
}
