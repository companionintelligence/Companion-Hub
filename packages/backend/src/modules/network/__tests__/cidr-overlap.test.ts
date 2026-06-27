import { describe, expect, it } from 'vitest';
import { cidrConflictsWithAny, cidrOverlaps, hubManagedOctetPairsOverlappingRange, normalizeIpv4Cidr, parseIpv4Cidr } from '../cidr-overlap';

describe('cidr-overlap', () => {
  it('detects identical /24 ranges as overlapping', () => {
    expect(cidrOverlaps('10.128.10.0/24', '10.128.10.0/24')).toBe(true);
  });

  it('detects overlapping ranges with different prefix lengths', () => {
    expect(cidrOverlaps('10.128.10.0/24', '10.128.10.128/25')).toBe(true);
    expect(cidrOverlaps('10.128.0.0/16', '10.128.10.0/24')).toBe(true);
  });

  it('treats non-overlapping ranges as available', () => {
    expect(cidrOverlaps('10.128.10.0/24', '10.128.11.0/24')).toBe(false);
  });

  it('normalizes Docker-style host-address CIDRs to network base', () => {
    expect(normalizeIpv4Cidr('10.128.10.1/24')).toBe('10.128.10.0/24');
    expect(normalizeIpv4Cidr('10.128.10.128/25')).toBe('10.128.10.128/25');
  });

  it('parses canonical /24 bounds', () => {
    expect(parseIpv4Cidr('10.128.10.0/24')).toEqual({
      normalized: '10.128.10.0/24',
      start: ipv4ToNumber('10.128.10.0'),
      end: ipv4ToNumber('10.128.10.255'),
      prefix: 24,
    });
  });

  it('reports conflicts against occupied ranges', () => {
    expect(cidrConflictsWithAny('10.128.10.0/24', ['10.128.10.0/24', '10.128.11.0/24'])).toBe(true);
    expect(cidrConflictsWithAny('10.128.12.0/24', ['10.128.10.0/24', '10.128.11.0/24'])).toBe(false);
  });

  it('treats normalized equivalents as overlapping', () => {
    expect(cidrOverlaps('10.128.10.1/24', '10.128.10.0/24')).toBe(true);
  });

  describe('hubManagedOctetPairsOverlappingRange', () => {
    it('returns a single pair for an overlapping /24', () => {
      const range = parseIpv4Cidr('10.128.15.0/24');
      expect(range).not.toBeNull();
      if (!range) return;
      expect(hubManagedOctetPairsOverlappingRange(range.start, range.end)).toEqual(['128.15']);
    });

    it('returns adjacent pairs for a /23 overlapping two Hub /24s', () => {
      const range = parseIpv4Cidr('10.128.10.0/23');
      expect(range).not.toBeNull();
      if (!range) return;
      expect(hubManagedOctetPairsOverlappingRange(range.start, range.end)).toEqual(['128.10', '128.11']);
    });

    it('blocks allocatable space covered by a /16 without scanning the full pool', () => {
      const range = parseIpv4Cidr('10.128.0.0/16');
      expect(range).not.toBeNull();
      if (!range) return;
      const pairs = hubManagedOctetPairsOverlappingRange(range.start, range.end);
      expect(pairs).toContain('128.10');
      expect(pairs).toContain('128.254');
      expect(pairs).not.toContain('128.9');
      expect(pairs).not.toContain('128.255');
      expect(pairs.length).toBe(245);
    });

    it('includes partial /20 overlaps at pool boundaries', () => {
      const range = parseIpv4Cidr('10.254.240.0/20');
      expect(range).not.toBeNull();
      if (!range) return;
      const pairs = hubManagedOctetPairsOverlappingRange(range.start, range.end);
      expect(pairs[0]).toBe('254.240');
      expect(pairs.at(-1)).toBe('254.254');
      expect(pairs.length).toBe(15);
    });

    it('returns nothing for ranges outside the Hub allocation space', () => {
      const range = parseIpv4Cidr('172.20.0.0/16');
      expect(range).not.toBeNull();
      if (!range) return;
      expect(hubManagedOctetPairsOverlappingRange(range.start, range.end)).toEqual([]);
    });
  });
});

function ipv4ToNumber(ip: string): number {
  const octets = ip.split('.').map((part) => Number.parseInt(part, 10));
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}
