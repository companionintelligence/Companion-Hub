import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HUB_SESSION_REFRESH_AFTER_MS, getHubSessionIssuedAt, markHubSessionIssuedAt, setTauriSessionId } from './api-fetch';
import {
  HUB_SESSION_CHECK_INTERVAL_MS,
  isHubSessionRefreshDue,
  refreshHubSessionIfDue,
  setServerSessionRefreshRecommendedAt,
} from './hub-session-refresh';
import { sdkOk } from '@/tests/sdk-mock-helpers';

const { refreshSession, isTauriReleaseBuild, handleSessionExpired } = vi.hoisted(() => ({
  refreshSession: vi.fn(),
  isTauriReleaseBuild: vi.fn(() => true),
  handleSessionExpired: vi.fn(),
}));

vi.mock('@/api-client/sdk.gen', () => ({
  refreshSession,
}));

vi.mock('@/lib/tauri-hub-probe', () => ({
  isTauriReleaseBuild,
}));

vi.mock('@/lib/session-expired', () => ({
  handleSessionExpired,
}));

describe('hub-session-refresh', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    isTauriReleaseBuild.mockReturnValue(true);
    setTauriSessionId(null);
    setServerSessionRefreshRecommendedAt(null);
    handleSessionExpired.mockReset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    setTauriSessionId(null);
  });

  it('marks refresh as due when no issue timestamp exists', () => {
    localStorage.setItem('ci-hub-session', 'session-1');
    expect(isHubSessionRefreshDue()).toBe(true);
  });

  it('does not refresh before the 5-day threshold', () => {
    setTauriSessionId('session-1', Date.now());
    expect(isHubSessionRefreshDue()).toBe(false);
  });

  it('prefers server refresh hints when local issue time predates the hint', () => {
    const hintAt = Date.now() - 1_000;
    setTauriSessionId('session-1', hintAt - 10_000);
    setServerSessionRefreshRecommendedAt(hintAt);

    expect(isHubSessionRefreshDue()).toBe(true);
  });

  it('ignores stale server refresh hints after a local session rotation', () => {
    setServerSessionRefreshRecommendedAt(Date.now() - 1_000);
    setTauriSessionId('session-1', Date.now());

    expect(isHubSessionRefreshDue()).toBe(false);
  });

  it('refreshes due sessions and stores the rotated session id', async () => {
    setTauriSessionId('session-old', Date.now() - HUB_SESSION_REFRESH_AFTER_MS - 1_000);

    refreshSession.mockResolvedValue(sdkOk({ sessionId: 'session-new', issuedAt: 1_700_000_000_000 }));

    await expect(refreshHubSessionIfDue()).resolves.toBe(true);
    expect(localStorage.getItem('ci-hub-session')).toBe('session-new');
    expect(getHubSessionIssuedAt()).toBe(1_700_000_000_000);
  });

  it('checks every six hours by default', () => {
    expect(HUB_SESSION_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('updates issue time for browser sessions without replacing a tauri token', async () => {
    isTauriReleaseBuild.mockReturnValue(false);
    markHubSessionIssuedAt(Date.now() - HUB_SESSION_REFRESH_AFTER_MS - 1_000);

    refreshSession.mockResolvedValue(sdkOk({ sessionId: 'ignored-for-browser', issuedAt: 1_700_000_111_000 }));

    await expect(refreshHubSessionIfDue()).resolves.toBe(true);
    expect(getHubSessionIssuedAt()).toBe(1_700_000_111_000);
    expect(localStorage.getItem('ci-hub-session')).toBeNull();
  });

  it('handles expired sessions on refresh 401', async () => {
    setTauriSessionId('session-old', Date.now() - HUB_SESSION_REFRESH_AFTER_MS - 1_000);

    refreshSession.mockResolvedValue({
      data: undefined,
      response: new Response(null, { status: 401 }),
      error: new Error('HTTP 401'),
    });

    await expect(refreshHubSessionIfDue()).resolves.toBe(false);
    expect(handleSessionExpired).toHaveBeenCalledOnce();
  });
});
