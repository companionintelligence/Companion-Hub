import { retryDynamicImport } from '@/lib/chunk-load-error';

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

export const openExternal = async (url: string): Promise<boolean> => {
  const normalizedUrl = normalizeExternalUrl(url);

  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    let hostname = '';
    let shouldWarmDns = false;
    try {
      const parsedUrl = new URL(normalizedUrl);
      shouldWarmDns = (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') && Boolean(parsedUrl.hostname);
      hostname = parsedUrl.hostname;
    } catch {
      shouldWarmDns = false;
    }

    // OPEN FIRST, WARM DNS AFTER.
    //
    // The DNS pre-warm used to run BEFORE openUrl: a flush_dns_cache round trip
    // plus verifyDnsResolution, which carries its own 3000 ms abort timeout. So
    // on a slow or unresolvable host the user clicked a link and nothing at all
    // happened for up to three seconds, which reads as a dead button. Handing
    // the URL to the OS first costs nothing and makes the click feel instant.
    try {
      // retryDynamicImport, because a stale chunk hash here is not cosmetic.
      //
      // Sign-in shares this dependency without going through this function:
      // login-form calls openAuthSession, which on Android/desktop imports the
      // same @tauri-apps/plugin-opener. So a stale chunk hash here takes the
      // sign-in button and every external link out together, which is exactly
      // the reported pairing.
      const { openUrl } = await retryDynamicImport(() => import('@tauri-apps/plugin-opener'));
      await openUrl(normalizedUrl);
      if (shouldWarmDns) void warmDns(hostname);
      return true;
    } catch (error) {
      // DO NOT fall through to window.open here.
      //
      // window.open is inert in a wry webview, so falling through turned every
      // opener failure -- an ACL denial, a scope rejection, a missing plugin --
      // into a silent no-op with nothing in the console. That is what made a
      // broken link indistinguishable from a dead button.
      //
      // This LOGS rather than throws on purpose: openExternal has ~20 call sites,
      // most of them fire-and-forget `onClick={() => openExternal(url)}`, and
      // rejecting would turn each into an unhandled rejection. The defect being
      // fixed is that the failure was invisible, not that it failed to propagate.
      // The boolean return is for the handful of callers -- Tailscale connect
      // among them -- that show their own success/failure toast and need to know
      // which one actually happened rather than assuming success.
      console.error(`openExternal: the system opener refused ${normalizedUrl}`, error);
      return false;
    }
  }

  // Fallback for a real web context, where window.open actually works -- except
  // when a popup blocker steps in, most often because this call did not happen
  // synchronously inside the click handler. window.open reports that with a null
  // return rather than a throw, so it needs the same treatment.
  return window.open(normalizedUrl, '_blank', 'noopener,noreferrer') != null;
};

/** Best-effort DNS warm, after the URL is already on its way to the browser. */
async function warmDns(hostname: string): Promise<void> {
  try {
    const { invoke } = await retryDynamicImport(() => import('@tauri-apps/api/core'));
    await invoke('flush_dns_cache');
  } catch {
    // Not all systems support this.
  }
  try {
    await verifyDnsResolution(hostname);
  } catch {
    // Warming is advisory; the browser has the URL either way.
  }
}
