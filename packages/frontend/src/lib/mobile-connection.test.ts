import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setConfig = vi.fn();
vi.mock('@/api-client/client.gen', () => ({
  client: { setConfig },
}));

const httpFetch = vi.fn(async () => new Response('{}'));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));

const osType = vi.fn(() => 'macos');
vi.mock('@tauri-apps/plugin-os', () => ({
  type: () => osType(),
}));

// Mutable store backing so each test can control persistence.
let storeData: Record<string, unknown>;
const storeSet = vi.fn(async (k: string, v: unknown) => {
  storeData[k] = v;
});
const storeDelete = vi.fn(async (k: string) => {
  delete storeData[k];
});
vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => storeData[k] ?? null,
    set: storeSet,
    delete: storeDelete,
    save: vi.fn(async () => {}),
  })),
}));

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}
function setTauri(present: boolean) {
  if (present) (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

async function freshModule() {
  vi.resetModules();
  return import('./mobile-connection');
}

/**
 * Import mobile-connection *and* runtime-fetch from the same fresh module graph
 * so `setActiveFetch` (called inside mobile-connection) is observable through the
 * `runtimeFetch` we assert on. Importing runtime-fetch at the top level would pin
 * a stale instance that `vi.resetModules()` no longer shares with the module.
 */
async function freshModulePair() {
  vi.resetModules();
  const mc = await import('./mobile-connection');
  const rf = await import('./runtime-fetch');
  return { mc, rf };
}

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Chrome/134 Mobile';

beforeEach(() => {
  storeData = {};
  setConfig.mockClear();
  storeSet.mockClear();
  storeDelete.mockClear();
  osType.mockReset();
  osType.mockReturnValue('macos');
  sessionStorage.clear();
});

afterEach(() => {
  setTauri(false);
  setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X)');
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
  sessionStorage.clear();
});

describe('isMobileUserAgent', () => {
  it('is true for Android / iPhone even without Tauri', async () => {
    setTauri(false);
    setUserAgent(ANDROID_UA);
    const m = await freshModule();
    expect(m.isMobileUserAgent()).toBe(true);

    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    const m2 = await freshModule();
    expect(m2.isMobileUserAgent()).toBe(true);
  });

  it('needsRemoteHubConnect is true on a phone with no stored Hub', async () => {
    setTauri(true);
    setUserAgent(ANDROID_UA);
    const m = await freshModule();
    expect(m.needsRemoteHubConnect()).toBe(true);
    await m.setHubConnection('https://hub-x.ci.computer');
    expect(m.needsRemoteHubConnect()).toBe(false);
  });

  it('treats the iOS 980px pre-viewport width as mobile inside Tauri DEV', async () => {
    setTauri(true);
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X) Tauri');
    Object.defineProperty(window, 'innerWidth', { value: 980, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 980, configurable: true });
    const m = await freshModule();
    expect(m.isMobileClient()).toBe(true);
  });

  it('is true for a phone-sized Vite viewport (ios:dev desktop-UA fallback)', async () => {
    setTauri(false);
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X)');
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 844, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 390, configurable: true });
    const m = await freshModule();
    expect(m.isMobileUserAgent()).toBe(false);
    expect(m.isMobileClient()).toBe(true);
  });

  it('is false on desktop Macintosh without touch', async () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X)');
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
    const m = await freshModule();
    expect(m.isMobileUserAgent()).toBe(false);
  });

  it('treats the ios:dev Vite origin (localhost:5005) as mobile even with a desktop UA', async () => {
    setTauri(true);
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X)');
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 0, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 0, configurable: true });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, port: '5005', hostname: 'localhost', href: 'http://localhost:5005/connect' },
    });
    const m = await freshModule();
    expect(m.isMobileUserAgent()).toBe(false);
    expect(m.isMobileDevFrontend()).toBe(true);
    expect(m.isMobileClient()).toBe(true);
  });
});

describe('isTauriMobileSync', () => {
  it('is false on web (no Tauri internals)', async () => {
    setTauri(false);
    setUserAgent(ANDROID_UA);
    const m = await freshModule();
    expect(m.isTauriMobileSync()).toBe(false);
  });

  it('does not permanently cache a negative across late Tauri injection', async () => {
    setTauri(false);
    setUserAgent(ANDROID_UA);
    const m = await freshModule();
    expect(m.isTauriMobileSync()).toBe(false);
    setTauri(true);
    expect(m.isTauriMobileSync()).toBe(true);
  });

  it('is false on desktop Tauri (no mobile UA)', async () => {
    setTauri(true);
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X) Tauri');
    const m = await freshModule();
    expect(m.isTauriMobileSync()).toBe(false);
  });

  it('does not downgrade a confirmed mobile detect when the UA looks like desktop', async () => {
    setTauri(true);
    setUserAgent(ANDROID_UA);
    const m = await freshModule();
    expect(m.isTauriMobileSync()).toBe(true);
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X) Tauri');
    expect(m.isTauriMobileSync()).toBe(true);
  });

  it('is true on Tauri + Android/iOS UA', async () => {
    setTauri(true);
    setUserAgent(ANDROID_UA);
    const m = await freshModule();
    expect(m.isTauriMobileSync()).toBe(true);

    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    const m2 = await freshModule();
    expect(m2.isTauriMobileSync()).toBe(true);
  });
});

