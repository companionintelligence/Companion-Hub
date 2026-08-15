import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMobileLoadWatchdog } from './mobile-load-watchdog';

const { mockIsMobile, mockClearHub } = vi.hoisted(() => ({
  mockIsMobile: vi.fn(() => true),
  mockClearHub: vi.fn(async () => {}),
}));

vi.mock('@/lib/mobile-connection', () => ({
  isMobileClient: () => mockIsMobile(),
  usesCloudConnect: () => mockIsMobile(),
  clearHubConnection: () => mockClearHub(),
}));

describe('installMobileLoadWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockIsMobile.mockReturnValue(true);
    document.body.innerHTML = '<main id="root"><p>Loading…</p></main>';
    delete (window as Window & { __ciHubLoadWatchdog?: boolean }).__ciHubLoadWatchdog;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.getElementById('ci-hub-mobile-load-error')?.remove();
    delete (window as Window & { __ciHubLoadWatchdog?: boolean }).__ciHubLoadWatchdog;
  });

  it('replaces a stuck Loading screen with Retry and Switch Hub', () => {
    installMobileLoadWatchdog();
    expect(document.getElementById('ci-hub-mobile-load-error')).toBeNull();
    vi.advanceTimersByTime(6_000);
    const overlay = document.getElementById('ci-hub-mobile-load-error');
    expect(overlay).toBeTruthy();
    expect(overlay?.textContent).toContain("This Hub isn't responding.");
    expect(document.querySelector('[data-testid="mobile-load-retry"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="mobile-load-switch-hub"]')).toBeTruthy();
  });

  it('does not overlay a real login form', () => {
    document.body.innerHTML = '<main id="root"><form><input type="email" /></form></main>';
    installMobileLoadWatchdog();
    vi.advanceTimersByTime(12_000);
    expect(document.getElementById('ci-hub-mobile-load-error')).toBeNull();
  });
});
