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
    const retry = document.querySelector('[data-testid="mobile-load-retry"]') as HTMLButtonElement;
    expect(retry).toBeTruthy();
    expect(retry.style.backgroundColor).toBe('var(--primary)');
    expect(retry.style.color).toBe('var(--primary-foreground)');
    expect(document.querySelector('[data-testid="mobile-load-switch-hub"]')).toBeTruthy();
    const hint = overlay?.querySelector('p:nth-of-type(2)') as HTMLElement;
    const switchHub = document.querySelector('[data-testid="mobile-load-switch-hub"]') as HTMLElement;
    expect(overlay?.style.background).toBe('var(--background)');
    expect(hint.style.color).toBe('var(--muted-foreground)');
    expect(switchHub.style.color).toBe('var(--muted-foreground)');
    expect(hint.style.color).not.toBe('#52525b');
  });

  it('does not cover a dashboard that is already up just because a spinner is on screen', () => {
    document.body.innerHTML = '<main id="root"><header data-testid="app-header"></header><div class="animate-spin"></div></main>';
    installMobileLoadWatchdog();
    vi.advanceTimersByTime(12_000);
    expect(document.getElementById('ci-hub-mobile-load-error')).toBeNull();
  });

  it('stops watching after the first successful paint', () => {
    document.body.innerHTML = '<main id="root"><header data-testid="app-header">Home</header></main>';
    installMobileLoadWatchdog();
    vi.advanceTimersByTime(6_000);
    document.body.innerHTML = '<main id="root"><p>Loading…</p><div class="animate-spin"></div></main>';
    vi.advanceTimersByTime(6_000);
    expect(document.getElementById('ci-hub-mobile-load-error')).toBeNull();
  });

  it('does not overlay a real login form', () => {
    document.body.innerHTML = '<main id="root"><form><input type="email" /></form></main>';
    installMobileLoadWatchdog();
    vi.advanceTimersByTime(12_000);
    expect(document.getElementById('ci-hub-mobile-load-error')).toBeNull();
  });
});
