import { describe, expect, it } from 'vitest';
import { storeMediaHeaders } from '../store-media-headers';

describe('storeMediaHeaders', () => {
  it('keeps an image or video type, without its parameters', () => {
    expect(storeMediaHeaders('image/PNG', 'image/jpeg')['Content-Type']).toBe('image/png');
    expect(storeMediaHeaders('image/svg+xml; charset=utf-8', 'image/jpeg')['Content-Type']).toBe('image/svg+xml');
    expect(storeMediaHeaders('video/webm', 'video/mp4')['Content-Type']).toBe('video/webm');
  });

  it('falls back when there is no type, and serves anything a browser would render as bytes', () => {
    expect(storeMediaHeaders(undefined, 'image/jpeg')['Content-Type']).toBe('image/jpeg');
    expect(storeMediaHeaders('', 'video/mp4')['Content-Type']).toBe('video/mp4');
    for (const type of ['text/html', 'application/xhtml+xml', 'text/xml', 'application/javascript', 'image/svg']) {
      expect(storeMediaHeaders(type, 'image/jpeg')['Content-Type'], type).toBe('application/octet-stream');
    }
  });

  it('always sandboxes and turns sniffing off', () => {
    const headers = storeMediaHeaders('image/svg+xml', 'image/jpeg');
    expect(headers['Content-Security-Policy']).toContain('sandbox');
    expect(headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });
});
