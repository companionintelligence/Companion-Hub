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
    expect(getCurrentWindow().setBackgroundColor).toHaveBeenCalledWith(SHELL_BACKGROUND.light);
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
