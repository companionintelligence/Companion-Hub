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

/**
 * Verifies that a hostname resolves via DNS by making a lightweight HEAD request.
 * This pre-warms both the browser's DNS cache and triggers system DNS resolution.
 *
 * @param hostname - The hostname to verify (e.g., "example.com")
 * @param timeoutMs - Maximum time to wait for DNS resolution (default: 3000ms)
 * @returns true if DNS resolves successfully, false otherwise
 */
async function verifyDnsResolution(hostname: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Use a lightweight HEAD request to trigger DNS resolution
    // Any response (even 4xx/5xx) means DNS resolved successfully
    const response = await fetch(`https://${hostname}`, {
      method: 'HEAD',
      signal: controller.signal,
      cache: 'no-store', // Bypass fetch cache to force fresh DNS lookup
    });

    clearTimeout(timeoutId);

    // 2xx, 3xx, 4xx are all "success" for DNS purposes
    // Only 5xx or network errors indicate DNS/connection issues
    return response.ok || response.status < 500;
  } catch {
    // DNS resolution failed or timed out
    return false;
  }
}

export const openExternal = async (url: string): Promise<void> => {
  const normalizedUrl = normalizeExternalUrl(url);

  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      // Extract hostname for DNS operations
      const hostname = new URL(normalizedUrl).hostname;

      // Step 1: Attempt to flush system DNS cache (best-effort, may fail silently)
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('flush_dns_cache');
      } catch {
        // Ignore flush failures - not all systems support this
      }

      // Step 2: Pre-warm DNS by verifying resolution
      // This ensures both system and browser DNS caches are populated
      await verifyDnsResolution(hostname);

      // Step 3: Open URL via system shell
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(normalizedUrl);
      return;
    } catch {
      // Fall through to window.open
    }
  }

  // Fallback for web context or if Tauri fails
  window.open(normalizedUrl, '_blank', 'noopener,noreferrer');
};