describe('initMobileConnection', () => {
  it('does nothing on non-mobile and leaves the API client untouched', async () => {
    setTauri(false);
    const m = await freshModule();
    const result = await m.initMobileConnection();
    expect(result).toEqual({ isMobile: false, hubBaseUrl: null });
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('applies a stored Hub baseUrl on mobile (sets client baseUrl + native fetch)', async () => {
    setTauri(true);
    setUserAgent(ANDROID_UA);
    storeData.hubBaseUrl = 'https://hub-apple-acme.ci.computer';
    const m = await freshModule();

    const result = await m.initMobileConnection();
    expect(result.isMobile).toBe(true);
    expect(result.hubBaseUrl).toBe('https://hub-apple-acme.ci.computer');
    expect(m.getHubBaseUrlSync()).toBe('https://hub-apple-acme.ci.computer');
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://hub-apple-acme.ci.computer', credentials: 'omit' }));
  });

  it('treats Tauri + OS plugin ios as mobile even with a Macintosh UA', async () => {
    setTauri(true);
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X) Tauri');
    osType.mockReturnValue('ios');
    const m = await freshModule();
    const result = await m.initMobileConnection();
    expect(result.isMobile).toBe(true);
    expect(m.isTauriMobileSync()).toBe(true);
    expect(m.needsRemoteHubConnect()).toBe(true);
  });

  it('picks up mobile after Tauri internals appear (ios:dev injection race)', async () => {
    setTauri(false);
    setUserAgent(ANDROID_UA);
    storeData.hubBaseUrl = 'https://hub-apple-acme.ci.computer';
    const m = await freshModule();

    expect(await m.initMobileConnection()).toEqual({ isMobile: false, hubBaseUrl: null });
    expect(setConfig).not.toHaveBeenCalled();

    setTauri(true);
    const result = await m.initMobileConnection();
    expect(result.isMobile).toBe(true);
    expect(result.hubBaseUrl).toBe('https://hub-apple-acme.ci.computer');
  });

  it('mobile with no stored Hub leaves baseUrl unset (connect screen path)', async () => {
    setTauri(true);
    setUserAgent(ANDROID_UA);
    const m = await freshModule();
    const result = await m.initMobileConnection();
    expect(result).toEqual({ isMobile: true, hubBaseUrl: null });
    expect(m.getHubBaseUrlSync()).toBeNull();
  });
});

describe('setHubConnection / clearHubConnection', () => {
  it('persists + applies a chosen Hub, then clears it', async () => {
    setTauri(true);
    setUserAgent(ANDROID_UA);
    const m = await freshModule();
    await m.initMobileConnection();

    await m.setHubConnection('https://hub-x.ci.computer/');
    expect(m.getHubBaseUrlSync()).toBe('https://hub-x.ci.computer'); // trailing slash trimmed
    expect(storeSet).toHaveBeenCalledWith('hubBaseUrl', 'https://hub-x.ci.computer');
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://hub-x.ci.computer' }));

    await m.clearHubConnection();
    expect(m.getHubBaseUrlSync()).toBeNull();
    expect(storeDelete).toHaveBeenCalledWith('hubBaseUrl');
    expect(setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ baseUrl: undefined }));
  });
});

describe('native fetch routing (regression: native fetch must survive setHubConnection)', () => {
  beforeEach(() => {
    httpFetch.mockClear();
  });

  it('routes runtimeFetch through the native Tauri fetch once a Hub is chosen', async () => {
    setTauri(true);
    setUserAgent(ANDROID_UA);
    const { mc, rf } = await freshModulePair();
    const windowFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('window'));

    await mc.initMobileConnection();
    await mc.setHubConnection('https://hub-x.ci.computer');

    await rf.runtimeFetch('https://hub-x.ci.computer/api/user-context');
    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect(windowFetch).not.toHaveBeenCalled(); // never the webview fetch — it can't reach the cross-origin Hub
    windowFetch.mockRestore();
  });

  it('setHubConnection establishes native fetch even when initMobileConnection never ran (dev-build boot path)', async () => {
    setTauri(true);
    setUserAgent(ANDROID_UA);
    const { mc, rf } = await freshModulePair();
    const windowFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('window'));

    // No initMobileConnection() — root.tsx skips it on non-release builds.
    await mc.setHubConnection('https://hub-x.ci.computer');

    await rf.runtimeFetch('https://hub-x.ci.computer/api/user-context');
    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect(windowFetch).not.toHaveBeenCalled();
    windowFetch.mockRestore();
  });

  it('keeps native fetch active across clearHubConnection → reconnect without a full reload', async () => {
    setTauri(true);
    setUserAgent(ANDROID_UA);
    const { mc, rf } = await freshModulePair();
    const windowFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('window'));

    await mc.initMobileConnection();
    await mc.setHubConnection('https://hub-a.ci.computer');
    await mc.clearHubConnection(); // "switch Hub" via SPA nav
    await mc.setHubConnection('https://hub-b.ci.computer'); // pick a different Hub

    httpFetch.mockClear();
    await rf.runtimeFetch('https://hub-b.ci.computer/api/user-context');
    expect(httpFetch).toHaveBeenCalledTimes(1); // still native — the previous bug stranded this on window.fetch
    expect(windowFetch).not.toHaveBeenCalled();
    windowFetch.mockRestore();
  });
});
