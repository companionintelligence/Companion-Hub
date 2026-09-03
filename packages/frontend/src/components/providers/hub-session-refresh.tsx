import { useUserContext } from '@/context/user-context';
import { bindSessionExpiredQueryClient } from '@/lib/session-expired';
import { HUB_SESSION_CHECK_INTERVAL_MS, refreshHubSessionIfDue, setServerSessionRefreshRecommendedAt } from '@/lib/hub-session-refresh';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/** Keeps long-lived hub sessions fresh by rotating them before the 7-day TTL expires. */
export function HubSessionRefresh() {
  const { isLoggedIn, sessionRefreshRecommendedAt } = useUserContext();
  const queryClient = useQueryClient();

  useEffect(() => {
    bindSessionExpiredQueryClient(queryClient);
  }, [queryClient]);

  useEffect(() => {
    setServerSessionRefreshRecommendedAt(sessionRefreshRecommendedAt ?? null);
  }, [sessionRefreshRecommendedAt]);

  useEffect(() => {
    if (!isLoggedIn) {
      return;
    }

    const runRefresh = () => {
      void refreshHubSessionIfDue();
    };

    runRefresh();

    const intervalId = window.setInterval(runRefresh, HUB_SESSION_CHECK_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runRefresh();
      }
    };
    const onPageShow = () => {
      runRefresh();
    };
    const onFocus = () => {
      runRefresh();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onFocus);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onFocus);
    };
  }, [isLoggedIn]);

  return null;
}
