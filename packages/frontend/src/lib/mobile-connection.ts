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
/** Survives a hydrate that would otherwise forget we already proved this is iOS. */
const MOBILE_FLAG_KEY = 'cihub.isTauriMobile';

let cachedIsMobile: boolean | null = null;
let currentHubBaseUrl: string | null = null;
let initialized = false;
let cachedNativeFetch: typeof runtimeFetch | null = null;

function readMobileFlag(): boolean {
  try {
    return sessionStorage.getItem(MOBILE_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function persistMobileFlag(): void {
  try {
    sessionStorage.setItem(MOBILE_FLAG_KEY, '1');
  } catch {
    /* private mode */
  }
}

function markMobile(): void {
  cachedIsMobile = true;
  persistMobileFlag();
}

/** Vitest only — `isTauriMobileSync` never downgrades, so a phone UA leaks across files. */
export function resetMobileClientCacheForTests(): void {
  cachedIsMobile = null;
  currentHubBaseUrl = null;
  initialized = false;
  cachedNativeFetch = null;
  try {
    sessionStorage.removeItem(MOBILE_FLAG_KEY);
  } catch {
    /* ignore */
  }
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Phone/tablet user agent — no Tauri required. Used to unstick `ios:dev`
 * (Vite `localhost` + late/missing IPC injection) without sending iPhone
 * Safari on a live Hub to the picker: that path still has a Hub API.
 *
 * iPadOS "Request Desktop Website" reports Macintosh; touch points distinguish it.
 */
export function isMobileUserAgent(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/android/i.test(ua) || /iphone|ipad|ipod/i.test(ua)) return true;
  if (/iphone|ipad|ipod/i.test(navigator.platform || '')) return true;
  return /macintosh/i.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
}

/**
 * True when this client should use the remote-Hub connect flow.
 * Broader than {@link isTauriMobileSync}: covers the ios:dev race where Tauri
 * IPC is missing and the iOS Simulator serves a desktop UA for localhost.
 */
/**
 * ios:dev frontend — Vite's default port is 5005, `devUrl` is lvh.me, and the
 * Simulator often reports a Macintosh UA with `innerWidth === 0` on first paint.
 * Missing this is what left only the "UI has not painted yet" boot footer.
 */
export function isMobileDevFrontend(): boolean {
  if (typeof window === 'undefined' || !import.meta.env.DEV) return false;
  try {
    const { port, hostname } = window.location;
    if (port === '5005') return true;
    if (hostname === 'lvh.me' || hostname.endsWith('.lvh.me')) return true;
  } catch {
    /* ignore */
  }
  const shortestScreen = typeof screen !== 'undefined' ? Math.min(screen.width || 0, screen.height || 0) : 0;
  if (shortestScreen > 0 && shortestScreen <= 500) return true;
  return false;
}

export function isMobileClient(): boolean {
  if (isTauriMobileSync() || isMobileUserAgent()) return true;
  if (import.meta.env.VITE_HUB_RUNTIME === 'mobile') return true;
  if (isMobileDevFrontend()) {
    markMobile();
    return true;
  }
  // iPhone simulator + Request Desktop Website: Macintosh UA, maxTouchPoints 0.
  // A phone-sized viewport in the Vite dev server is the remaining signal.
  // iOS also reports the classic 980px layout width before the viewport meta
  // applies — that flash is what blanks /connect after the first paint.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const shortest = Math.min(window.innerWidth, window.innerHeight);
    if (shortest > 0 && shortest <= 500) return true;
    if (isTauri() && (window.innerWidth === 980 || window.innerHeight === 980)) return true;
  }
  return false;
}

/** True when the thin-client picker must stay up — no remote Hub chosen yet. */
export function needsRemoteHubConnect(): boolean {
  return isMobileClient() && !getHubBaseUrlSync();
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
  return isMobileUserAgent();
}

/** True once {@link initMobileConnection} has resolved this platform as iOS/Android. */
export function isTauriMobileSync(): boolean {
  // Never downgrade a confirmed mobile detect. Overwriting `true` with a
  // desktop-UA `false` (iOS Simulator + localhost) is what unmounts /connect
  // after the first paint and leaves a black HubStatus gate.
  if (cachedIsMobile === true || readMobileFlag()) {
    cachedIsMobile = true;
    return true;
  }
  if (detectMobileSync()) {
    markMobile();
    return true;
  }
  return false;
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

/**
 * Ensure the app-wide {@link runtimeFetch} routes through the native Tauri HTTP
 * client on mobile. Loaded once and cached. Idempotent and safe to call whenever
 * a Hub connection is (re)established — a `tauri://localhost` webview can never
 * reach a cross-origin `https://*.ci.computer` Hub through `window.fetch`, so the
 * native fetch must be the active one *before* the first authenticated request
 * (the Hub `/login` POST) fires. Best-effort: a null result just leaves the
 * previous fetch in place. No-op off mobile.
 */
async function ensureNativeFetchActive(): Promise<void> {
  if (!isTauriMobileSync() && !isMobileClient()) return;
  if (!cachedNativeFetch) {
    cachedNativeFetch = await withTimeout(loadNativeFetch(), 3000, null);
  }
  if (cachedNativeFetch) {
    setActiveFetch(cachedNativeFetch);
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
async function detectOsMobile(): Promise<boolean | null> {
  try {
    const os = await import('@tauri-apps/plugin-os');
    if (typeof os.type !== 'function') return null;
    const platform = os.type();
    if (platform === 'ios' || platform === 'android') return true;
    if (platform) return false;
  } catch {
    // Plugin missing in unit tests / late IPC.
  }
  return null;
}

export async function initMobileConnection(): Promise<{ isMobile: boolean; hubBaseUrl: string | null }> {
  if (detectMobileSync() || readMobileFlag()) {
    markMobile();
  }

  const osMobile = await withTimeout(detectOsMobile(), 1500, null);
  if (osMobile === true) {
    markMobile();
  }

  if (initialized) {
    return { isMobile: cachedIsMobile === true, hubBaseUrl: currentHubBaseUrl };
  }

  if (cachedIsMobile) {
    // Route remote-Hub API calls through native HTTP (best-effort; non-blocking).
    await ensureNativeFetchActive();
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
    initialized = true;
  } else if (isTauri() && !isMobileClient() && osMobile === false) {
    // Confirmed desktop Tauri (macOS/Windows/Linux). Do not lock this when the
    // OS plugin is missing — ios:dev often looks like desktop until it answers.
    initialized = true;
  }
  // If Tauri isn't injected yet, leave `initialized` false so a later loader
  // pass can pick up iOS/Android after `__TAURI_INTERNALS__` appears.

  return { isMobile: cachedIsMobile === true, hubBaseUrl: currentHubBaseUrl };
}

/** Persist and activate the chosen remote Hub. Called by the Hub picker. */
export async function setHubConnection(baseUrl: string): Promise<void> {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  // Guarantee the native fetch is active *before* pointing the client at the Hub.
  // The picker calls this and immediately hands off to `/login`, whose POST goes
  // through the generated client → runtimeFetch. If native fetch isn't active
  // (initMobileConnection never ran — e.g. dev builds skip it — or a prior
  // clearHubConnection reset it), that POST would fall back to the webview
  // `window.fetch` and fail cross-origin, so the Hub login silently never works.
  await ensureNativeFetchActive();
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
  // Only drop the Hub baseUrl. Do NOT reset the active fetch on mobile: the
  // native Tauri HTTP client must stay active so re-picking a Hub (SPA nav, no
  // full reload) still routes through native HTTP. `resetActiveFetch()` here
  // stranded the app on the webview `window.fetch`, which can't reach the next
  // cross-origin Hub — the reconnect then failed. Off mobile the active fetch was
  // never swapped, so leaving it alone is a no-op.
  if (!isTauriMobileSync()) {
    resetActiveFetch();
  }
  client.setConfig({ baseUrl: undefined });
  try {
    const store = await openStore();
    await store.delete(HUB_BASE_URL_KEY);
    await store.save();
  } catch {
    // ignore
  }
}
