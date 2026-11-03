import { client } from '@/api-client/client.gen';
import { isSessionExpiryExempt } from '@/lib/session-expiry-policy';
import { usesCrossOriginDesktopApi } from '@/lib/hub-runtime-mode';
import { isMobileClient, isTauriMobileSync } from '@/lib/mobile-connection';
import { runtimeFetch } from './runtime-fetch';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';
import { desktopSecureStore, readDesktopSessionId, removeDesktopSession, writeDesktopSessionId } from '@/lib/desktop-session';

/**
 * The WebView's web-storage key for the session id. Desktop no longer writes it: its session is in the
 * keychain. It is kept only so an older build's copy can be migrated and removed.
 */
export const TAURI_SESSION_STORAGE_KEY = 'ci-hub-session';
export const HUB_SESSION_ISSUED_AT_KEY = 'ci-hub-session-issued-at';
export const MOBILE_SESSION_STORE_FILE = 'mobile-session.json';

/** Rotate hub sessions after 5 days so the 7-day server TTL never lapses for active users. */
export const HUB_SESSION_REFRESH_AFTER_MS = 5 * 24 * 60 * 60 * 1000;

// The Hub session id in memory: what apiFetch sends. Desktop keeps the durable copy in the keychain and
// mobile in its store file (see hydrateMobileSession), so nothing here is read from web storage on desktop.
let tauriSessionId: string | null = null;

function isMobileRuntime(): boolean {
  return isTauriMobileSync() || isMobileClient();
}

let mobileStorePromise: Promise<{
  get: <T>(key: string) => Promise<T | null>;
  set: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<boolean | undefined>;
  save: () => Promise<void>;
} | null> | null = null;

export function resetMobileSessionStoreForTests(): void {
  mobileStorePromise = null;
}

async function openMobileSessionStore() {
  if (!mobileStorePromise) {
    mobileStorePromise = (async () => {
      try {
        const { load } = await import('@tauri-apps/plugin-store');
        const store = await load(MOBILE_SESSION_STORE_FILE);
        return store as unknown as {
          get: <T>(key: string) => Promise<T | null>;
          set: (key: string, value: unknown) => Promise<void>;
          delete: (key: string) => Promise<boolean | undefined>;
          save: () => Promise<void>;
        };
      } catch {
        return null;
      }
    })();
  }
  return mobileStorePromise;
}

export async function persistMobileSession(id: string, issuedAt: number): Promise<void> {
  try {
    const store = await openMobileSessionStore();
    if (store) {
      await store.set(TAURI_SESSION_STORAGE_KEY, id);
      await store.set(HUB_SESSION_ISSUED_AT_KEY, String(issuedAt));
      await store.save();
    }
  } catch {
    // Best-effort write-through
  }
}

export async function clearMobileSession(): Promise<void> {
  try {
    const store = await openMobileSessionStore();
    if (store) {
      await store.delete(TAURI_SESSION_STORAGE_KEY);
      await store.delete(HUB_SESSION_ISSUED_AT_KEY);
      await store.save();
    }
  } catch {
    // Best-effort
  }
}

/**
 * Hydrate the in-memory session cache from the mobile app's store file.
 * Also migrates any legacy session found in localStorage into the store and deletes it.
 *
 * TODO(mobile secure store): the store file is plain JSON, not a secure store, so the session sits in
 * the app sandbox unencrypted. Move it into the Keychain/Keystore once the CI-Common mobile secure
 * store is merged. Until then this is no worse than before.
 */
