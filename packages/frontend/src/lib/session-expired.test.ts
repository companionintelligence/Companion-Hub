import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-fetch', () => ({ clearStaleTauriSession: vi.fn() }));

const { handleSessionExpired, holdPageOnSessionExpiry, isPageHeldOnSessionExpiry } = await import('./session-expired');
const { clearStaleTauriSession } = await import('@/lib/api-fetch');

describe('handleSessionExpired', () => {
  const originalLocation = window.location;
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, pathname: '/settings', assign } });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('sends the page to sign-in', async () => {
    await handleSessionExpired();

    expect(clearStaleTauriSession).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/login');
  });

  // A factory reset deletes every user and still has a toast or a warning to show (#2557).
  it('leaves a held page where it is until every hold is let go', async () => {
    const releaseFirst = holdPageOnSessionExpiry();
    const releaseSecond = holdPageOnSessionExpiry();
    expect(isPageHeldOnSessionExpiry()).toBe(true);

    await handleSessionExpired();
    releaseFirst();
    releaseFirst();
    await handleSessionExpired();

    expect(assign).not.toHaveBeenCalled();
    expect(isPageHeldOnSessionExpiry()).toBe(true);

    releaseSecond();
    expect(isPageHeldOnSessionExpiry()).toBe(false);
    await handleSessionExpired();

    expect(assign).toHaveBeenCalledWith('/login');
  });
});
