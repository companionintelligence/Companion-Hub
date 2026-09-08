import { afterEach, describe, expect, it } from 'vitest';
import { resolveAllowedCorsOrigin } from '../cors-origin';

describe('resolveAllowedCorsOrigin', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('allows the Tauri webview origins', () => {
    for (const origin of ['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost']) {
      expect(resolveAllowedCorsOrigin(origin)).toBe(origin);
    }
  });

  /*
   * ⚠ ANY LOOPBACK PORT USED TO BE REFLECTED, WITH `credentials: true`. Every
   * installed app that publishes a host port serves a page on
   * `http://localhost:<its port>`, so its own web UI — or anything it renders,
   * or anything that can reach that port — could make credentialed
   * cross-origin requests to this API and read the responses. The operator's
   * session cookie travels, and the whole `AuthGuard` surface answers.
   */
  it('refuses a loopback origin that is not a Hub port', () => {
    process.env.NODE_ENV = 'production';
    process.env.API_PORT = '3000';

    expect(resolveAllowedCorsOrigin('http://localhost:8080')).toBe(false);
    expect(resolveAllowedCorsOrigin('http://127.0.0.1:9000')).toBe(false);
    expect(resolveAllowedCorsOrigin('http://localhost:5173')).toBe(false);
  });

  it('allows the Hub API port, and the dev server outside production', () => {
    process.env.API_PORT = '3000';

    process.env.NODE_ENV = 'production';
    expect(resolveAllowedCorsOrigin('http://localhost:3000')).toBe('http://localhost:3000');

    process.env.NODE_ENV = 'development';
    expect(resolveAllowedCorsOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('allows an operator-declared extra origin, exactly', () => {
    process.env.CI_HUB_EXTRA_CORS_ORIGINS = 'https://hub.example.test, https://other.example.test';

    expect(resolveAllowedCorsOrigin('https://hub.example.test')).toBe('https://hub.example.test');
    // Exact match only — no prefix or suffix games.
    expect(resolveAllowedCorsOrigin('https://hub.example.test.evil.test')).toBe(false);
    expect(resolveAllowedCorsOrigin('https://evil.test')).toBe(false);
  });

  it('refuses an unknown origin', () => {
    expect(resolveAllowedCorsOrigin('https://evil.example')).toBe(false);
  });
});
