import { describe, expect, it } from 'vitest';
import { assertSafeOutboundHttpsUrl, assertSafeOutboundUrl } from '../ssrf-url';

describe('ssrf-url', () => {
  it('rejects localhost https URLs', async () => {
    await expect(assertSafeOutboundHttpsUrl('https://127.0.0.1/')).rejects.toThrow(/not allowed/i);
  });

  it('rejects localhost hostnames', async () => {
    await expect(assertSafeOutboundHttpsUrl('https://localhost/')).rejects.toThrow(/not allowed/i);
    await expect(assertSafeOutboundHttpsUrl('https://localhost./')).rejects.toThrow(/not allowed/i);
  });

  it('rejects IPv6 loopback URLs', async () => {
    await expect(assertSafeOutboundHttpsUrl('https://[::1]/')).rejects.toThrow(/not allowed/i);
    await expect(assertSafeOutboundHttpsUrl('https://[0:0:0:0:0:0:0:1]/')).rejects.toThrow(/not allowed/i);
  });

  it('rejects IPv6-mapped localhost and private IPv4 URLs', async () => {
    const blockedUrls = [
      'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:10.0.0.7]/',
      'https://[::ffff:192.168.1.9]/',
      'https://[::ffff:172.16.4.2]/',
    ];

    await Promise.all(
      blockedUrls.map(async (url) => {
        await expect(assertSafeOutboundHttpsUrl(url)).rejects.toThrow(/not allowed/i);
      }),
    );
  });

  it('rejects non-https URLs when httpsOnly', async () => {
    await expect(assertSafeOutboundUrl('http://example.com/', { httpsOnly: true })).rejects.toThrow(/https/i);
  });

  it('allows public https URLs', async () => {
    const url = await assertSafeOutboundHttpsUrl('https://example.com/');
    expect(url.hostname).toBe('example.com');
  });
});
