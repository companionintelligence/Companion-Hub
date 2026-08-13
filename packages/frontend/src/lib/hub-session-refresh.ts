import { getHubSessionIssuedAt, getTauriSessionId, HUB_SESSION_REFRESH_AFTER_MS, markHubSessionIssuedAt, setTauriSessionId } from '@/lib/api-fetch';
import { refreshSession } from '@/api-client/sdk.gen';
import { sdkResult } from '@/lib/sdk-unwrap';
import { handleSessionExpired } from '@/lib/session-expired';
import { usesCrossOriginDesktopApi } from '@/lib/hub-runtime-mode';

export const HUB_SESSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let refreshInFlight: Promise<boolean> | null = null;
let serverSessionRefreshRecommendedAt: number | null = null;

/** Prefer authoritative server hints from `/api/user-context` when available. */
export function setServerSessionRefreshRecommendedAt(recommendedAt: number | null): void {
  serverSessionRefreshRecommendedAt = recommendedAt ?? null;
}

export function isHubSessionRefreshDue(): boolean {
  const issuedAt = getHubSessionIssuedAt();

  if (serverSessionRefreshRecommendedAt && Date.now() >= serverSessionRefreshRecommendedAt) {
    if (!issuedAt || issuedAt <= serverSessionRefreshRecommendedAt) {
      return true;
    }
  }

  if (!issuedAt) {
    // Portal SSO (and other cookie-only logins) never write issued-at. Rotating on
    // first paint used to delete the cookie's session while install still sent the
    // previous header id — a 401 that looked like "not logged in yet".
    return false;
  }

  return Date.now() - issuedAt >= HUB_SESSION_REFRESH_AFTER_MS;
}

function canAttemptHubSessionRefresh(): boolean {
  if (usesCrossOriginDesktopApi()) {
    return Boolean(getTauriSessionId());
  }

  // Browser Hub uses the session cookie; refresh is cookie-driven.
  return true;
}

/**
 * Rotate the hub session when it is approaching expiry. Safe to call repeatedly —
 * concurrent callers share one in-flight request.
 */
export async function refreshHubSessionIfDue(): Promise<boolean> {
  if (!canAttemptHubSessionRefresh()) {
    return false;
  }

  if (!isHubSessionRefreshDue()) {
    if (!getHubSessionIssuedAt()) {
      markHubSessionIssuedAt();
    }
    return false;
  }

  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    try {
      const result = await sdkResult(refreshSession());
      if (result.status === 401) {
        await handleSessionExpired();
        return false;
      }
      if (!result.ok) {
        return false;
      }

      const data = (result.data ?? {}) as { sessionId?: string; issuedAt?: number };
      if (data.sessionId && usesCrossOriginDesktopApi()) {
        setTauriSessionId(data.sessionId, data.issuedAt);
      } else {
        markHubSessionIssuedAt(data.issuedAt ?? Date.now());
      }

      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}
