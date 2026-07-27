import { client } from '@/api-client/client.gen';
import { isTauriReleaseBuild } from '@/lib/tauri-hub-probe';

export const TAURI_SESSION_STORAGE_KEY = 'ci-hub-session';
export const HUB_SESSION_ISSUED_AT_KEY = 'ci-hub-session-issued-at';

/** Rotate hub sessions after 5 days so the 7-day server TTL never lapses for active users. */
export const HUB_SESSION_REFRESH_AFTER_MS = 5 * 24 * 60 * 60 * 1000;

// Session ID storage for Tauri release mode (where cookies don't work cross-origin)
let tauriSessionId: string | null = null;

/** Desktop release builds must survive full app quit/relaunch — sessionStorage does not. */
function usesPersistentSessionStorage(): boolean {
  return isTauriReleaseBuild();
}

function readStoredSessionId(): string | null {
  if (usesPersistentSessionStorage()) {
    try {
      const fromLocal = localStorage.getItem(TAURI_SESSION_STORAGE_KEY);
      if (fromLocal) {
        return fromLocal;
      }
    } catch {
      // localStorage unavailable — fall through to sessionStorage.
    }
  }

  try {
    return sessionStorage.getItem(TAURI_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredSessionId(id: string): void {
  if (usesPersistentSessionStorage()) {
    try {
      localStorage.setItem(TAURI_SESSION_STORAGE_KEY, id);
    } catch {
      // Fall back to sessionStorage only for this runtime.
    }
  }

  try {
    sessionStorage.setItem(TAURI_SESSION_STORAGE_KEY, id);
  } catch {
    // Storage unavailable in some embedded contexts.
  }
}

function removeStoredSessionId(): void {
  try {
    localStorage.removeItem(TAURI_SESSION_STORAGE_KEY);
    localStorage.removeItem(HUB_SESSION_ISSUED_AT_KEY);
  } catch {
    // ignore
  }

  try {
    sessionStorage.removeItem(TAURI_SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function getHubSessionIssuedAt(): number | null {
  try {
    const raw = localStorage.getItem(HUB_SESSION_ISSUED_AT_KEY);
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function markHubSessionIssuedAt(issuedAt = Date.now()): void {
  try {
    localStorage.setItem(HUB_SESSION_ISSUED_AT_KEY, String(issuedAt));
  } catch {
    // Storage unavailable in some embedded contexts.
  }
}

/** Migrate a session saved in sessionStorage before we switched to localStorage. */
function migrateSessionToPersistentStorage(id: string): void {
  if (!usesPersistentSessionStorage()) {
    return;
  }

  try {
    if (!localStorage.getItem(TAURI_SESSION_STORAGE_KEY)) {
      localStorage.setItem(TAURI_SESSION_STORAGE_KEY, id);
    }
  } catch {
    // ignore
  }
}

export function setTauriSessionId(id: string | null, issuedAt?: number) {
  tauriSessionId = id;
  if (id) {
    writeStoredSessionId(id);
    migrateSessionToPersistentStorage(id);
    markHubSessionIssuedAt(issuedAt ?? Date.now());
  } else {
    removeStoredSessionId();
  }
}

export function getTauriSessionId(): string | null {
  if (tauriSessionId) {
    return tauriSessionId;
  }

  tauriSessionId = readStoredSessionId();
  if (tauriSessionId) {
    migrateSessionToPersistentStorage(tauriSessionId);
  }

  return tauriSessionId;
}

/** Drop a client session that the Hub no longer recognizes (expired, hub reset, etc.). */
export function clearStaleTauriSession(): void {
  if (!getTauriSessionId()) {
    return;
  }
  setTauriSessionId(null);
}

/**
 * Wrapper around fetch() that prepends the API client's baseUrl.
 * In Tauri release mode, also sends the session ID as a custom header
 * since cross-origin cookies don't work in WebView2 over HTTP.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const config = client.getConfig();
  const baseUrl = config.baseUrl ?? '';
  const headers = new Headers(init?.headers);
  const sid = getTauriSessionId();
  if (sid) {
    headers.set('X-CI-Hub-Session', sid);
  }
  // Honor the configured credential mode (set to 'omit' in Tauri release builds).
  // Hardcoding 'include' breaks cross-origin requests in the desktop app: the Hub
  // can answer with `Access-Control-Allow-Origin: *` (when the WebView sends no
  // Origin), which browsers reject for any credentialed request — surfacing as a
  // bare "Load failed". The generated API client already uses this config value.
  const credentials: RequestCredentials = init?.credentials ?? config.credentials ?? 'include';
  return fetch(`${baseUrl}${path}`, { credentials, ...init, headers }).then((response) => {
    if (
      response.status === 401 &&
      !path.startsWith('/api/auth/login') &&
      !path.startsWith('/api/auth/logout') &&
      !path.startsWith('/api/auth/session/refresh') &&
      // The browser-handoff mint is a best-effort bridge on the way to an external
      // open (`openExternalWithHubSession`), and it is documented as fail-open. Left
      // to the generic handler its 401 tears the page down mid-click — and because
      // `openExternal` first awaits a DNS pre-warm, that navigation also aborts the
      // pending open, so the user gets neither the browser tab nor the flow, just a
      // login screen. Let it fall through to the plain external open instead; a
      // genuinely dead session still surfaces on the next polled request.
      !path.startsWith('/api/auth/browser-handoff/mint')
    ) {
      void import('@/lib/session-expired')
        .then(({ handleSessionExpired }) => handleSessionExpired())
        .catch(() => {
          // Non-fatal when the expiry handler chunk fails to load.
        });
    }
    return response;
  });
}

/** Best-effort server logout to clear stale httpOnly session cookies in the browser. */
export async function clearStaleServerSession(): Promise<void> {
  clearStaleTauriSession();
  const config = client.getConfig();
  const baseUrl = config.baseUrl ?? '';
  const credentials: RequestCredentials = config.credentials ?? 'include';
  try {
    await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', credentials });
  } catch {
    // Non-fatal when the API is down or the session is already gone.
  }
}
