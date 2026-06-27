export interface ParsedIpv4Cidr {
  /** Canonical network address + prefix, e.g. 10.128.10.0/24 */
  normalized: string;
  start: number;
  end: number;
  prefix: number;
}

function numberToIpv4(value: number): string {
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

/** Parse an IPv4 CIDR into numeric start/end (inclusive). Returns null when invalid. */
export function parseIpv4Cidr(cidr: string): ParsedIpv4Cidr | null {
  const trimmed = cidr.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0) {
    return null;
  }

  const ip = trimmed.slice(0, slash);
  const prefix = Number.parseInt(trimmed.slice(slash + 1), 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return null;
  }

  const octets = ip.split('.');
  if (octets.length !== 4) {
    return null;
  }

  let network = 0;
  for (const octet of octets) {
    const value = Number.parseInt(octet, 10);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    network = (network << 8) | value;
  }
  network >>>= 0;

  const hostBits = 32 - prefix;
  const mask = hostBits === 32 ? 0 : (~0 << hostBits) >>> 0;
  const start = (network & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;

  return {
    normalized: `${numberToIpv4(start)}/${prefix}`,
    start,
    end,
    prefix,
  };
}

/** @deprecated Use parseIpv4Cidr().start/end */
export function ipv4CidrRange(cidr: string): { start: number; end: number } | null {
  const parsed = parseIpv4Cidr(cidr);
  if (!parsed) {
    return null;
  }
  return { start: parsed.start, end: parsed.end };
}

/** Normalize Docker/DB variants (e.g. 10.128.10.1/24) to canonical network CIDRs. */
export function normalizeIpv4Cidr(cidr: string): string | null {
  return parseIpv4Cidr(cidr)?.normalized ?? null;
}

export function cidrOverlaps(left: string, right: string): boolean {
  const leftRange = parseIpv4Cidr(left);
  const rightRange = parseIpv4Cidr(right);
  if (!leftRange || !rightRange) {
    return false;
  }
  return leftRange.start <= rightRange.end && rightRange.start <= leftRange.end;
}

export function cidrConflictsWithAny(candidate: string, occupied: string[]): boolean {
  return occupied.some((other) => cidrOverlaps(candidate, other));
}

export function rangesOverlap(left: ParsedIpv4Cidr, right: ParsedIpv4Cidr): boolean {
  return left.start <= right.end && right.start <= left.end;
}
