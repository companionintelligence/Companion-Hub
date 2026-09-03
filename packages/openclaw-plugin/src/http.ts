/** Default per-request timeout so a hung/half-open Hub connection can't wedge the plugin. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * fetch with a hard timeout via AbortController so a hung/half-open connection can't block a call
 * indefinitely. The timer is always cleared. Shared by the plugin's Hub metadata calls (e.g. the
 * health probe in index.ts). NOTE: the timeout spans the request up to response headers, not the
 * full body read — callers that stream a body should guard that separately.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
