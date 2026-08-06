import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getHubRuntimeMode, usesCrossOriginDesktopApi, usesSameOriginHubApi } from '@/lib/hub-runtime-mode';

describe('hub-runtime-mode', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('returns browser without tauri internals', () => {
    expect(getHubRuntimeMode()).toBe('browser');
    expect(usesCrossOriginDesktopApi()).toBe(false);
    expect(usesSameOriginHubApi()).toBe(true);
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
  });
});
