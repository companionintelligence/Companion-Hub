import { describe, expect, it } from 'vitest';
import { cidrConflictsWithAny, cidrOverlaps, normalizeIpv4Cidr, parseIpv4Cidr } from '../cidr-overlap';

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
});

function ipv4ToNumber(ip: string): number {
  const octets = ip.split('.').map((part) => Number.parseInt(part, 10));
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}
