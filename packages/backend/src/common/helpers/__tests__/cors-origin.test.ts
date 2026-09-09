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
    expect(resolveAllowedCorsOrigin('http://localhost:5005')).toBe(false);
  });

  it('falls back to the same API port as main.ts when API_PORT is unset', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.API_PORT;

    expect(resolveAllowedCorsOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('allows the Hub API port, and the dev server outside production', () => {
    process.env.API_PORT = '5004';
    // The Vite dev server reads FRONTEND_PORT (default 5005) — see
    // packages/frontend/vite.config.ts and the desktop `devUrl`.
    process.env.FRONTEND_PORT = '5005';

    process.env.NODE_ENV = 'production';
    expect(resolveAllowedCorsOrigin('http://localhost:5004')).toBe('http://localhost:5004');
    expect(resolveAllowedCorsOrigin('http://localhost:5005')).toBe(false);

    process.env.NODE_ENV = 'development';
    expect(resolveAllowedCorsOrigin('http://localhost:5005')).toBe('http://localhost:5005');
  });

  it('allows an operator-declared extra origin, exactly', () => {
    process.env.CI_HUB_EXTRA_CORS_ORIGINS = 'https://hub.example.test, https://other.example.test';

    expect(resolveAllowedCorsOrigin('https://hub.example.test')).toBe('https://hub.example.test');
    // Exact match only — no prefix or suffix games.
    expect(resolveAllowedCorsOrigin('https://hub.example.test.evil.test')).toBe(false);
    expect(resolveAllowedCorsOrigin('https://evil.test')).toBe(false);
  });

  /*
   * The compose file pins the container's `API_PORT` to 5002 while publishing it
   * on the host as `${API_PORT:-5002}`, so an operator who moves the published
   * port has no other way to name the origin they actually browse to. An escape
   * hatch checked after the loopback narrowing could never express it.
   */
  it('lets the extra-origins list name a loopback origin the Hub is published on', () => {
    process.env.NODE_ENV = 'production';
    process.env.API_PORT = '5002';
    process.env.CI_HUB_EXTRA_CORS_ORIGINS = 'http://localhost:8123';

    expect(resolveAllowedCorsOrigin('http://localhost:8123')).toBe('http://localhost:8123');
    expect(resolveAllowedCorsOrigin('http://localhost:8124')).toBe(false);
  });

  it('refuses an unknown origin', () => {
    expect(resolveAllowedCorsOrigin('https://evil.example')).toBe(false);
  });
});
