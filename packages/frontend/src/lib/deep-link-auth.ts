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

const USED_DESKTOP_PORTAL_TOKENS_KEY = 'ci-hub.used-desktop-portal-tokens';
/** Only the last few links matter: the Hub forgets a token 60 seconds after issuing it. */
const USED_DESKTOP_PORTAL_TOKENS_LIMIT = 20;

function readUsedDesktopPortalTokens(): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(USED_DESKTOP_PORTAL_TOKENS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((token): token is string => typeof token === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Remember a one-time token the Hub has already answered: exchanged, or refused as used or expired.
 *
 * The same link reaches this page more than once. The desktop shell parks every link for a page
 * that is not listening yet as well as emitting it, handles each link twice on Linux and Windows,
 * and the browser can open it again. Kept in sessionStorage so the reload that follows a sign-in
 * still knows, because that reload is what picks up the parked copy.
 */
export function rememberUsedDesktopPortalToken(token: string): void {
  try {
    const used = readUsedDesktopPortalTokens().filter((existing) => existing !== token);
    used.push(token);
    sessionStorage.setItem(USED_DESKTOP_PORTAL_TOKENS_KEY, JSON.stringify(used.slice(-USED_DESKTOP_PORTAL_TOKENS_LIMIT)));
  } catch {
    // sessionStorage unavailable — a repeat is then refused by the Hub and dropped as expired.
  }
}

export function isUsedDesktopPortalToken(token: string): boolean {
  return readUsedDesktopPortalTokens().includes(token);
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