export async function hydrateMobileSession(): Promise<string | null> {
  if (!isMobileRuntime()) {
    return getTauriSessionId();
  }

  try {
    const store = await openMobileSessionStore();
    if (store) {
      const stored = await store.get<string>(TAURI_SESSION_STORAGE_KEY);
      const storedIssuedAt = await store.get<string | number>(HUB_SESSION_ISSUED_AT_KEY);
      if (stored) {
        tauriSessionId = stored;
        if (storedIssuedAt) {
          markHubSessionIssuedAt(Number(storedIssuedAt));
        }
        try {
          localStorage.removeItem(TAURI_SESSION_STORAGE_KEY);
        } catch {
          // ignore
        }
        return stored;
      }
    }
  } catch {
    // Fall back to reading web storage
  }

  const legacy = readStoredSessionId();
  if (legacy) {
    tauriSessionId = legacy;
    const issuedAt = getHubSessionIssuedAt() ?? Date.now();
    await persistMobileSession(legacy, issuedAt);
    try {
      localStorage.removeItem(TAURI_SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
    return legacy;
  }

  return null;
}

/**
 * The desktop app, which keeps its Hub session in the OS keychain. False on a phone and in a plain browser.
 */
function usesDesktopKeychain(): boolean {
  return !isMobileRuntime() && getTauriInvoke() !== null;
}

/**
 * Load the desktop session id from the keychain into memory, once, at startup, before the first request.
 * A session an older build left in the WebView's web storage is moved into the keychain and removed.
 */
export async function hydrateDesktopSession(): Promise<string | null> {
  const store = desktopSecureStore();
  if (!store || isMobileRuntime()) {
    return getTauriSessionId();
  }

  try {
    const stored = await readDesktopSessionId(store);
    if (stored) {
      tauriSessionId = stored;
      return stored;
    }
  } catch {
    // The keychain refused (locked, or no Secret Service on Linux). The person signs in again.
  }

  const legacy = takeLegacyWebViewSessionId();
  if (legacy) {
    tauriSessionId = legacy;
    try {
      await writeDesktopSessionId(store, legacy);
    } catch {
      // Kept in memory for this run only.
    }
    return legacy;
  }

  return null;
}

/** Read and remove the session id an older build kept in the WebView's web storage. */
function takeLegacyWebViewSessionId(): string | null {
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(TAURI_SESSION_STORAGE_KEY);
    localStorage.removeItem(TAURI_SESSION_STORAGE_KEY);
  } catch {
    // localStorage unavailable.
  }
  try {
    legacy = legacy ?? sessionStorage.getItem(TAURI_SESSION_STORAGE_KEY);
    sessionStorage.removeItem(TAURI_SESSION_STORAGE_KEY);
  } catch {
    // sessionStorage unavailable.
  }
  return legacy;
}

/** Keep the desktop's session id in the keychain, or forget it, and drop any copy an older build left behind. */
function persistDesktopSession(id: string | null): void {
  const store = desktopSecureStore();
  if (store) {
    const write = id ? writeDesktopSessionId(store, id) : removeDesktopSession(store);
    void write.catch(() => undefined);
  }
  takeLegacyWebViewSessionId();
}

/** Desktop release builds must survive full app quit/relaunch — sessionStorage does not. */
function usesPersistentSessionStorage(): boolean {
  return usesCrossOriginDesktopApi();
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
  const timestamp = issuedAt ?? Date.now();
  if (usesDesktopKeychain()) {
    persistDesktopSession(id);
    if (id) {
      markHubSessionIssuedAt(timestamp);
    } else {
      removeStoredSessionId();
    }
    return;
  }
  if (id) {
    if (isMobileRuntime()) {
      void persistMobileSession(id, timestamp);
      try {
        sessionStorage.setItem(TAURI_SESSION_STORAGE_KEY, id);
        localStorage.removeItem(TAURI_SESSION_STORAGE_KEY);
      } catch {
        // ignore
      }
    } else {
      writeStoredSessionId(id);
      migrateSessionToPersistentStorage(id);
    }
    markHubSessionIssuedAt(timestamp);
  } else {
    if (isMobileRuntime()) {
      void clearMobileSession();
    }
    removeStoredSessionId();
  }
}

export function getTauriSessionId(): string | null {
  if (tauriSessionId) {
    return tauriSessionId;
  }
  if (usesDesktopKeychain()) {
    // The keychain is read once at startup (hydrateDesktopSession). Until then there is no session to send.
    return null;
  }

  tauriSessionId = readStoredSessionId();
  if (tauriSessionId && !isMobileRuntime()) {
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
  // runtimeFetch is window.fetch on web/desktop, and the native Tauri HTTP client
  // on mobile (so a tauri://localhost webview can reach a remote https Hub).
  return runtimeFetch(`${baseUrl}${path}`, { credentials, ...init, headers }).then((response) => {
    if (response.status === 401 && !isSessionExpiryExempt(path)) {
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
    // runtimeFetch so the logout reaches a remote Hub on mobile too.
    await runtimeFetch(`${baseUrl}/api/auth/logout`, { method: 'POST', credentials });
  } catch {
    // Non-fatal when the API is down or the session is already gone.
  }
}
