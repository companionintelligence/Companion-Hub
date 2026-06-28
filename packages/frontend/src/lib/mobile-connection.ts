/**
 * Mobile (iOS/Android) remote-Hub connection state.
 *
 * A phone can't run a Hub, so the mobile app is a thin client that points the
 * shared frontend at a *remote* Hub appliance the user picks from the cloud
 * device list. This module owns:
 *
 *  - detecting that we're on a Tauri mobile platform,
 *  - persisting the chosen Hub base URL (Tauri store, survives restarts),
 *  - applying it: set the API client `baseUrl` and route requests through the
 *    Tauri HTTP plugin so a `tauri://localhost` webview can reach an https Hub.
 *
 * Everything here is inert on web/desktop (`isTauriMobileSync()` stays false),
 * so those builds are unaffected.
 */
import { client } from '@/api-client/client.gen';
import { resetActiveFetch, runtimeFetch, setActiveFetch } from './runtime-fetch';

const STORE_FILE = 'mobile-connection.json';
const HUB_BASE_URL_KEY = 'hubBaseUrl';

let cachedIsMobile: boolean | null = null;
let currentHubBaseUrl: string | null = null;
let initialized = false;

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Detect a Tauri *mobile* webview synchronously from the user agent. This avoids
 * an async round-trip to the OS plugin during the very first root loader run —
 * an awaited call there can stall the whole app on a blank screen if it's slow
 * to resolve in the WebView. The Android/iOS WebView UAs reliably contain these
 * tokens; desktop Tauri (macOS/Windows/Linux) never does.
 */
function detectMobileSync(): boolean {
  if (!isTauri()) return false;
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || '';
  return /android/i.test(ua) || /iphone|ipad|ipod/i.test(ua);
}

/** True once {@link initMobileConnection} has resolved this platform as iOS/Android. */
export function isTauriMobileSync(): boolean {
  if (cachedIsMobile === null) {
    // Resolve eagerly the first time it's read so synchronous callers
    // (root clientLoader, HubStatus) get the right answer immediately.
    cachedIsMobile = detectMobileSync();
  }
  return cachedIsMobile === true;
}

/** Promise that resolves to `fallback` if `p` hasn't settled within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/** The active remote Hub base URL, or null when none has been chosen yet. */
export function getHubBaseUrlSync(): string | null {
  return currentHubBaseUrl;
}

async function openStore() {
  const { load } = await import('@tauri-apps/plugin-store');
  return load(STORE_FILE);
}

/** The Tauri HTTP plugin's `fetch` — native, bypasses webview CORS. */
async function loadNativeFetch(): Promise<typeof runtimeFetch | null> {
  try {
    const http = await import('@tauri-apps/plugin-http');
    return http.fetch as unknown as typeof runtimeFetch;
  } catch {
    return null;
  }
}

function applyHubBaseUrl(baseUrl: string): void {
  currentHubBaseUrl = baseUrl;
  // Cross-origin to a remote Hub: cookies won't ride along, so we rely on the
  // X-CI-Hub-Session header (set by the root request interceptor). Route through
  // runtimeFetch (native HTTP) so the request isn't blocked by webview CORS.
  client.setConfig({ baseUrl, credentials: 'omit', fetch: runtimeFetch });
}

/**
 * Resolve mobile-ness and any stored Hub URL, applying it to the API client.
 * Idempotent — safe to await from the root loader on every navigation.
 */
export async function initMobileConnection(): Promise<{ isMobile: boolean; hubBaseUrl: string | null }> {
  if (initialized) {
    return { isMobile: cachedIsMobile === true, hubBaseUrl: currentHubBaseUrl };
  }

  cachedIsMobile = detectMobileSync();

  if (cachedIsMobile) {
    // Route remote-Hub API calls through native HTTP (best-effort; non-blocking).
    const nativeFetch = await withTimeout(loadNativeFetch(), 3000, null);
    if (nativeFetch) {
      setActiveFetch(nativeFetch);
    }
    // Read the stored Hub URL, but never let a slow/hung store wedge startup:
    // if it doesn't answer quickly we just fall through to the connect screen.
    try {
      const stored = await withTimeout(
        openStore().then((store) => store.get<string>(HUB_BASE_URL_KEY)),
        3000,
        null,
      );
      if (stored) {
        applyHubBaseUrl(stored);
      }
    } catch {
      // No store yet / unreadable — user will pick a Hub via the connect screen.
    }
  }

  initialized = true;
  return { isMobile: cachedIsMobile === true, hubBaseUrl: currentHubBaseUrl };
}

/** Persist and activate the chosen remote Hub. Called by the Hub picker. */
export async function setHubConnection(baseUrl: string): Promise<void> {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  applyHubBaseUrl(normalized);
  try {
    const store = await openStore();
    await store.set(HUB_BASE_URL_KEY, normalized);
    await store.save();
  } catch {
    // Persistence is best-effort; the in-memory connection still works this session.
  }
}

/** Forget the current Hub (the "switch Hub" action). */
export async function clearHubConnection(): Promise<void> {
  currentHubBaseUrl = null;
  resetActiveFetch();
  client.setConfig({ baseUrl: undefined });
  try {
    const store = await openStore();
    await store.delete(HUB_BASE_URL_KEY);
    await store.save();
  } catch {
    // ignore
  }
}
