import { describe, expect, it } from 'vitest';
import { isPoolProbeTarget, isPrivateOrLocalIp } from '../ip-address';

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
