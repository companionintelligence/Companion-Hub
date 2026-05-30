/**
 * Hostname suitable for URLs opened in the user's browser.
 * INTERNAL_IP is often 0.0.0.0 (listen-all) which browsers cannot connect to.
 */
export function resolveBrowserHost(internalIp?: string | null): string {
  const trimmed = internalIp?.trim();
  if (!trimmed || trimmed === '0.0.0.0' || trimmed === '::') {
    return '127.0.0.1';
  }
  return trimmed;
}
