import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthSessionCancelledError, openAuthInSystemBrowser, openAuthSession } from './open-auth-browser';

const openUrl = vi.fn(async (_url?: string) => {});
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (url: string) => openUrl(url),
}));

const invoke = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}

function setTauri(present: boolean) {
  if (present) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  } else {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  }
}

describe('openAuthInSystemBrowser', () => {
  afterEach(() => {
    openUrl.mockClear();
  });

  it('uses the Tauri opener so the webview never follows cihub://', async () => {
    await openAuthInSystemBrowser('https://hub.companionintelligence.com/api/auth/oauth2/authorize');
    expect(openUrl).toHaveBeenCalledWith('https://hub.companionintelligence.com/api/auth/oauth2/authorize');
  });
});

describe('openAuthSession', () => {
  afterEach(() => {
    openUrl.mockClear();
    invoke.mockReset();
    setTauri(false);
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
  });

  it('on iOS uses the in-app sheet and not system Safari', async () => {
    setTauri(true);
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    invoke.mockResolvedValue(undefined);

    await openAuthSession('https://idp.example.com/auth');

    expect(invoke).toHaveBeenCalledWith('start_auth_session', {
      url: 'https://idp.example.com/auth',
      callbackScheme: 'cihub',
    });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('maps a dismissed iOS sheet to AuthSessionCancelledError', async () => {
    setTauri(true);
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    invoke.mockRejectedValue(Object.assign(new Error('Sign-in cancelled'), { code: 'CANCELLED' }));

    await expect(openAuthSession('https://idp.example.com/auth')).rejects.toBeInstanceOf(AuthSessionCancelledError);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('on Android uses the in-app Auth Tab and not the system browser', async () => {
    setTauri(true);
    setUserAgent('Mozilla/5.0 (Linux; Android 15)');
    invoke.mockResolvedValue(undefined);

    await openAuthSession('https://idp.example.com/auth');

    expect(invoke).toHaveBeenCalledWith('start_auth_session', {
      url: 'https://idp.example.com/auth',
      callbackScheme: 'cihub',
    });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('maps a dismissed Android sheet to AuthSessionCancelledError', async () => {
    setTauri(true);
    setUserAgent('Mozilla/5.0 (Linux; Android 15)');
    invoke.mockRejectedValue(Object.assign(new Error('Sign-in cancelled'), { code: 'CANCELLED' }));

    await expect(openAuthSession('https://idp.example.com/auth')).rejects.toBeInstanceOf(AuthSessionCancelledError);
    expect(openUrl).not.toHaveBeenCalled();
  });
});

/**
 * The opener plugin is a dynamic import, so it can fail: a stale chunk hash after
 * an update, or a build without the plugin. Inside a webview the <a target="_blank">
 * fallback is inert (wry) or a same-document navigation (WKWebView), so falling
 * through there produces a dead sign-in button with nothing in the console. It has
 * to reject so login-form can toast.
 */
describe('openAuthInSystemBrowser — when the opener plugin cannot load', () => {
  afterEach(() => {
    vi.doUnmock('@tauri-apps/plugin-opener');
    vi.resetModules();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  const loadWithBrokenOpener = async () => {
    vi.resetModules();
    vi.doMock('@tauri-apps/plugin-opener', () => {
      throw new Error('Failed to load the opener chunk');
    });
    return (await import('./open-auth-browser')).openAuthInSystemBrowser;
  };

  it('rejects inside a Tauri webview instead of silently doing nothing', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    const openAuth = await loadWithBrokenOpener();

    await expect(openAuth('https://hub.ci.computer/api/auth/portal/start')).rejects.toThrow(/system opener is unavailable/i);
  });

  it('still falls back to an anchor in a real browser, where target=_blank works', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const openAuth = await loadWithBrokenOpener();

    await openAuth('https://hub.ci.computer/api/auth/portal/start');

    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});
