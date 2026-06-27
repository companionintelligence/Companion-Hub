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

import { HUB_APP_ALLOCATION_END_CIDR, HUB_APP_ALLOCATION_START_CIDR } from './network-constants';

const HUB_ALLOCATABLE_START = parseIpv4Cidr(HUB_APP_ALLOCATION_START_CIDR)?.start;
const HUB_ALLOCATABLE_END = parseIpv4Cidr(HUB_APP_ALLOCATION_END_CIDR)?.end;

/**
 * Hub-managed /24 octet pairs (10.{128-254}.{0-254}.0/24, minus 10.128.0–9) whose ranges
 * intersect [occStart, occEnd]. O(|overlapping /24s|) instead of scanning the full pool.
 */
export function hubManagedOctetPairsOverlappingRange(occStart: number, occEnd: number): string[] {
  if (HUB_ALLOCATABLE_START === undefined || HUB_ALLOCATABLE_END === undefined) {
    return [];
  }

  const overlapStart = Math.max(occStart, HUB_ALLOCATABLE_START);
  const overlapEnd = Math.min(occEnd, HUB_ALLOCATABLE_END);
  if (overlapStart > overlapEnd) {
    return [];
  }

  const pairs: string[] = [];
  let blockStart = overlapStart & 0xffffff00;

  while (blockStart <= overlapEnd) {
    const blockEnd = blockStart + 255;
    if (blockStart <= occEnd && occStart <= blockEnd) {
      const secondOctet = (blockStart >>> 16) & 255;
      const thirdOctet = (blockStart >>> 8) & 255;
      if (isHubManagedOctetPair(secondOctet, thirdOctet)) {
        pairs.push(`${secondOctet}.${thirdOctet}`);
      }
    }
    blockStart += 256;
  }

  return pairs;
}

function isHubManagedOctetPair(secondOctet: number, thirdOctet: number): boolean {
  if (secondOctet < 128 || secondOctet > 254 || thirdOctet > 254) {
    return false;
  }
  if (secondOctet === 128 && thirdOctet <= 9) {
    return false;
  }
  return true;
}

export function rangesOverlap(left: ParsedIpv4Cidr, right: ParsedIpv4Cidr): boolean {
  return left.start <= right.end && right.start <= left.end;
}
