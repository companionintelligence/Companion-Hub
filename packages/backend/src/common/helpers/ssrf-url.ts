import { lookup } from 'node:dns/promises';
import { isLocalHostname, isPrivateOrLocalIp } from './ip-address';

async function assertResolvablePublicHost(hostname: string): Promise<void> {
  if (isLocalHostname(hostname) || isPrivateOrLocalIp(hostname, { includeUnspecified: true })) {
    throw new Error('URL host is not allowed');
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.some((r) => isPrivateOrLocalIp(r.address, { includeUnspecified: true }))) {
    throw new Error('URL host resolves to a private address');
  }
}

/** Reject outbound URLs that resolve to private/link-local addresses (SSRF). */
export async function assertSafeOutboundUrl(rawUrl: string, options?: { httpsOnly?: boolean }): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  const httpsOnly = options?.httpsOnly ?? false;
  if (httpsOnly) {
    if (parsed.protocol !== 'https:') {
      throw new Error('Only https URLs are allowed');
    }
  } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  await assertResolvablePublicHost(hostname);
  return parsed;
}

/** @deprecated Use assertSafeOutboundUrl with httpsOnly for stricter checks. */
export async function assertSafeOutboundHttpsUrl(rawUrl: string): Promise<URL> {
  return assertSafeOutboundUrl(rawUrl, { httpsOnly: true });
}
