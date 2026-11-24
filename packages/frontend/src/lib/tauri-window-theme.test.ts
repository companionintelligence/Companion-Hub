import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getCurrentWindow } = vi.hoisted(() => ({
  getCurrentWindow: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow,
}));

describe('syncTauriWindowBackground', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.documentElement.classList.remove('dark', 'light');
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    getCurrentWindow.mockReturnValue({
      setBackgroundColor: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('no-ops outside the Tauri runtime', async () => {
    const { syncTauriWindowBackground } = await import('./tauri-window-theme');

    await syncTauriWindowBackground();

    expect(getCurrentWindow).not.toHaveBeenCalled();
  });

  it('sets the light shell color when the document is not dark', async () => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    const { syncTauriWindowBackground, SHELL_BACKGROUND } = await import('./tauri-window-theme');

    await syncTauriWindowBackground();

    expect(getCurrentWindow).toHaveBeenCalledTimes(1);
    const currentWindow = getCurrentWindow.mock.results[0]?.value as { setBackgroundColor: ReturnType<typeof vi.fn> } | undefined;
    expect(currentWindow?.setBackgroundColor).toHaveBeenCalledWith(SHELL_BACKGROUND.light);
  });

  it('hands the shell color to the Android system-bar bridge when the app provides one', async () => {
    const setBackgroundColor = vi.fn();
    const host = window as Window & { CiHubSystemBars?: { setBackgroundColor(color: string): void } };
    host.CiHubSystemBars = { setBackgroundColor };
    document.documentElement.classList.add('dark');
    const { syncTauriWindowBackground, SHELL_BACKGROUND } = await import('./tauri-window-theme');

    try {
      await syncTauriWindowBackground();
    } finally {
      delete host.CiHubSystemBars;
    }

    expect(setBackgroundColor).toHaveBeenCalledWith(SHELL_BACKGROUND.dark);
  });

  it('paints the Android system bars with the background the page is showing, not the theme class', async () => {
    const setBackgroundColor = vi.fn();
    const host = window as Window & { CiHubSystemBars?: { setBackgroundColor(color: string): void } };
    host.CiHubSystemBars = { setBackgroundColor };
    document.documentElement.classList.add('dark');
    document.documentElement.style.backgroundColor = 'rgb(243, 250, 247)';
    const { syncTauriWindowBackground } = await import('./tauri-window-theme');

    try {
      await syncTauriWindowBackground();
    } finally {
      delete host.CiHubSystemBars;
      document.documentElement.style.backgroundColor = '';
    }

    expect(setBackgroundColor).toHaveBeenCalledWith('#f3faf7');
  });

  it('swallows permission errors instead of rejecting', async () => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    getCurrentWindow.mockReturnValue({
      setBackgroundColor: vi.fn().mockRejectedValue('window.set_background_color not allowed'),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { syncTauriWindowBackground } = await import('./tauri-window-theme');

    await expect(syncTauriWindowBackground()).resolves.toBeUndefined();

    warnSpy.mockRestore();
  });
});
