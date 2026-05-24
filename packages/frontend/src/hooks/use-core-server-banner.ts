import { useCallback, useState } from 'react';

const DISMISSED_KEY = 'ci-hub-core-server-banner-dismissed';

export interface UseCoreServerBannerResult {
  isDismissed: boolean;
  dismiss: () => void;
}

export function useCoreServerBanner(): UseCoreServerBannerResult {
  const [isDismissed, setIsDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      // Ignore storage errors
    }
    setIsDismissed(true);
  }, []);

  return { isDismissed, dismiss };
}
