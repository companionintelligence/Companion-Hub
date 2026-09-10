import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAuthInSystemBrowser } from './open-auth-browser';

const openUrl = vi.fn(async (_url?: string) => {});
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (url: string) => openUrl(url),
}));

describe('openAuthInSystemBrowser', () => {
  afterEach(() => {
    openUrl.mockClear();
  });

  it('uses the Tauri opener so the webview never follows cihub://', async () => {
    await openAuthInSystemBrowser('https://hub.companionintelligence.com/api/auth/oauth2/authorize');
    expect(openUrl).toHaveBeenCalledWith('https://hub.companionintelligence.com/api/auth/oauth2/authorize');
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
