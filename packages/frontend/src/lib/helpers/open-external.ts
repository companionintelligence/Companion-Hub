/**
 * Opens a URL in the user's default system browser.
 * In Tauri context, uses the opener plugin to escape the webview.
 * Falls back to window.open in web context.
 */
function normalizeExternalUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

export const openExternal = async (url: string): Promise<void> => {
  const normalizedUrl = normalizeExternalUrl(url);

  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(normalizedUrl);
      return;
    } catch {
      // Fall through to window.open
    }
  }
  window.open(normalizedUrl, '_blank', 'noopener,noreferrer');
};
