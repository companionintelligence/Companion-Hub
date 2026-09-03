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
 * Note: In Tauri/webview context, CORS errors indicate DNS resolved successfully
 * (we reached the server, but it blocked the request).
 *
 * @param hostname - The hostname to verify (e.g., "example.com")
 * @param timeoutMs - Maximum time to wait for DNS resolution (default: 3000ms)
 * @returns true if DNS resolves successfully, false otherwise
 */
async function verifyDnsResolution(hostname: string, timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Use a lightweight HEAD request to trigger DNS resolution
    await fetch(`https://${hostname}`, {
      method: 'HEAD',
      signal: controller.signal,
      cache: 'no-store', // Bypass fetch cache to force fresh DNS lookup
      mode: 'no-cors', // Prevent CORS errors from blocking DNS warmup
    });

    // If fetch succeeds, DNS definitely resolved
    return true;
  } catch (err) {
    // CORS errors, network errors, and timeouts all throw
    // We need to distinguish DNS failures from CORS blocks

    if (err instanceof Error) {
      // AbortError means we timed out - likely a DNS or network issue
      if (err.name === 'AbortError') {
        return false;
      }

      // TypeError with "Failed to fetch" often means DNS resolved but connection failed
      // or CORS blocked us - both indicate DNS worked
      if (err.name === 'TypeError') {
        // In no-cors mode, we won't get detailed error messages
        // Any TypeError in no-cors mode means we at least attempted the connection
        // which requires DNS to have resolved
        return true;
      }
    }

    // For any other error type, assume DNS may have failed
    return false;
  } finally {
    // Always clear timeout to prevent timer leaks
    clearTimeout(timeoutId);
  }
}

export const openExternal = async (url: string): Promise<void> => {
  const normalizedUrl = normalizeExternalUrl(url);

  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      // Only perform DNS operations for http/https URLs with a hostname
      let shouldWarmDns = false;
      let hostname = '';

      try {
        const parsedUrl = new URL(normalizedUrl);
        shouldWarmDns = (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') && Boolean(parsedUrl.hostname);
        hostname = parsedUrl.hostname;
      } catch {
        // Invalid URL or non-HTTP scheme (mailto:, etc.) - skip DNS operations
        shouldWarmDns = false;
      }

      if (shouldWarmDns) {
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
      }

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
