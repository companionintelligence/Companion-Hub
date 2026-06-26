import { describe, expect, it } from 'vitest';
import { cidrConflictsWithAny, cidrOverlaps, ipv4CidrRange } from '../cidr-overlap';

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

  it('parses canonical /24 bounds', () => {
    expect(ipv4CidrRange('10.128.10.0/24')).toEqual({
      start: ipv4ToNumber('10.128.10.0'),
      end: ipv4ToNumber('10.128.10.255'),
    });
  });

  it('reports conflicts against occupied ranges', () => {
    expect(cidrConflictsWithAny('10.128.10.0/24', ['10.128.10.0/24', '10.128.11.0/24'])).toBe(true);
    expect(cidrConflictsWithAny('10.128.12.0/24', ['10.128.10.0/24', '10.128.11.0/24'])).toBe(false);
  });
});

function ipv4ToNumber(ip: string): number {
  const octets = ip.split('.').map((part) => Number.parseInt(part, 10));
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}
