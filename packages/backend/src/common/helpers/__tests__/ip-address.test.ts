import { describe, expect, it } from 'vitest';
import { isPrivateOrLocalIp } from '../ip-address';

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
