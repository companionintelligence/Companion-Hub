import { describe, expect, it } from 'vitest';
import { assertSafeOutboundHttpsUrl, assertSafeOutboundUrl } from '../ssrf-url';

describe('ssrf-url', () => {
  it('rejects localhost https URLs', async () => {
    await expect(assertSafeOutboundHttpsUrl('https://127.0.0.1/')).rejects.toThrow(/not allowed/i);
  });

  it('rejects non-https URLs when httpsOnly', async () => {
    await expect(assertSafeOutboundUrl('http://example.com/', { httpsOnly: true })).rejects.toThrow(/https/i);
  });

  it('allows public https URLs', async () => {
    const url = await assertSafeOutboundHttpsUrl('https://example.com/');
    expect(url.hostname).toBe('example.com');
  });
});
