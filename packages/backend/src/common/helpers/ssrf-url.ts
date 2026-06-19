import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function isPrivateOrLocalIp(ip: string): boolean {
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (!isIP(ip)) return false;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b = -1] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  return false;
}

async function assertResolvablePublicHost(hostname: string): Promise<void> {
  if (isPrivateOrLocalIp(hostname)) {
    throw new Error('URL host is not allowed');
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.some((r) => isPrivateOrLocalIp(r.address))) {
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
