import { describe, expect, it } from 'vitest';
import { isPoolProbeTarget, isPrivateOrLocalIp, isTailnetIp } from '../ip-address';

describe('isTailnetIp', () => {
  it('knows the whole 100.64.0.0/10 range and nothing past its edges', () => {
    for (const ip of ['100.64.0.0', '100.64.0.1', '100.100.100.100', '100.127.255.255']) expect(isTailnetIp(ip)).toBe(true);
    for (const ip of ['100.63.255.255', '100.128.0.0', '100.0.0.1', '10.64.0.1', '101.64.0.1']) expect(isTailnetIp(ip)).toBe(false);
  });

  it("knows Tailscale's IPv6 prefix, and only that one", () => {
    expect(isTailnetIp('fd7a:115c:a1e0::1')).toBe(true);
    expect(isTailnetIp('fd7a:115c:a1e0:ab12:4843:cd96:6258:1f2b')).toBe(true);
    expect(isTailnetIp('FD7A:115C:A1E0::1')).toBe(true);
    expect(isTailnetIp('fd00::1')).toBe(false);
    expect(isTailnetIp('fd7a:115c:a1e1::1')).toBe(false);
    expect(isTailnetIp('fe80::1')).toBe(false);
  });

  it('reads an IPv4-mapped IPv6 address as the IPv4 address it wraps', () => {
    expect(isTailnetIp('::ffff:100.101.102.103')).toBe(true);
    expect(isTailnetIp('::ffff:172.18.0.5')).toBe(false);
  });

  it('is false for the addresses that are inside the appliance but not on the tailnet', () => {
    for (const ip of ['127.0.0.1', '::1', '172.18.0.5', '10.128.12.5', '192.168.1.25']) expect(isTailnetIp(ip)).toBe(false);
  });

  it('is false for anything that is not an address, whatever it starts with', () => {
    for (const ip of ['', '   ', 'unknown', 'fd7a:115c:a1e0:garbage', '100.64', '100.64.0.1.5', 'not-an-ip']) expect(isTailnetIp(ip)).toBe(false);
    expect(isTailnetIp(undefined)).toBe(false);
    expect(isTailnetIp(null)).toBe(false);
  });

  it('is a subset of what the appliance already counts as private', () => {
    for (const ip of ['100.64.0.1', '100.127.255.255', 'fd7a:115c:a1e0::1']) {
      expect(isTailnetIp(ip)).toBe(true);
      expect(isPrivateOrLocalIp(ip)).toBe(true);
    }
  });
});

describe('isPrivateOrLocalIp', () => {
  it('treats the Tailscale CGNAT range as internal', () => {
    expect(isPrivateOrLocalIp('100.64.0.1')).toBe(true);
    expect(isPrivateOrLocalIp('100.100.100.100')).toBe(true);
    expect(isPrivateOrLocalIp('100.127.255.255')).toBe(true);
    expect(isPrivateOrLocalIp('::ffff:100.90.1.2')).toBe(true);
  });

  it('does not widen past the /10 boundary', () => {
    expect(isPrivateOrLocalIp('100.63.255.255')).toBe(false);
    expect(isPrivateOrLocalIp('100.128.0.1')).toBe(false);
  });

  it('still classifies the pre-existing ranges', () => {
    expect(isPrivateOrLocalIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrLocalIp('10.1.2.3')).toBe(true);
    expect(isPrivateOrLocalIp('172.16.0.1')).toBe(true);
    expect(isPrivateOrLocalIp('192.168.1.1')).toBe(true);
    expect(isPrivateOrLocalIp('::1')).toBe(true);
    expect(isPrivateOrLocalIp('203.0.113.10')).toBe(false);
  });

  /**
   * The IPv6 private ranges are recognised by prefix, and `normalizeIpLiteral` returns the raw string
   * for anything `SocketAddress` cannot parse — so a non-address that happens to start with `fd`,
   * `fc` or `fe80:` must be rejected as not-an-address before the prefix is ever consulted.
   */
  it('recognises ULA and link-local, but only for a string that is an address', () => {
    expect(isPrivateOrLocalIp('fd00::1')).toBe(true);
    expect(isPrivateOrLocalIp('fc00::1')).toBe(true);
    expect(isPrivateOrLocalIp('fe80::1')).toBe(true);
    expect(isPrivateOrLocalIp('fdxyz')).toBe(false);
    expect(isPrivateOrLocalIp('fc-garbage')).toBe(false);
    expect(isPrivateOrLocalIp('fe80:zzz')).toBe(false);
    expect(isPrivateOrLocalIp('unknown')).toBe(false);
  });
});

describe('isPoolProbeTarget', () => {
  it('allows the ranges a pool peer can actually live in', () => {
    expect(isPoolProbeTarget('192.168.1.42')).toBe(true);
    expect(isPoolProbeTarget('10.1.2.3')).toBe(true);
    expect(isPoolProbeTarget('172.16.0.1')).toBe(true);
    expect(isPoolProbeTarget('172.31.255.255')).toBe(true);
    expect(isPoolProbeTarget('100.64.0.1')).toBe(true);
    expect(isPoolProbeTarget('fd00::1')).toBe(true);
  });

  it('refuses loopback and link-local, which isPrivateOrLocalIp allows', () => {
    // This is the whole reason it is a separate function. `InternalNetworkGuard` asks "did this come
    // from inside", and for that question loopback is a yes. Here the question is "may I send a
    // request there", and pooling with yourself over loopback is meaningless — while allowing it
    // turns an operator-authenticated route into a port scanner for the Hub's own host.
    expect(isPrivateOrLocalIp('127.0.0.1')).toBe(true);
    expect(isPoolProbeTarget('127.0.0.1')).toBe(false);
    expect(isPoolProbeTarget('::1')).toBe(false);
    expect(isPoolProbeTarget('fe80::1')).toBe(false);
  });

  it('refuses the cloud metadata endpoint, which sits inside 169.254.0.0/16', () => {
    expect(isPrivateOrLocalIp('169.254.169.254')).toBe(true);
    expect(isPoolProbeTarget('169.254.169.254')).toBe(false);
    expect(isPoolProbeTarget('169.254.1.1')).toBe(false);
  });

  it('refuses the unspecified address and everything public', () => {
    expect(isPoolProbeTarget('0.0.0.0')).toBe(false);
    expect(isPoolProbeTarget('::')).toBe(false);
    expect(isPoolProbeTarget('203.0.113.10')).toBe(false);
    expect(isPoolProbeTarget('8.8.8.8')).toBe(false);
    expect(isPoolProbeTarget('2606:4700::1111')).toBe(false);
    expect(isPoolProbeTarget('not-an-ip')).toBe(false);
  });

  it('does not widen past the CGNAT /10 boundary', () => {
    expect(isPoolProbeTarget('100.63.255.255')).toBe(false);
    expect(isPoolProbeTarget('100.128.0.1')).toBe(false);
  });
});
