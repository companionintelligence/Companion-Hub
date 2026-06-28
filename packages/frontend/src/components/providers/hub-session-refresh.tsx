import { useUserContext } from '@/context/user-context';
import { HUB_SESSION_CHECK_INTERVAL_MS, refreshHubSessionIfDue } from '@/lib/hub-session-refresh';
import { useEffect } from 'react';

/** Keeps long-lived hub sessions fresh by rotating them before the 7-day TTL expires. */
export function HubSessionRefresh() {
  const { isLoggedIn } = useUserContext();

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

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [isLoggedIn]);

  return null;
}
