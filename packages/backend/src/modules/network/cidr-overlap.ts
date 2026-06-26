/** Parse an IPv4 CIDR into numeric start/end (inclusive). Returns null when invalid. */
export function ipv4CidrRange(cidr: string): { start: number; end: number } | null {
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

  return { start, end };
}

export function cidrOverlaps(left: string, right: string): boolean {
  const leftRange = ipv4CidrRange(left);
  const rightRange = ipv4CidrRange(right);
  if (!leftRange || !rightRange) {
    return false;
  }
  return leftRange.start <= rightRange.end && rightRange.start <= leftRange.end;
}

export function cidrConflictsWithAny(candidate: string, occupied: string[]): boolean {
  return occupied.some((other) => cidrOverlaps(candidate, other));
}
