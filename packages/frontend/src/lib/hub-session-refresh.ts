import {
  apiFetch,
  getHubSessionIssuedAt,
  getTauriSessionId,
  HUB_SESSION_REFRESH_AFTER_MS,
  markHubSessionIssuedAt,
  setTauriSessionId,
} from '@/lib/api-fetch';
import { handleSessionExpired } from '@/lib/session-expired';
import { isTauriReleaseBuild } from '@/lib/tauri-hub-probe';

export const HUB_SESSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let refreshInFlight: Promise<boolean> | null = null;

export function isHubSessionRefreshDue(): boolean {
  const issuedAt = getHubSessionIssuedAt();
  if (!issuedAt) {
    // Legacy sessions created before we tracked issue time — refresh once.
    return true;
  }

  return Date.now() - issuedAt >= HUB_SESSION_REFRESH_AFTER_MS;
}

function canAttemptHubSessionRefresh(): boolean {
  if (isTauriReleaseBuild()) {
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
  if (!canAttemptHubSessionRefresh() || !isHubSessionRefreshDue()) {
    return false;
  }

  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    try {
      const res = await apiFetch('/api/auth/session/refresh', { method: 'POST' });
      if (res.status === 401) {
        await handleSessionExpired();
        return false;
      }
      if (!res.ok) {
        return false;
      }

      const data = (await res.json()) as { sessionId?: string; issuedAt?: number };
      if (data.sessionId && isTauriReleaseBuild()) {
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
