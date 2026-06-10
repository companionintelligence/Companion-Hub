export interface DesktopPortalAuthPayload {
  token: string;
}

function normalizeDesktopPortalAuthPayload(payload: DesktopPortalAuthPayload | null | undefined): DesktopPortalAuthPayload | null {
  const token = payload?.token?.trim();

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
