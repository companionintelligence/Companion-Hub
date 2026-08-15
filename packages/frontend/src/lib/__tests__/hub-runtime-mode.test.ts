import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getHubRuntimeMode, mayHoldCookielessSession, usesCrossOriginDesktopApi, usesSameOriginHubApi } from '@/lib/hub-runtime-mode';
import { resetMobileClientCacheForTests } from '@/lib/mobile-connection';

describe('hub-runtime-mode', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    resetMobileClientCacheForTests();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
    });
  });

  it('returns browser without tauri internals', () => {
    expect(getHubRuntimeMode()).toBe('browser');
    expect(usesCrossOriginDesktopApi()).toBe(false);
    expect(usesSameOriginHubApi()).toBe(true);
    // `/auth/login` sets the cookie on the same response whose body the login page
    // stores, so a browser's stored session id is a duplicate and never needs to
    // travel in a URL. Keeps a live credential out of access logs.
    expect(mayHoldCookielessSession()).toBe(false);
  });

  it('returns desktop-same-origin for tauri loading the local stack UI', () => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = { invoke: vi.fn() };
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, origin: 'http://127.0.0.1:5002', protocol: 'http:', hostname: '127.0.0.1', port: '5002' },
    });

    expect(getHubRuntimeMode()).toBe('desktop-same-origin');
    expect(usesCrossOriginDesktopApi()).toBe(false);
    expect(usesSameOriginHubApi()).toBe(true);
    // The regression this predicate exists for: same-origin, so the old cross-origin
    // gate excluded it, yet the portal SSO handoff leaves it with no session cookie.
    expect(mayHoldCookielessSession()).toBe(true);
  });

  it('returns mobile-remote for Tauri iOS even when the vite devUrl is localhost', () => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = { invoke: vi.fn() };
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, origin: 'http://localhost:5005', protocol: 'http:', hostname: 'localhost', port: '5005' },
    });

    expect(getHubRuntimeMode()).toBe('mobile-remote');
    expect(usesCrossOriginDesktopApi()).toBe(true);
    expect(usesSameOriginHubApi()).toBe(false);
  });

  it('returns desktop-embedded for tauri bootstrap on tauri://', () => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = { invoke: vi.fn() };
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, origin: 'tauri://localhost', protocol: 'tauri:', hostname: 'localhost', port: '', pathname: '/' },
    });

    expect(getHubRuntimeMode()).toBe('desktop-embedded');
    expect(usesCrossOriginDesktopApi()).toBe(true);
    expect(usesSameOriginHubApi()).toBe(false);
    expect(mayHoldCookielessSession()).toBe(true);
  });
});
