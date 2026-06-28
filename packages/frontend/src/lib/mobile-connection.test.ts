import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setConfig = vi.fn();
vi.mock('@/api-client/client.gen', () => ({
  client: { setConfig },
}));

const httpFetch = vi.fn(async () => new Response('{}'));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));

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

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Chrome/134 Mobile';

beforeEach(() => {
  storeData = {};
  setConfig.mockClear();
  storeSet.mockClear();
  storeDelete.mockClear();
});

afterEach(() => {
  setTauri(false);
  setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X)');
});

describe('isTauriMobileSync', () => {
  it('is false on web (no Tauri internals)', async () => {
    setTauri(false);
    setUserAgent(ANDROID_UA);
    const m = await freshModule();
    expect(m.isTauriMobileSync()).toBe(false);
  });

  it('is false on desktop Tauri (no mobile UA)', async () => {
    setTauri(true);
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X) Tauri');
    const m = await freshModule();
    expect(m.isTauriMobileSync()).toBe(false);
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
