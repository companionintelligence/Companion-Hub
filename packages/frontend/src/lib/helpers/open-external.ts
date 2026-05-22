/**
 * Opens a URL in the user's default system browser.
 * In Tauri context, uses the opener plugin to escape the webview.
 * Falls back to window.open in web context.
 */
export const openExternal = async (url: string): Promise<void> => {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      return;
    } catch {
      // Fall through to window.open
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
};
