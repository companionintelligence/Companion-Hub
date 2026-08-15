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
