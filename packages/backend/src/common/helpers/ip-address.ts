import { isIP, SocketAddress } from 'node:net';

export function normalizeIpLiteral(raw: string | undefined | null): string | null {
  if (!raw) return null;

  let trimmed = raw.trim();
  if (!trimmed) return null;

  const zoneIndex = trimmed.indexOf('%');
  if (zoneIndex !== -1) {
    trimmed = trimmed.slice(0, zoneIndex);
  }

  const parsed = SocketAddress.parse(trimmed.includes(':') ? `[${trimmed}]:0` : `${trimmed}:0`);
  const normalized = (parsed?.address ?? trimmed).toLowerCase();
  if (normalized === '0:0:0:0:0:0:0:1') return '::1';

  const ipv6MappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(normalized);
  const mappedAddress = ipv6MappedIpv4?.[1];
  if (mappedAddress) {
    return mappedAddress;
  }

  return normalized;
}

export function isLocalHostname(hostname: string): boolean {
  return hostname.trim().toLowerCase().replace(/\.+$/, '') === 'localhost';
}

export function isPrivateOrLocalIp(ip: string, options?: { includeUnspecified?: boolean }): boolean {
  const normalized = normalizeIpLiteral(ip);
  if (!normalized) return false;

  if (normalized === '::1' || normalized === '127.0.0.1') return true;
  if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (!isIP(normalized)) return false;

  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;

  const [a, b = -1] = parts;
  if (a === 0) return options?.includeUnspecified ?? false;
  if (a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 (RFC 6598 CGNAT) is where Tailscale puts every tailnet node, so a request from a
  // paired Hub is as internal as one from the Docker bridge — and, for outbound URLs, a tailnet
  // address is never a legitimate public target.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}
