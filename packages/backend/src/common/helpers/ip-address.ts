import { BlockList, isIP, SocketAddress } from 'node:net';
import os from 'node:os';

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

/**
 * Whether an address is one Tailscale hands to a tailnet node: 100.64.0.0/10 (RFC 6598 CGNAT) or the
 * tailnet's IPv6 prefix `fd7a:115c:a1e0::/48`. A subset of what {@link isPrivateOrLocalIp} admits, kept
 * apart so a route that must tell "a tailnet caller" from "a container on this host" can ask.
 */
export function isTailnetIp(ip: string | undefined | null): boolean {
  const normalized = normalizeIpLiteral(ip);
  if (!normalized || !isIP(normalized)) return false;
  if (normalized.includes(':')) return normalized.startsWith('fd7a:115c:a1e0:');
  const [a, b = -1] = normalized.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

export function isPrivateOrLocalIp(ip: string, options?: { includeUnspecified?: boolean }): boolean {
  const normalized = normalizeIpLiteral(ip);
  if (!normalized) return false;

  if (normalized === '::1' || normalized === '127.0.0.1') return true;
  // Validate before the prefix tests: `normalizeIpLiteral` hands back the raw string when it is not
  // an address, and `fdxyz` must not read as ULA on the strength of its first two characters.
  if (!isIP(normalized)) return false;
  if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

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

/**
 * Whether an address may be the target of a manual pool-peer probe.
 *
 * Deliberately NOT {@link isPrivateOrLocalIp}, which is the allowlist for `InternalNetworkGuard`
 * and whose question is "did this come from inside". That one answers true for `127.0.0.1`/`::1`
 * and for the whole of `169.254.0.0/16` — which contains the cloud metadata endpoint
 * `169.254.169.254`. Pooling with a peer over loopback or link-local is meaningless, so allowing
 * them buys nothing and turns an operator-authenticated route into a loopback/metadata prober whose
 * response timing distinguishes an open port from a closed one.
 *
 * Allowed: RFC1918, RFC6598 CGNAT (where Tailscale puts every tailnet node), and IPv6 ULA.
 * Refused: loopback, link-local (v4 and v6), the unspecified address, and everything public.
 */
export function isPoolProbeTarget(ip: string): boolean {
  const normalized = normalizeIpLiteral(ip);
  if (!normalized) return false;

  if (normalized === '::1' || normalized === '127.0.0.1' || normalized === '::') return false;
  if (normalized.startsWith('fe80:')) return false;
  // fc00::/7 — the IPv6 equivalent of RFC1918, and the only v6 range a LAN peer plausibly sits in.
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (!isIP(normalized)) return false;

  const parts = normalized.split('.').map(Number);
  // Any remaining IPv6 address is global unicast, so it is not a pool target.
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;

  const [a, b = -1] = parts;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** One subnet of this process's own network interfaces. */
export interface InterfaceSubnet {
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

/**
 * The subnets this process's own network interfaces sit on: in the Hub's container, exactly its Docker
 * networks (the Hub's own, and each app network it joins at runtime), so read on every call rather
 * than cached. Loopback and IPv6 link-local are left out: every interface carries an `fe80::/64`, and
 * it says nothing about which network a caller is on.
 *
 * ⚠ Run outside a container (a Hub started natively for development) this includes the host's LAN.
 */
export function ownInterfaceSubnets(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): InterfaceSubnet[] {
  const out: InterfaceSubnet[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal || !info.cidr) continue;
      const prefix = Number(info.cidr.split('/')[1]);
      if (!Number.isInteger(prefix)) continue;
      if (info.family === 'IPv6' && info.address.toLowerCase().startsWith('fe80:')) continue;
      out.push({ address: info.address, prefix, family: info.family === 'IPv6' ? 'ipv6' : 'ipv4' });
    }
  }
  return out;
}

/**
 * Whether `ip` is the gateway of one of `subnets` (by default this process's own): the first address of
 * the subnet, which Docker gives each network's gateway unless a network names one (none of the Hub's
 * do). Traffic from the gateway is the Docker host: a program on the Hub's machine reaching a published
 * port, or a tailnet device's connection that Tailscale's own firewall rules forwarded and masqueraded
 * on the way in, so it arrives without the device's address. Nothing tells the two apart.
 */
export function isOwnNetworkGateway(ip: string | undefined | null, subnets: InterfaceSubnet[] = ownInterfaceSubnets()): boolean {
  const normalized = normalizeIpLiteral(ip);
  if (!normalized || isIP(normalized) !== 4) return false;
  const value = ipv4ToNumber(normalized);
  return subnets.some((subnet) => {
    if (subnet.family !== 'ipv4' || subnet.prefix >= 31) return false;
    const mask = subnet.prefix === 0 ? 0 : (0xffffffff << (32 - subnet.prefix)) >>> 0;
    const network = (ipv4ToNumber(subnet.address) & mask) >>> 0;
    return value === network + 1;
  });
}

function ipv4ToNumber(ip: string): number {
  return ip.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

/**
 * Whether `ip` is loopback, or on one of `subnets` (by default this process's own,
 * {@link ownInterfaceSubnets}): a caller on the same Docker network as the Hub, or on the Hub's own
 * machine through the Docker gateway. A LAN device reaching a published port keeps its own address,
 * so it is on none of them.
 */
export function isOnOwnNetwork(ip: string | undefined | null, subnets: InterfaceSubnet[] = ownInterfaceSubnets()): boolean {
  const normalized = normalizeIpLiteral(ip);
  if (!normalized) return false;
  if (normalized === '::1' || normalized.startsWith('127.')) return true;
  const family = isIP(normalized);
  if (family === 0) return false;
  const list = new BlockList();
  for (const subnet of subnets) {
    try {
      list.addSubnet(subnet.address, subnet.prefix, subnet.family);
    } catch {
      // An interface Node reports with an address BlockList will not take holds no caller.
    }
  }
  return list.check(normalized, family === 6 ? 'ipv6' : 'ipv4');
}
